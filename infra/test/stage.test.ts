import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { type GedeStage } from '../lib/gede-stage.js';
import { DB_APP_USERNAME } from '../lib/stacks/data-stack.js';
import { RATE_LIMIT_PER_IP, WAF_MANAGED_RULE_GROUPS } from '../lib/stacks/edge-stack.js';
import { PURGE_SCHEDULE } from '../lib/stacks/ops-stack.js';
import { PURGE_COMMAND, gedeVersion } from '../lib/stacks/service-stack.js';
import {
  ORIGIN_VERIFY_GENERATIONS,
  ORIGIN_VERIFY_HEADER,
  ORIGIN_VERIFY_PRESENTED,
} from '../lib/stacks/web-stack.js';

const TEST_ZONE_ID = 'Z0000000000000000TEST';
const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Feature flags and defaults exactly as the CLI reads them, so tests synthesize what the pipeline does. */
function cdkJsonContext(): Record<string, unknown> {
  const cdkJson = JSON.parse(readFileSync(path.join(INFRA_ROOT, 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  };
  const cdkContextJson = JSON.parse(
    readFileSync(path.join(INFRA_ROOT, 'cdk.context.json'), 'utf8'),
  ) as Record<string, unknown>;
  return { ...cdkJson.context, ...cdkContextJson };
}

/** Find a stage stack by its `stackName` (e.g. `GeDe-Prod-Auth`). */
function stageStack(stage: cdk.Stage, name: string): cdk.Stack {
  const stack = stage.node.children.find(
    (child): child is cdk.Stack => cdk.Stack.isStack(child) && child.stackName === name,
  );
  if (!stack) throw new Error(`no stack named ${name} in stage ${stage.stageName}`);
  return stack;
}

/** Docker image assets of one stage stack, from the assembly's asset manifest. */
interface DockerImageSource {
  dockerBuildArgs?: Record<string, string>;
  dockerFile?: string;
  platform?: string;
}

describe('GeDe CDK app', () => {
  let pipelineTemplate: Template;
  const stacks: Record<string, Template> = {};
  let stackNames: string[] = [];
  let serviceImages: DockerImageSource[] = [];

  beforeAll(() => {
    const app = new cdk.App({
      context: { ...cdkJsonContext(), hostedZoneId: TEST_ZONE_ID, appleSignIn: false },
    });
    const pipelineStack = buildApp(app);
    const stage = pipelineStack.node.findChild('Prod') as GedeStage;
    const assembly = app.synth();
    const nested = assembly.getNestedAssembly(stage.artifactId);
    const manifest = nested.artifacts.find(
      (a): a is cdk.cx_api.AssetManifestArtifact =>
        a instanceof cdk.cx_api.AssetManifestArtifact && a.id.includes('Service'),
    );
    if (!manifest) throw new Error('no asset manifest for GeDe-Prod-Service');
    const assets = JSON.parse(readFileSync(manifest.file, 'utf8')) as {
      dockerImages?: Record<string, { source: DockerImageSource }>;
    };
    serviceImages = Object.values(assets.dockerImages ?? {}).map((i) => i.source);

    pipelineTemplate = Template.fromStack(pipelineStack);
    stackNames = stage.node.children.filter(cdk.Stack.isStack).map((s) => s.stackName);
    for (const short of ['Network', 'Data', 'Auth', 'Edge', 'Service', 'Web', 'Dns', 'Ops']) {
      stacks[short] = Template.fromStack(stageStack(stage, `GeDe-Prod-${short}`));
    }
  });

  it('stage contains exactly the eight GeDe-Prod-* stacks', () => {
    expect([...stackNames].sort()).toEqual(
      [
        'GeDe-Prod-Auth',
        'GeDe-Prod-Data',
        'GeDe-Prod-Dns',
        'GeDe-Prod-Edge',
        'GeDe-Prod-Network',
        'GeDe-Prod-Ops',
        'GeDe-Prod-Service',
        'GeDe-Prod-Web',
      ].sort(),
    );
  });

  it('Cognito pool is passwordless on the Essentials tier', () => {
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'ESSENTIALS',
      DeletionProtection: 'ACTIVE',
      Policies: {
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP', 'WEB_AUTHN'] },
      },
      WebAuthnRelyingPartyID: 'gede.work',
      WebAuthnUserVerification: 'required',
    });
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      // USER_AUTH only: no password or SRP flow on the client.
      ExplicitAuthFlows: ['ALLOW_USER_AUTH'],
      SupportedIdentityProviders: ['COGNITO'],
      AllowedOAuthFlowsUserPoolClient: false,
      CallbackURLs: Match.absent(),
    });
    stacks.Auth!.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  });

  it('AUTH-09 no password recovery path, attribute scopes restricted, refresh tokens rotate (#35)', () => {
    // AccountRecovery.NONE: ForgotPassword cannot set a durable password on an OTP/passkey account.
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPool', {
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] },
    });
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ReadAttributes: ['email', 'email_verified', 'family_name', 'given_name', 'locale', 'name'],
      WriteAttributes: ['email', 'family_name', 'given_name', 'locale', 'name'],
      RefreshTokenRotation: { Feature: 'ENABLED', RetryGracePeriodSeconds: 30 },
      EnableTokenRevocation: true,
    });
  });

  it('RDS is a protected Postgres 17 Graviton instance in isolated subnets', () => {
    stacks.Data!.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DeletionProtection: true,
      DBInstanceClass: 'db.t4g.micro',
      StorageType: 'gp3',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      MultiAZ: false,
      BackupRetentionPeriod: 7,
      CACertificateIdentifier: 'rds-ca-rsa2048-g1',
    });
    stacks.Data!.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
    });
    // The DB security group carries no inline ingress; the service stack grants it remotely.
    stacks.Data!.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    stacks.Service!.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 5432,
      ToPort: 5432,
      IpProtocol: 'tcp',
    });
  });

  it('SHARE-03 a second, generated secret holds the least-privilege app role; both tasks receive it as PGAPPUSER/PGAPPPASSWORD next to the master PG* (#36)', () => {
    // The RDS-generated master secret plus gede/prod/db-app, nothing else.
    stacks.Data!.resourceCountIs('AWS::SecretsManager::Secret', 2);
    stacks.Data!.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'gede/prod/db-app',
      GenerateSecretString: {
        SecretStringTemplate: JSON.stringify({ username: DB_APP_USERNAME }),
        GenerateStringKey: 'password',
        PasswordLength: 48,
        ExcludePunctuation: true,
      },
    });
    expect(DB_APP_USERNAME).toBe('gede_app');

    const taskDefs = Object.values(stacks.Service!.findResources('AWS::ECS::TaskDefinition')) as {
      Properties: { ContainerDefinitions: { Secrets: { Name: string; ValueFrom: unknown }[] }[] };
    }[];
    expect(taskDefs).toHaveLength(2);
    for (const taskDef of taskDefs) {
      const secrets = taskDef.Properties.ContainerDefinitions[0]!.Secrets;
      const names = secrets.map((s) => s.Name).sort();
      expect(names).toEqual([
        'PGAPPPASSWORD',
        'PGAPPUSER',
        'PGDATABASE',
        'PGHOST',
        'PGPASSWORD',
        'PGPORT',
        'PGUSER',
      ]);
      // The app credentials come from a different secret (the Data stack's `AppUser`) than
      // the master credentials; the json key is the last segment of the ARN reference.
      const source = (name: string) =>
        JSON.stringify(secrets.find((s) => s.Name === name)!.ValueFrom).replace(
          /:(username|password)::/,
          ':<key>::',
        );
      expect(source('PGAPPPASSWORD')).toBe(source('PGAPPUSER'));
      expect(source('PGAPPPASSWORD')).not.toBe(source('PGPASSWORD'));
      expect(source('PGAPPPASSWORD')).toContain('AppUser');
      expect(source('PGPASSWORD')).not.toContain('AppUser');
    }
    // The execution roles may read both secrets; the task roles still read none.
    for (const prefix of ['TaskExecutionRole', 'JobsTaskExecutionRole']) {
      const policy = Object.entries(stacks.Service!.findResources('AWS::IAM::Policy')).find(
        ([id]) => id.startsWith(prefix),
      )?.[1] as {
        Properties: {
          PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
        };
      };
      const secretStatements = policy.Properties.PolicyDocument.Statement.filter((st) =>
        (Array.isArray(st.Action) ? st.Action : [st.Action]).includes(
          'secretsmanager:GetSecretValue',
        ),
      );
      expect(JSON.stringify(secretStatements)).toContain('AppUser');
    }
  });

  it('LIB-08 the docs bucket is versioned and expires noncurrent versions (purged snapshots) after 90 days', () => {
    stacks.Data!.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Id: 'noncurrent-expire-90d',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            ExpiredObjectDeleteMarker: true,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ],
      },
    });
  });

  it('VPC has two AZs, no NAT gateway, and an S3 gateway endpoint', () => {
    stacks.Network!.resourceCountIs('AWS::EC2::NatGateway', 0);
    stacks.Network!.resourceCountIs('AWS::EC2::Subnet', 4);
    stacks.Network!.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });

  it('Fargate task runs on ARM64 with the sync container on port 3000', () => {
    stacks.Service!.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'sync',
          PortMappings: [Match.objectLike({ ContainerPort: 3000 })],
          Environment: Match.arrayWith([
            { Name: 'PGSSLMODE', Value: 'verify-full' },
            { Name: 'WEB_ORIGIN', Value: 'https://gede.work' },
          ]),
          Secrets: Match.arrayWith([Match.objectLike({ Name: 'PGPASSWORD' })]),
        }),
      ],
    });
    stacks.Service!.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      },
    });
    stacks.Service!.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 1,
      MaxCapacity: 4,
    });
  });

  it('both task roles are limited to docs/* objects, prefix-scoped listing, and can never delete a version (#42)', () => {
    interface Policy {
      Properties: {
        PolicyDocument: {
          Statement: {
            Sid?: string;
            Effect: string;
            Action: string | string[];
            Condition?: Record<string, Record<string, string[]>>;
          }[];
        };
      };
    }
    const policies = Object.entries(stacks.Service!.findResources('AWS::IAM::Policy')) as [
      string,
      Policy,
    ][];
    const actions = (s: { Action: string | string[] }): string[] =>
      Array.isArray(s.Action) ? s.Action : [s.Action];
    // The service task and the jobs task (nightly purge, which lists and deletes a
    // purged document's prefix) get the same statements through one grant helper.
    for (const prefix of ['TaskTaskRole', 'JobsTaskTaskRole']) {
      const taskPolicy = policies.find(([id]) => id.startsWith(prefix))?.[1];
      expect(taskPolicy, prefix).toBeDefined();
      const statements = taskPolicy!.Properties.PolicyDocument.Statement;

      const objects = statements.find((s) => s.Sid === 'DocsObjects')!;
      expect(objects.Effect).toBe('Allow');
      expect(actions(objects).sort()).toEqual(['s3:DeleteObject', 's3:GetObject', 's3:PutObject']);

      const list = statements.find((s) => s.Sid === 'ListDocsPrefixOnly')!;
      expect(actions(list)).toEqual(['s3:ListBucket']);
      expect(list.Condition).toEqual({ StringLike: { 's3:prefix': ['docs/*'] } });

      const deny = statements.find((s) => s.Sid === 'NeverDeleteVersions')!;
      expect(deny.Effect).toBe('Deny');
      expect(actions(deny)).toEqual(['s3:DeleteObjectVersion']);

      // No wildcard S3 actions anywhere, and no Secrets Manager access: the execution role
      // injects PG*; the service never calls Secrets Manager.
      const allowed = statements.filter((s) => s.Effect === 'Allow').flatMap(actions);
      expect(allowed.filter((a) => a.startsWith('s3:') && a.includes('*'))).toEqual([]);
      expect(allowed.filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
    }
    for (const prefix of ['TaskExecutionRole', 'JobsTaskExecutionRole']) {
      const executionPolicy = policies.find(([id]) => id.startsWith(prefix))?.[1];
      expect(executionPolicy!.Properties.PolicyDocument.Statement.flatMap(actions)).toContain(
        'secretsmanager:GetSecretValue',
      );
    }
  });

  it('LIB-08 a jobs task definition runs the purge command on the same image, with its own one-month log group', () => {
    stacks.Service!.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    stacks.Service!.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'gede-prod-jobs',
      Cpu: '512',
      Memory: '1024',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'purge',
          Command: PURGE_COMMAND,
          PortMappings: Match.absent(),
          Environment: Match.arrayWith([
            { Name: 'PGSSLMODE', Value: 'verify-full' },
            { Name: 'DOCS_PREFIX', Value: 'docs/' },
          ]),
          Secrets: Match.arrayWith([Match.objectLike({ Name: 'PGPASSWORD' })]),
        }),
      ],
    });
    // Both log groups keep a month, and both task definitions share one image asset.
    stacks.Service!.resourceCountIs('AWS::Logs::LogGroup', 2);
    stacks.Service!.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    const taskDefs = Object.values(stacks.Service!.findResources('AWS::ECS::TaskDefinition')) as {
      Properties: { ContainerDefinitions: { Image: unknown }[] };
    }[];
    const images = taskDefs.map((t) => JSON.stringify(t.Properties.ContainerDefinitions[0]?.Image));
    expect(new Set(images).size).toBe(1);
  });

  it('LOAD-05 the sync image is built with GEDE_VERSION from the CodeBuild source sha (local otherwise)', () => {
    expect(serviceImages).toHaveLength(1);
    // The synthesized value depends on the environment the tests run in: `local` on a
    // laptop, the short sha on CodeBuild (which sets CODEBUILD_RESOLVED_SOURCE_VERSION
    // for the Synth step, where `npm run verify` also runs).
    expect(serviceImages[0]).toMatchObject({
      dockerFile: 'services/sync/Dockerfile',
      platform: 'linux/arm64',
      dockerBuildArgs: { GEDE_VERSION: gedeVersion() },
    });
    expect(serviceImages[0]!.dockerBuildArgs?.GEDE_VERSION).toMatch(/^(local|[0-9a-f]{7})$/);
    expect(gedeVersion({})).toBe('local');
    expect(gedeVersion({ CODEBUILD_RESOLVED_SOURCE_VERSION: '' })).toBe('local');
    expect(gedeVersion({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'ba70477deadbeef0123456789' })).toBe(
      'ba70477',
    );
  });

  it('ALB keeps WebSocket connections open for an hour, redirects HTTP, and cannot be deleted by accident', () => {
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'idle_timeout.timeout_seconds', Value: '3600' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      ]),
    });
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({
            Protocol: 'HTTPS',
            Port: '443',
            StatusCode: 'HTTP_301',
          }),
        }),
      ],
    });
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3000,
      HealthCheckPath: '/healthz',
      HealthCheckIntervalSeconds: 30,
      TargetGroupAttributes: Match.arrayWith([
        { Key: 'deregistration_delay.timeout_seconds', Value: '30' },
        { Key: 'stickiness.enabled', Value: 'true' },
      ]),
    });
  });

  it('ALB forwards /api only with the CloudFront origin-verify header, /ws directly, else 403 (#33)', () => {
    // Deny by default.
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      DefaultActions: [
        {
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '403' }),
        },
      ],
    });
    stacks.Service!.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
    // The WebSocket keeps its direct path (ADR-010); the service checks the JWT on upgrade.
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Actions: [Match.objectLike({ Type: 'forward' })],
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/ws/*'] } }],
    });
    // /api/* and /healthz need every listed generation's value; each is a Secrets Manager
    // dynamic reference resolved at deploy time, never a literal in the template.
    const secretRef = Match.objectLike({
      'Fn::Join': [
        '',
        Match.arrayWith([
          '{{resolve:secretsmanager:',
          Match.objectLike({
            'Fn::GetStackOutput': Match.objectLike({ StackName: 'GeDe-Prod-Web' }),
          }),
          ':SecretString:::}}',
        ]),
      ],
    });
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 20,
      Actions: [Match.objectLike({ Type: 'forward' })],
      Conditions: [
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*', '/healthz'] } },
        {
          Field: 'http-header',
          HttpHeaderConfig: {
            HttpHeaderName: ORIGIN_VERIFY_HEADER,
            Values: ORIGIN_VERIFY_GENERATIONS.map(() => secretRef),
          },
        },
      ],
    });
    // One generated, punctuation-free secret per generation, all in the Web stack. CloudFront
    // presents a generation the ALB accepts (rotation is add → present → drop, runbook §12).
    expect(ORIGIN_VERIFY_GENERATIONS).toContain(ORIGIN_VERIFY_PRESENTED);
    stacks.Web!.resourceCountIs('AWS::SecretsManager::Secret', ORIGIN_VERIFY_GENERATIONS.length);
    stacks.Web!.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 64 },
    });
  });

  it('CloudFront serves both aliases with the WAF, the origin-verify header and a per-behaviour SPA fallback (#33, #38)', () => {
    stacks.Web!.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['gede.work', 'www.gede.work'],
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_200',
        WebACLId: Match.anyValue(),
        // No distribution-wide error rewrites: /api/* 403/404 reach the browser as such.
        CustomErrorResponses: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            Match.objectLike({ EventType: 'viewer-request', FunctionARN: Match.anyValue() }),
          ],
        }),
        CacheBehaviors: [
          Match.objectLike({ PathPattern: '/assets/*', FunctionAssociations: Match.absent() }),
          Match.objectLike({
            PathPattern: '/api/*',
            ViewerProtocolPolicy: 'https-only',
            FunctionAssociations: Match.absent(),
            // Managed ALL_VIEWER_EXCEPT_HOST_HEADER: Host is the origin's, not the viewer's.
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
          }),
        ],
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: 'api.gede.work',
            OriginCustomHeaders: [
              {
                HeaderName: ORIGIN_VERIFY_HEADER,
                HeaderValue: Match.objectLike({
                  'Fn::Join': ['', Match.arrayWith(['{{resolve:secretsmanager:'])],
                }),
              },
            ],
          }),
        ]),
      }),
    });
    stacks.Web!.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'gede-prod-spa-router',
      AutoPublish: true,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      // Extension-less last segment → /index.html; files pass through untouched.
      FunctionCode: Match.stringLikeRegexp(String.raw`indexOf\('\.'\) === -1[\s\S]*'/index\.html'`),
    });
    stacks.Web!.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        Name: 'gede-prod-no-cache',
        MaxTTL: 0,
        MinTTL: 0,
        DefaultTTL: 0,
      }),
    });
    stacks.Edge!.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'gede.work',
      SubjectAlternativeNames: ['www.gede.work'],
    });
  });

  it('SPA responses carry a Content-Security-Policy that names every origin the app uses (#42)', () => {
    const csp = Match.stringLikeRegexp(
      [
        String.raw`^default-src 'self'; `,
        String.raw`script-src 'self'; `,
        String.raw`style-src 'self' 'unsafe-inline' https://fonts\.googleapis\.com; `,
        String.raw`font-src 'self' https://fonts\.gstatic\.com; `,
        String.raw`img-src 'self' data:; `,
        String.raw`connect-src 'self' https://cognito-idp\.ap-southeast-1\.amazonaws\.com wss://ws\.gede\.work; `,
        String.raw`worker-src 'self' blob:; `,
        String.raw`manifest-src 'self'; `,
        String.raw`object-src 'none'; `,
        String.raw`base-uri 'self'; `,
        String.raw`form-action 'self'; `,
        String.raw`frame-ancestors 'none'$`,
      ].join(''),
    );
    // Both the shell and the immutable-assets policy carry it; nothing else is relaxed.
    stacks.Web!.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 2);
    stacks.Web!.allResourcesProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: csp, Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000 }),
        }),
      }),
    });
  });

  it('WAF blocks floods per IP before three AWS managed rule groups inspect the request (#42)', () => {
    stacks.Edge!.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      Rules: [
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Priority: 0,
          Action: { Block: {} },
          Statement: { RateBasedStatement: { AggregateKeyType: 'IP', Limit: RATE_LIMIT_PER_IP } },
        }),
        ...WAF_MANAGED_RULE_GROUPS.map((name, index) =>
          Match.objectLike({
            Name: name,
            Priority: index + 1,
            OverrideAction: { None: {} },
            Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: name } },
          }),
        ),
      ],
    });
    expect(RATE_LIMIT_PER_IP).toBe(2000);
    expect(WAF_MANAGED_RULE_GROUPS).toEqual([
      'AWSManagedRulesCommonRuleSet',
      'AWSManagedRulesKnownBadInputsRuleSet',
      'AWSManagedRulesAmazonIpReputationList',
    ]);
  });

  it('DNS aliases apex/www to CloudFront and api/ws to the ALB', () => {
    stacks.Dns!.resourceCountIs('AWS::Route53::RecordSet', 6);
    stacks.Dns!.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.gede.work.',
      Type: 'A',
      HostedZoneId: TEST_ZONE_ID,
    });
    stacks.Dns!.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'gede.work.',
      Type: 'AAAA',
    });
  });

  it('LIB-08 Ops schedules the nightly purge as a Fargate task and alerts when it exits non-zero', () => {
    stacks.Ops!.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'gede-prod-nightly-purge',
      ScheduleExpression: `cron(${PURGE_SCHEDULE.minute} ${PURGE_SCHEDULE.hour} * * ? *)`,
      ScheduleExpressionTimezone: 'Asia/Singapore',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        EcsParameters: Match.objectLike({
          LaunchType: 'FARGATE',
          TaskDefinitionArn: Match.anyValue(),
          NetworkConfiguration: {
            AwsvpcConfiguration: Match.objectLike({
              AssignPublicIp: 'ENABLED',
              SecurityGroups: [Match.anyValue()],
              Subnets: [Match.anyValue(), Match.anyValue()],
            }),
          },
        }),
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 1 },
      }),
    });
    // The scheduler role may run exactly that task definition and pass its roles.
    stacks.Ops!.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })],
      }),
    });
    stacks.Ops!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'iam:PassRole', Effect: 'Allow' }),
          Match.objectLike({ Action: 'ecs:RunTask', Effect: 'Allow' }),
        ]),
      }),
    });
    // Exit code ≠ 0 (or a task that never started) → SNS, matched on the jobs family only.
    stacks.Ops!.hasResourceProperties('AWS::Events::Rule', {
      Name: 'gede-prod-purge-task-failed',
      EventPattern: {
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: Match.objectLike({
          lastStatus: ['STOPPED'],
          taskDefinitionArn: [
            { prefix: 'arn:aws:ecs:ap-southeast-1:975049998516:task-definition/gede-prod-jobs:' },
          ],
          $or: [
            { containers: { exitCode: [{ 'anything-but': 0 }] } },
            { stopCode: ['TaskFailedToStart'] },
          ],
        }),
      },
      Targets: [Match.objectLike({ Arn: { Ref: Match.stringLikeRegexp('^Alerts') } })],
    });
    // …and the job's own failure log lines as a metric with an alarm on it.
    stacks.Ops!.hasResourceProperties('AWS::Logs::MetricFilter', {
      MetricTransformations: [
        Match.objectLike({ MetricNamespace: 'GeDe/Jobs', MetricName: 'PurgeFailures' }),
      ],
    });
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-purge-failed',
      Namespace: 'GeDe/Jobs',
      MetricName: 'PurgeFailures',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('Ops wires alarms and the budget to the alerts email', () => {
    stacks.Ops!.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    stacks.Ops!.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'jrkphani@icloud.com',
    });
    stacks.Ops!.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 100, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
    });
  });

  it('pipeline builds on ARM Graviton CodeBuild', () => {
    pipelineTemplate.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'GeDe',
      PipelineType: 'V2',
    });
    pipelineTemplate.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        Type: 'ARM_CONTAINER',
        Image: Match.stringLikeRegexp('aarch64'),
        ComputeType: 'BUILD_GENERAL1_SMALL',
      }),
    });
    // Every CodeBuild project in the pipeline is ARM: synth, self-mutate, asset publishing, smoke.
    pipelineTemplate.allResourcesProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ Type: 'ARM_CONTAINER' }),
    });
    // Only Synth is MEDIUM (typed eslint over the whole monorepo OOMed on SMALL, exit 134);
    // it also pins Node's heap to match. Everything else stays SMALL.
    const projects = Object.values(pipelineTemplate.findResources('AWS::CodeBuild::Project')) as {
      Properties: {
        Environment: {
          ComputeType: string;
          EnvironmentVariables?: { Name: string; Value: string }[];
        };
      };
    }[];
    const medium = projects.filter(
      (p) => p.Properties.Environment.ComputeType === 'BUILD_GENERAL1_MEDIUM',
    );
    expect(medium).toHaveLength(1);
    expect(medium[0]!.Properties.Environment.EnvironmentVariables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Name: 'CI', Value: 'true' }),
        expect.objectContaining({ Name: 'NODE_OPTIONS', Value: '--max-old-space-size=4096' }),
      ]),
    );
    expect(
      projects.filter((p) => p.Properties.Environment.ComputeType === 'BUILD_GENERAL1_SMALL'),
    ).toHaveLength(projects.length - 1);
  });

  it('every CodeBuild project logs to one group that expires after 30 days (#40, #42)', () => {
    pipelineTemplate.resourceCountIs('AWS::Logs::LogGroup', 1);
    pipelineTemplate.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    const [logGroupId] = Object.keys(pipelineTemplate.findResources('AWS::Logs::LogGroup'));
    pipelineTemplate.resourceCountIs('AWS::CodeBuild::Project', 5);
    pipelineTemplate.allResourcesProperties('AWS::CodeBuild::Project', {
      LogsConfig: { CloudWatchLogs: { GroupName: { Ref: logGroupId }, Status: 'ENABLED' } },
    });
  });

  it('Smoke probes the API through CloudFront and proves the bare origin answers 403 (#33)', () => {
    interface Project {
      Properties: { Source: { BuildSpec?: string } };
    }
    const projects = Object.values(pipelineTemplate.findResources('AWS::CodeBuild::Project'));
    const smoke = (projects as Project[]).filter((p) =>
      p.Properties.Source.BuildSpec?.includes('id=\\"root\\"'),
    );
    expect(smoke).toHaveLength(1);
    const spec = JSON.parse(smoke[0]!.Properties.Source.BuildSpec!) as {
      phases: { build: { commands: string[] } };
    };
    const commands = spec.phases.build.commands;
    expect(commands.some((c) => c.includes('"$APP_URL/api/health"'))).toBe(true);
    expect(commands.some((c) => c.includes('"$API_URL/api/health"') && c.includes('= 403'))).toBe(
      true,
    );
    // Nothing curls the ALB hostname expecting success any more.
    expect(commands.some((c) => c.includes('$API_URL/healthz'))).toBe(false);
  });

  it('LOAD-06 Synth installs Chromium, then runs verify, db:parity, e2e, the web build and cdk synth in that order', () => {
    interface Project {
      Properties: {
        Source: { BuildSpec?: string };
        Environment: {
          PrivilegedMode?: boolean;
          EnvironmentVariables?: { Name: string; Value: string }[];
        };
      };
    }
    const projects = Object.values(pipelineTemplate.findResources('AWS::CodeBuild::Project'));
    const synthProjects = (projects as Project[]).filter((p) =>
      p.Properties.Source.BuildSpec?.includes('npm run verify'),
    );
    expect(synthProjects).toHaveLength(1);
    const project = synthProjects[0]!;
    const spec = JSON.parse(project.Properties.Source.BuildSpec!) as {
      phases: { install: { commands: string[] }; build: { commands: string[] } };
      cache: { paths: string[] };
    };

    // Install: Chromium's shared libraries come from dnf (Playwright's install-deps is
    // apt-only), then `npm ci`, then the headless shell only.
    const install = spec.phases.install.commands;
    expect(install).toHaveLength(3);
    expect(install[0]).toMatch(/^dnf install -y -q .*\bmesa-libgbm\b.*\bnss\b/);
    expect(install[1]).toBe('npm ci');
    expect(install[2]).toBe('npx playwright install --only-shell chromium');

    // Build: verify → production-dependency audit → migrations parity on a throwaway
    // Postgres (Docker) → Playwright
    // journeys → web build → cdk synth. Exact lines: nothing may swallow a failure
    // (no `|| true`, no `--ignore`), so a red journey stops the pipeline before publishing.
    expect(spec.phases.build.commands).toEqual([
      'npm run verify',
      'npm run audit',
      'npm run db:parity -w packages/db',
      'npm run e2e',
      'npm run build --workspace apps/web',
      'npm run synth --workspace infra',
    ]);

    // node_modules and the Playwright browser cache survive between builds on a reused host.
    expect(spec.cache.paths).toEqual(
      expect.arrayContaining(['node_modules/**/*', '/root/.cache/ms-playwright/**/*']),
    );
    // Docker needs a privileged project (`dockerEnabledForSynth`); CI=true turns a missing
    // Docker into a failure inside packages/db/scripts/parity.sh and selects Playwright's
    // CI workers, retries and reporters.
    expect(project.Properties.Environment.PrivilegedMode).toBe(true);
    expect(project.Properties.Environment.EnvironmentVariables).toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'CI', Value: 'true' })]),
    );
  });

  it('applies the organisation tags to stage resources', () => {
    stacks.Data!.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'Application', Value: 'GeDe' },
        { Key: 'Environment', Value: 'prod' },
        { Key: 'ManagedBy', Value: 'CDK' },
        { Key: 'Organization', Value: 'quadnomics' },
      ]),
    });
  });
});
