import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { PLAYWRIGHT_LIVE_ROLE_NAME, PROD } from '../lib/config.js';
import { type GedeStage } from '../lib/gede-stage.js';
import { CDK_ASSETS_CLI_VERSION, CDK_CLI_VERSION } from '../lib/pipeline-stack.js';
import { E2E_CLIENT_NAME } from '../lib/stacks/auth-stack.js';
import { DB_APP_USERNAME } from '../lib/stacks/data-stack.js';
import { SPF_RECORD, dmarcRecord } from '../lib/stacks/dns-stack.js';
import {
  RATE_LIMIT_PER_IP,
  WAF_MANAGED_RULE_GROUPS,
  WAF_REDACTED_HEADERS,
} from '../lib/stacks/edge-stack.js';
import { PURGE_SCHEDULE, PURGE_SILENCE_HOURS } from '../lib/stacks/ops-stack.js';
import { PURGE_COMMAND, gedeVersion } from '../lib/stacks/service-stack.js';
import {
  ACCESS_LOG_PREFIXES,
  ACCESS_LOG_RETENTION_DAYS,
  ORIGIN_VERIFY_GENERATIONS,
  ORIGIN_VERIFY_HEADER,
  ORIGIN_VERIFY_PRESENTED,
  webRuntimeConfig,
} from '../lib/stacks/web-stack.js';

const TEST_ZONE_ID = 'Z0000000000000000TEST';
const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(INFRA_ROOT, '..');

/**
 * The SPA's own `parseConfig` (apps/web/src/config.ts), the one authority on what
 * `/config.json` may contain (#61). Loaded at run time through a computed specifier:
 * a literal import would pull the web app into infra's TypeScript program (`rootDir`),
 * while vitest resolves and transforms the file like any other.
 */
async function webParseConfig(): Promise<(raw: unknown) => unknown> {
  const specifier = pathToFileURL(path.join(REPO_ROOT, 'apps/web/src/config.ts')).href;
  const mod = (await import(specifier)) as { parseConfig: (raw: unknown) => unknown };
  return mod.parseConfig;
}

/**
 * The `config.json` the Web stack deploys, as staged in the assembly. `Source.jsonData`
 * writes CloudFormation tokens as `<<marker:0xbaba:N>>` (unquoted; the deployment Lambda
 * substitutes the resolved value, JSON-encoded), so each marker stands in for a string here.
 */
function renderedWebConfig(assembly: cdk.cx_api.CloudAssembly): unknown {
  const roots = [
    assembly.directory,
    ...assembly.nestedAssemblies.map((n) => n.nestedAssembly.directory),
  ];
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('asset.')) continue;
      const file = path.join(root, entry, 'config.json');
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      return JSON.parse(text.replace(/<<marker:0xbaba:(\d+)>>/g, '"marker-$1"')) as unknown;
    }
  }
  throw new Error('no config.json asset in the assembly');
}

/** The version the root lockfile resolves a package to (`npm ci` installs exactly this). */
function lockedVersion(name: string): string {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const version = lock.packages[`node_modules/${name}`]?.version;
  if (version === undefined) throw new Error(`${name} is not in package-lock.json`);
  return version;
}

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
  let assembly: cdk.cx_api.CloudAssembly;
  const stacks: Record<string, Template> = {};
  let stackNames: string[] = [];
  let serviceImages: DockerImageSource[] = [];

  beforeAll(() => {
    const app = new cdk.App({
      context: { ...cdkJsonContext(), hostedZoneId: TEST_ZONE_ID, appleSignIn: false },
    });
    const pipelineStack = buildApp(app);
    const stage = pipelineStack.node.findChild('Prod') as GedeStage;
    assembly = app.synth();
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

  it('AUTH-04 the SPA client reports unknown addresses so the sign-in copy can (#46, ADR 040)', () => {
    // The SPA client answers an unknown address with UserNotFoundException — the one
    // branch the "No account uses this email" copy needs. The pipeline's e2e client
    // keeps the obfuscation: nothing user-facing signs in through it.
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_USER_AUTH'],
      PreventUserExistenceErrors: 'LEGACY',
    });
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  it('AUTH-03 a changed email stays unverified and the original stays in force until the code is confirmed (#107)', () => {
    // The client may write `email` (above); with no recovery path an unverified update
    // would be a lockout and takeover primitive. Auto-verification of email stays on.
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: ['email'],
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
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
            Resource?: unknown;
            Condition?: Record<string, Record<string, string | string[]>>;
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

      // SHARE-02: share mail is `ses:SendEmail` only (no SendRawEmail, no wildcard), on the
      // domain identity, from the product's sender address and nothing else.
      const mail = statements.find((s) => s.Sid === 'ShareMail')!;
      expect(mail.Effect).toBe('Allow');
      expect(actions(mail)).toEqual(['ses:SendEmail']);
      expect(mail.Condition).toEqual({ StringEquals: { 'ses:FromAddress': 'no-reply@gede.work' } });
      expect(JSON.stringify(mail.Resource)).toMatch(/identity\//);
      expect(allowed.filter((a) => a.startsWith('ses:'))).toEqual(['ses:SendEmail']);

      // AUTH-09 / #111: only the service task may delete a pool user, on this pool only.
      const erase = statements.find((s) => s.Sid === 'EraseIdentity');
      if (prefix === 'TaskTaskRole') {
        expect(erase?.Effect).toBe('Allow');
        expect(actions(erase!)).toEqual(['cognito-idp:AdminDeleteUser']);
        expect(JSON.stringify(erase!.Resource)).toMatch(/:userpool\//);
      } else {
        expect(erase).toBeUndefined();
      }
      expect(
        allowed.filter((a) => a.startsWith('cognito-idp:') && a !== 'cognito-idp:AdminDeleteUser'),
      ).toEqual([]);
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

  it('ALB keeps WebSocket connections open for an hour, redirects HTTP, logs to the access-logs bucket, and cannot be deleted by accident', () => {
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'idle_timeout.timeout_seconds', Value: '3600' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        {
          Key: 'access_logs.s3.bucket',
          Value: { 'Fn::GetStackOutput': Match.objectLike({ StackName: 'GeDe-Prod-Web' }) },
        },
        { Key: 'access_logs.s3.prefix', Value: ACCESS_LOG_PREFIXES.alb },
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
      // No stickiness cookie on `/api` responses (#116).
      TargetGroupAttributes: Match.arrayWith([
        { Key: 'deregistration_delay.timeout_seconds', Value: '30' },
        { Key: 'stickiness.enabled', Value: 'false' },
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

  it('CloudFront, the ALB and the WAF all log requests: one 90-day bucket for the two entry points, a 30-day log group for the ACL (#113)', () => {
    expect(ACCESS_LOG_RETENTION_DAYS).toBe(90);
    // The bucket: ACL-capable for CloudFront's delivery account, otherwise locked down and
    // short-lived. Two buckets in Web: the SPA's and this one.
    stacks.Web!.resourceCountIs('AWS::S3::Bucket', 2);
    stacks.Web!.hasResourceProperties('AWS::S3::Bucket', {
      OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] },
      AccessControl: 'LogDeliveryWrite',
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Id: 'expire-90d',
            Status: 'Enabled',
            ExpirationInDays: 90,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ],
      },
    });
    const [logsBucketId] = Object.entries(stacks.Web!.findResources('AWS::S3::Bucket')).find(
      ([, b]) =>
        (b as { Properties: { AccessControl?: string } }).Properties.AccessControl ===
        'LogDeliveryWrite',
    )!;
    stacks.Web!.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({ AccessControl: 'LogDeliveryWrite' }),
      DeletionPolicy: 'Delete',
    });
    // CloudFront standard logs, without cookies, under their own prefix.
    stacks.Web!.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: {
          Bucket: { 'Fn::GetAtt': [logsBucketId, 'RegionalDomainName'] },
          IncludeCookies: false,
          Prefix: ACCESS_LOG_PREFIXES.cloudfront,
        },
      }),
    });
    // The bucket policy denies plaintext and admits the regional ELB log-delivery account
    // (ap-southeast-1: 114774131450) and the logs delivery service under `alb/`, which
    // `ServiceStack` adds when it enables access logs on the ALB.
    interface BucketPolicy {
      Properties: {
        Bucket: { Ref: string };
        PolicyDocument: {
          Statement: {
            Effect: string;
            Principal: unknown;
            Action: string | string[];
            Resource: unknown;
            Condition?: unknown;
          }[];
        };
      };
    }
    const policy = (
      Object.values(stacks.Web!.findResources('AWS::S3::BucketPolicy')) as BucketPolicy[]
    ).find((p) => p.Properties.Bucket.Ref === logsBucketId)!;
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Action: 's3:*',
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );
    const elbPut = statements.find(
      (s) => JSON.stringify(s.Principal).includes('114774131450') && s.Action === 's3:PutObject',
    );
    expect(elbPut, 'ELB account PutObject').toBeDefined();
    expect(JSON.stringify(elbPut!.Resource)).toContain(
      `/${ACCESS_LOG_PREFIXES.alb}/AWSLogs/975049998516/*`,
    );
    expect(statements).toContainEqual(
      expect.objectContaining({
        Principal: { Service: 'delivery.logs.amazonaws.com' },
        Action: 's3:GetBucketAcl',
      }),
    );

    // WAF: every request the ACL evaluates, to an `aws-waf-logs-` group in us-east-1 kept
    // 30 days, with bearer tokens and cookies redacted. The destination is the group ARN
    // without `:*`.
    stacks.Edge!.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: 'aws-waf-logs-gede-prod-web',
      RetentionInDays: 30,
    });
    stacks.Edge!.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      ResourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^WebAcl'), 'Arn'] },
      LogDestinationConfigs: [
        {
          'Fn::Join': [
            '',
            [
              'arn:aws:logs:us-east-1:975049998516:log-group:',
              { Ref: Match.stringLikeRegexp('^WafLogs') },
            ],
          ],
        },
      ],
      RedactedFields: WAF_REDACTED_HEADERS.map((name) => ({ SingleHeader: { Name: name } })),
    });
    expect(WAF_REDACTED_HEADERS).toEqual(['authorization', 'cookie']);
  });

  it("AUTH-08 the deployed config.json parses with the SPA's own parseConfig and says appleSignIn: false while the flag is off (#61)", async () => {
    const raw = renderedWebConfig(assembly);
    expect(raw).toMatchObject({
      region: 'ap-southeast-1',
      apiUrl: 'https://gede.work/api',
      wsUrl: 'wss://ws.gede.work/ws',
      appleSignIn: false,
    });
    const parseConfig = await webParseConfig();
    expect(parseConfig(raw)).toMatchObject({ appleSignIn: false, statusUrl: null });
    // The pure renderer agrees with the staged file, so a unit assertion on it is meaningful.
    expect(
      webRuntimeConfig(PROD, { userPoolId: 'p', userPoolClientId: 'c', appleSignIn: false }),
    ).toEqual({
      region: 'ap-southeast-1',
      userPoolId: 'p',
      userPoolClientId: 'c',
      apiUrl: 'https://gede.work/api',
      wsUrl: 'wss://ws.gede.work/ws',
      appleSignIn: false,
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
    stacks.Dns!.resourceCountIs('AWS::Route53::RecordSet', 8);
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

  it('SHARE-02 SPF at the apex names SES only and DMARC quarantines a spoofed no-reply@gede.work (#116)', () => {
    expect(SPF_RECORD).toBe('v=spf1 include:amazonses.com -all');
    expect(dmarcRecord(PROD)).toBe('v=DMARC1; p=quarantine; rua=mailto:jrkphani@icloud.com');
    stacks.Dns!.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'gede.work.',
      Type: 'TXT',
      ResourceRecords: ['"v=spf1 include:amazonses.com -all"'],
    });
    stacks.Dns!.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: '_dmarc.gede.work.',
      Type: 'TXT',
      ResourceRecords: ['"v=DMARC1; p=quarantine; rua=mailto:jrkphani@icloud.com"'],
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
          // The family, not a revision (#97): a literal string, no cross-stack reference.
          TaskDefinitionArn:
            'arn:aws:ecs:ap-southeast-1:975049998516:task-definition/gede-prod-jobs',
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
    // The scheduler role may run any revision of that family and pass the two roles every
    // revision uses (the L2 would have pinned both to the revision synthesized that day).
    stacks.Ops!.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })],
      }),
    });
    stacks.Ops!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'RunAnyRevision',
            Effect: 'Allow',
            Action: 'ecs:RunTask',
            Resource: 'arn:aws:ecs:ap-southeast-1:975049998516:task-definition/gede-prod-jobs:*',
          },
          {
            Sid: 'PassTaskRoles',
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: [
              {
                'Fn::GetStackOutput': Match.objectLike({
                  StackName: 'GeDe-Prod-Service',
                  OutputName: Match.stringLikeRegexp('JobsTaskExecutionRole.*Arn'),
                }),
              },
              {
                'Fn::GetStackOutput': Match.objectLike({
                  StackName: 'GeDe-Prod-Service',
                  OutputName: Match.stringLikeRegexp('JobsTaskTaskRole.*Arn'),
                }),
              },
            ],
            Condition: { StringLike: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
          },
        ],
      },
    });
    // Nothing in Ops names a task-definition revision, and nothing reads the task
    // definition from Service: the family is a string and the roles keep their ARNs.
    const ops = JSON.stringify(stacks.Ops!.toJSON());
    expect(ops).not.toMatch(/task-definition\/gede-prod-jobs:\d/);
    expect(ops).not.toMatch(/PublishOutputRefJobsTask/);
    // …and the schedule is exempt from the failure that would have hidden it: a dropped
    // invocation (RunTask refused, retry exhausted) is an alarm of its own.
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-purge-invocation-dropped',
      Namespace: 'AWS/Scheduler',
      MetricName: 'InvocationDroppedCount',
      Dimensions: [{ Name: 'ScheduleGroup', Value: 'default' }],
      Statistic: 'Sum',
      Period: 3600,
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
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

  it('ONB-01 Ops turns the sync service’s `guided sample seed failed` line into a metric with an alarm', () => {
    stacks.Ops!.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.msg = "guided sample seed failed" }',
      MetricTransformations: [
        Match.objectLike({ MetricNamespace: 'GeDe/Sync', MetricName: 'SampleSeedFailures' }),
      ],
    });
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-sample-seed-failed',
      Namespace: 'GeDe/Sync',
      MetricName: 'SampleSeedFailures',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('Ops wires alarms and the budget to the alerts email', () => {
    stacks.Ops!.resourceCountIs('AWS::CloudWatch::Alarm', 13);
    stacks.Ops!.resourceCountIs('AWS::SNS::Subscription', 1);
    stacks.Ops!.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'jrkphani@icloud.com',
    });
    // Every alarm notifies the topic.
    stacks.Ops!.allResourcesProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^Alerts') }],
    });
    // Actual at 80 % and, since the ops review, the forecast at 100 % (it read US$128 on
    // US$100 while the actual notification sat quiet at 53 %).
    stacks.Ops!.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 150, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
            ThresholdType: 'PERCENTAGE',
          },
        }),
        Match.objectLike({
          Notification: {
            NotificationType: 'FORECASTED',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'jrkphani@icloud.com' }],
        }),
      ],
    });
  });

  it('the alerts topic accepts CloudWatch alarms, EventBridge rules and Budgets from this account only, and keeps the owner statement (#98)', () => {
    interface TopicPolicy {
      Properties: {
        Topics: { Ref: string }[];
        PolicyDocument: {
          Statement: {
            Sid: string;
            Effect: string;
            Principal: { Service?: string; AWS?: string };
            Action: string | string[];
            Condition?: Record<string, Record<string, string>>;
          }[];
        };
      };
    }
    const policies = Object.values(
      stacks.Ops!.findResources('AWS::SNS::TopicPolicy'),
    ) as TopicPolicy[];
    expect(policies).toHaveLength(1);
    const statements = policies[0]!.Properties.PolicyDocument.Statement;
    const account = '975049998516';

    // SNS's default statement, restated: attaching any policy would otherwise remove it.
    const owner = statements.find((s) => s.Sid === 'AccountOwner')!;
    expect(owner.Principal).toEqual({ AWS: '*' });
    expect(owner.Action).toContain('sns:Publish');
    expect(owner.Condition).toEqual({ StringEquals: { 'AWS:SourceOwner': account } });

    // Each publishing service, conditioned on the source account and a source ARN pattern
    // (no unconditioned service grant: the events target's own would have been one).
    const services = statements
      .map((s) => s.Principal.Service)
      .filter((s): s is string => s !== undefined);
    expect([...services].sort()).toEqual([
      'budgets.amazonaws.com',
      'cloudwatch.amazonaws.com',
      'events.amazonaws.com',
    ]);
    const expected: readonly [string, string][] = [
      ['cloudwatch.amazonaws.com', `arn:aws:cloudwatch:ap-southeast-1:${account}:alarm:*`],
      ['events.amazonaws.com', `arn:aws:events:ap-southeast-1:${account}:rule/*`],
      ['budgets.amazonaws.com', `arn:aws:budgets::${account}:budget/*`],
    ];
    for (const [principal, sourceArn] of expected) {
      const statement = statements.find((s) => s.Principal.Service === principal)!;
      expect(statement.Effect).toBe('Allow');
      expect(statement.Action).toBe('sns:Publish');
      expect(statement.Condition).toEqual({
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': sourceArn },
      });
    }
    expect(statements).toHaveLength(4);
    // The purge-failed rule still targets the topic (through a target that adds no policy).
    stacks.Ops!.hasResourceProperties('AWS::Events::Rule', {
      Name: 'gede-prod-purge-task-failed',
      Targets: [
        Match.objectLike({
          Arn: { Ref: Match.stringLikeRegexp('^Alerts') },
          InputTransformer: Match.objectLike({
            InputTemplate: Match.stringLikeRegexp('nightly purge task failed'),
          }),
        }),
      ],
    });
  });

  it('AUTH-04 an error in the pre-authentication trigger is an alarm at the first occurrence (#103)', () => {
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-pre-auth-errors',
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: [
        {
          Name: 'FunctionName',
          Value: {
            'Fn::GetStackOutput': Match.objectLike({
              StackName: 'GeDe-Prod-Auth',
              OutputName: Match.stringLikeRegexp('PreAuth'),
            }),
          },
        },
      ],
      Statistic: 'Sum',
      Period: 60,
      Threshold: 0,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('Ops review 2026-09-13: one task and one db.t4g.micro are watched for memory, a missing healthy target, latency, burst credits and database memory', () => {
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-service-memory',
      Namespace: 'AWS/ECS',
      MetricName: 'MemoryUtilization',
      Threshold: 80,
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-no-healthy-target',
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'HealthyHostCount',
      Statistic: 'Minimum',
      Period: 60,
      Threshold: 1,
      EvaluationPeriods: 3,
      ComparisonOperator: 'LessThanThreshold',
      // A silent metric is the outage, not a gap.
      TreatMissingData: 'breaching',
      Dimensions: Match.arrayWith([
        Match.objectLike({ Name: 'LoadBalancer' }),
        Match.objectLike({ Name: 'TargetGroup' }),
      ]),
    });
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-alb-latency',
      Namespace: 'AWS/ApplicationELB',
      MetricName: 'TargetResponseTime',
      ExtendedStatistic: 'p90',
      Threshold: 2,
      EvaluationPeriods: 3,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-db-cpu-credits',
      Namespace: 'AWS/RDS',
      MetricName: 'CPUCreditBalance',
      Statistic: 'Minimum',
      Threshold: 20,
      EvaluationPeriods: 3,
      ComparisonOperator: 'LessThanThreshold',
    });
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-db-freeable-memory',
      Namespace: 'AWS/RDS',
      MetricName: 'FreeableMemory',
      Threshold: 100 * 1024 ** 2,
      ComparisonOperator: 'LessThanThreshold',
    });
    // The 5xx ratio alarm is unchanged: more than 1 % of requests in a 5-minute period.
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-alb-5xx',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanThreshold',
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: '100 * (elb5xx + target5xx) / requests' }),
      ]),
    });
  });

  it('LIB-08 a purge that never runs is an alarm: no `job finished` line for the purge in 26 hours', () => {
    stacks.Ops!.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ ($.msg = "job finished") && ($.job = "purge") }',
      MetricTransformations: [
        Match.objectLike({
          MetricNamespace: 'GeDe/Jobs',
          MetricName: 'PurgeRuns',
          MetricValue: '1',
        }),
      ],
    });
    expect(PURGE_SILENCE_HOURS).toBe(26);
    stacks.Ops!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'gede-prod-purge-never-ran',
      Namespace: 'GeDe/Jobs',
      MetricName: 'PurgeRuns',
      Statistic: 'Sum',
      Period: 3600,
      Threshold: 1,
      EvaluationPeriods: 26,
      DatapointsToAlarm: 26,
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
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
    // Synth, SelfMutate, two asset publishers, Smoke, Playwright-Live.
    pipelineTemplate.resourceCountIs('AWS::CodeBuild::Project', 6);
    pipelineTemplate.allResourcesProperties('AWS::CodeBuild::Project', {
      LogsConfig: { CloudWatchLogs: { GroupName: { Ref: logGroupId }, Status: 'ENABLED' } },
    });
  });

  it('SelfMutate and the asset publishers install the CLI versions the lockfile pins, never a dist-tag; only Synth and the image publisher are privileged (#106)', () => {
    interface Project {
      Properties: { Source: { BuildSpec?: string }; Environment: { PrivilegedMode?: boolean } };
    }
    // The constants are the pipeline's; the lockfile is what `npm ci` installs. Bump both.
    expect(CDK_CLI_VERSION).toBe(lockedVersion('aws-cdk'));
    expect(CDK_ASSETS_CLI_VERSION).toBe(lockedVersion('cdk-assets'));
    expect(CDK_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CDK_ASSETS_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    // Synth, SelfMutate, Smoke and Playwright-Live carry their buildspec inline; the two
    // asset publishers name a `buildspec-…-{Docker,File}Asset.yaml` file in the assembly.
    const projects = Object.entries(pipelineTemplate.findResources('AWS::CodeBuild::Project')) as [
      string,
      Project,
    ][];
    const specOf = ([, p]: [string, Project]): string => {
      const spec = p.Properties.Source.BuildSpec ?? '';
      return spec.startsWith('buildspec-')
        ? readFileSync(path.join(assembly.directory, spec), 'utf8')
        : spec;
    };
    const specs = projects.map(specOf);
    expect(specs).toHaveLength(6);
    const selfMutate = specs.filter((s) => s.includes('npm install -g aws-cdk@'));
    expect(selfMutate).toHaveLength(1);
    expect(selfMutate[0]).toContain(`npm install -g aws-cdk@${CDK_CLI_VERSION}`);
    const publishers = specs.filter((s) => s.includes('npm install -g cdk-assets@'));
    expect(publishers).toHaveLength(2);
    for (const spec of publishers) {
      expect(spec).toContain(`npm install -g cdk-assets@${CDK_ASSETS_CLI_VERSION}`);
    }
    for (const spec of specs) {
      expect(spec).not.toMatch(/@latest\b/);
      expect(spec).not.toMatch(/aws-cdk@2\b(?!\.\d)/);
    }
    // Privileged: Synth (Docker for db:parity) and the image publisher (docker build);
    // the file-asset publisher, SelfMutate, Smoke and Playwright-Live are not.
    const privileged = projects
      .filter(([, p]) => p.Properties.Environment.PrivilegedMode === true)
      .map(([id]) => id);
    expect(privileged).toHaveLength(2);
    expect(privileged.some((id) => id.includes('Synth'))).toBe(true);
    expect(privileged.some((id) => id.includes('DockerAsset'))).toBe(true);
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

  it('AUTH-01 Playwright-Live runs the live suite after Smoke, as a named role the Auth stack grants AdminInitiateAuth on the pool and the e2e secret to', () => {
    interface Project {
      Properties: {
        Source: { BuildSpec?: string };
        ServiceRole: unknown;
        TimeoutInMinutes?: number;
        Environment: {
          ComputeType: string;
          EnvironmentVariables?: { Name: string; Value: string }[];
        };
      };
    }
    const projects = Object.values(pipelineTemplate.findResources('AWS::CodeBuild::Project'));
    const live = (projects as Project[]).filter((p) =>
      p.Properties.Source.BuildSpec?.includes('npm run e2e:live'),
    );
    expect(live).toHaveLength(1);
    const spec = JSON.parse(live[0]!.Properties.Source.BuildSpec!) as {
      phases: { install: { commands: string[] }; build: { commands: string[] } };
      cache: { paths: string[] };
    };
    // The same Chromium install as Synth, then only the live suite; nothing swallows a failure.
    expect(spec.phases.install.commands).toHaveLength(3);
    expect(spec.phases.install.commands[0]).toMatch(/^dnf install -y -q .*\bnss\b/);
    expect(spec.phases.install.commands.slice(1)).toEqual([
      'npm ci',
      'npx playwright install --only-shell chromium',
    ]);
    expect(spec.phases.build.commands).toEqual(['npm run e2e:live']);
    expect(spec.cache.paths).toEqual(
      expect.arrayContaining(['node_modules/**/*', '/root/.cache/ms-playwright/**/*']),
    );
    expect(live[0]!.Properties.Environment.ComputeType).toBe('BUILD_GENERAL1_SMALL');
    // A hung suite cannot hold the execution for CodeBuild's default hour.
    expect(live[0]!.Properties.TimeoutInMinutes).toBe(20);
    expect(live[0]!.Properties.Environment.EnvironmentVariables).toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'CI', Value: 'true' })]),
    );

    // The project runs as the fixed-name role; the pipeline stack creates it with nothing but
    // what every step gets, and GeDe-Prod-Auth attaches the pool and secret grants by name.
    const [roleId] = Object.entries(pipelineTemplate.findResources('AWS::IAM::Role')).find(
      ([, r]) =>
        (r as { Properties: { RoleName?: string } }).Properties.RoleName ===
        PLAYWRIGHT_LIVE_ROLE_NAME,
    )!;
    expect(live[0]!.Properties.ServiceRole).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    const pipelinePolicies = Object.values(pipelineTemplate.findResources('AWS::IAM::Policy'));
    expect(JSON.stringify(pipelinePolicies)).not.toContain('cognito-idp:');
    stacks.Auth!.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [PLAYWRIGHT_LIVE_ROLE_NAME],
      PolicyDocument: {
        Statement: [
          {
            Sid: 'SignInAsE2eUser',
            Effect: 'Allow',
            Action: 'cognito-idp:AdminInitiateAuth',
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UserPool'), 'Arn'] },
          },
          {
            Sid: 'ReadE2eUserSecret',
            Effect: 'Allow',
            Action: 'secretsmanager:GetSecretValue',
            Resource: { Ref: Match.stringLikeRegexp('^E2eUser') },
          },
        ],
        Version: '2012-10-17',
      },
    });

    // In the pipeline: after Smoke, with the stage outputs the suite needs and the source as input.
    interface Pipeline {
      Properties: {
        Stages: {
          Name: string;
          Actions: {
            Name: string;
            RunOrder: number;
            InputArtifacts?: { Name: string }[];
            Configuration: { EnvironmentVariables?: string };
          }[];
        }[];
      };
    }
    const [pipeline] = Object.values(
      pipelineTemplate.findResources('AWS::CodePipeline::Pipeline'),
    ) as Pipeline[];
    const prodStage = pipeline!.Properties.Stages.find((s) => s.Name === 'Prod')!;
    const smoke = prodStage.Actions.find((a) => a.Name === 'Smoke')!;
    const liveAction = prodStage.Actions.find((a) => a.Name === 'Playwright-Live')!;
    expect(liveAction.RunOrder).toBeGreaterThan(smoke.RunOrder);
    expect(liveAction.InputArtifacts?.map((a) => a.Name)).toEqual(
      smoke.InputArtifacts?.map((a) => a.Name),
    );
    const env = JSON.parse(liveAction.Configuration.EnvironmentVariables!) as {
      name: string;
      value: string;
    }[];
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(Object.keys(byName).sort()).toEqual([
      'E2E_BASE_URL',
      'E2E_CLIENT_ID',
      'E2E_SECRET_ARN',
      'E2E_USER_POOL_ID',
    ]);
    expect(byName.E2E_BASE_URL).toMatch(/Web.*\.AppUrl\}$/);
    expect(byName.E2E_USER_POOL_ID).toMatch(/Auth.*\.UserPoolId\}$/);
    expect(byName.E2E_CLIENT_ID).toMatch(/Auth.*\.E2eClientId\}$/);
    expect(byName.E2E_SECRET_ARN).toMatch(/Auth.*\.E2eUserSecretArn\}$/);
  });

  it('AUTH-01 Auth provisions the gede-e2e client (admin password flow only), the e2e user secret and the account through a handler that never sees the password in its event', () => {
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: E2E_CLIENT_NAME,
      GenerateSecret: false,
      ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      AllowedOAuthFlowsUserPoolClient: false,
      SupportedIdentityProviders: ['COGNITO'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      RefreshTokenValidity: 1440,
    });
    // The SPA client is untouched: still USER_AUTH only (ADR-011).
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_USER_AUTH'],
    });
    stacks.Auth!.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    stacks.Auth!.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'gede/prod/e2e-user',
      GenerateSecretString: {
        SecretStringTemplate: JSON.stringify({ username: 'e2e@gede.work' }),
        GenerateStringKey: 'password',
        PasswordLength: 32,
        RequireEachIncludedType: true,
        ExcludeCharacters: '"\'\\`',
      },
    });
    // The custom resource carries the secret's ARN, never its value.
    stacks.Auth!.hasResourceProperties('Custom::GedeE2eUser', {
      ServiceToken: { 'Fn::GetAtt': [Match.stringLikeRegexp('^E2eUserHandler'), 'Arn'] },
      UserPoolId: { Ref: Match.stringLikeRegexp('^UserPool') },
      SecretArn: { Ref: Match.stringLikeRegexp('^E2eUser') },
      Username: 'e2e@gede.work',
    });
    // Two functions: the user's custom resource and the pre-authentication trigger.
    stacks.Auth!.resourceCountIs('AWS::Lambda::Function', 2);
    stacks.Auth!.allResourcesProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
    });
    stacks.Auth!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'cognito-idp:AdminCreateUser',
              'cognito-idp:AdminDeleteUser',
              'cognito-idp:AdminSetUserPassword',
            ],
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UserPool'), 'Arn'] },
          }),
        ]),
      }),
    });
    // The service accepts tokens from both clients.
    stacks.Service!.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            {
              Name: 'COGNITO_CLIENT_IDS',
              Value: {
                // Weak cross-stack references (cdk.json): the SPA client, a comma, the e2e client.
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetStackOutput': Match.objectLike({
                        StackName: 'GeDe-Prod-Auth',
                        OutputName: Match.stringLikeRegexp('Spa'),
                      }),
                    },
                    ',',
                    {
                      'Fn::GetStackOutput': Match.objectLike({
                        StackName: 'GeDe-Prod-Auth',
                        OutputName: Match.stringLikeRegexp('E2e'),
                      }),
                    },
                  ],
                ],
              },
            },
          ]),
        }),
      ]),
    });
  });

  it('AUTH-04 a pre-authentication trigger binds e2e@gede.work to the gede-e2e client, so the password is not a browser credential (#35 residual)', () => {
    const [preAuthId] = Object.entries(stacks.Auth!.findResources('AWS::Lambda::Function')).find(
      ([, fn]) =>
        (fn as { Properties: { Description?: string } }).Properties.Description?.includes(
          'pre-authentication',
        ),
    )!;
    stacks.Auth!.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PreAuthentication: { 'Fn::GetAtt': [preAuthId, 'Arn'] } },
    });
    stacks.Auth!.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cognito-idp.amazonaws.com',
      FunctionName: { 'Fn::GetAtt': [preAuthId, 'Arn'] },
      SourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^UserPool'), 'Arn'] },
    });
    stacks.Auth!.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('pre-authentication'),
      Environment: {
        Variables: { E2E_USERNAME: 'e2e@gede.work', E2E_CLIENT_NAME: E2E_CLIENT_NAME },
      },
      Timeout: 5,
    });
    // It finds the client by name (the id would be a pool → trigger → client → pool cycle).
    stacks.Auth!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: [
          {
            Sid: 'FindE2eClient',
            Effect: 'Allow',
            Action: 'cognito-idp:ListUserPoolClients',
            Resource: 'arn:aws:cognito-idp:ap-southeast-1:975049998516:userpool/*',
          },
        ],
      }),
    });
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

describe('GeDe CDK app with -c appleSignIn=true (the switch stays off in cdk.json)', () => {
  let auth: Template;
  let web: Template;
  let raw: unknown;

  beforeAll(() => {
    const app = new cdk.App({
      context: { ...cdkJsonContext(), hostedZoneId: TEST_ZONE_ID, appleSignIn: true },
    });
    const pipelineStack = buildApp(app);
    const stage = pipelineStack.node.findChild('Prod') as GedeStage;
    const assembly = app.synth();
    auth = Template.fromStack(stageStack(stage, 'GeDe-Prod-Auth'));
    web = Template.fromStack(stageStack(stage, 'GeDe-Prod-Web'));
    raw = renderedWebConfig(assembly);
  });

  it('AUTH-08 Auth adds the Apple provider, the gede-prod hosted-UI domain and the code grant on the SPA client', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'SignInWithApple',
      AttributeMapping: { email: 'email', given_name: 'firstName', family_name: 'lastName' },
    });
    auth.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'gede-prod' });
    auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: ['ALLOW_USER_AUTH'],
      SupportedIdentityProviders: ['COGNITO', 'SignInWithApple'],
      AllowedOAuthFlows: ['code'],
      CallbackURLs: ['https://gede.work/auth/callback'],
    });
  });

  it("AUTH-08 config.json says appleSignIn: { domain } with the hosted-UI host, and the SPA's parseConfig accepts it (#61)", async () => {
    const domain = 'gede-prod.auth.ap-southeast-1.amazoncognito.com';
    expect(raw).toMatchObject({ appleSignIn: { domain } });
    const parseConfig = await webParseConfig();
    expect(parseConfig(raw)).toMatchObject({ appleSignIn: { domain } });
    // The same host is what the CSP lets the SPA connect to.
    web.allResourcesProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: Match.stringLikeRegexp(
              String.raw`connect-src 'self' https://cognito-idp\.ap-southeast-1\.amazonaws\.com wss://ws\.gede\.work https://gede-prod\.auth\.ap-southeast-1\.amazoncognito\.com; `,
            ),
            Override: true,
          },
        }),
      }),
    });
  });
});
