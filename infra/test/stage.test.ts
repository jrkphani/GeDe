import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { type GedeStage } from '../lib/gede-stage.js';

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

describe('GeDe CDK app', () => {
  let pipelineTemplate: Template;
  const stacks: Record<string, Template> = {};
  let stackNames: string[] = [];

  beforeAll(() => {
    const app = new cdk.App({
      context: { ...cdkJsonContext(), hostedZoneId: TEST_ZONE_ID, appleSignIn: false },
    });
    const pipelineStack = buildApp(app);
    const stage = pipelineStack.node.findChild('Prod') as GedeStage;
    app.synth();

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
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_AUTH']),
      SupportedIdentityProviders: ['COGNITO'],
      AllowedOAuthFlowsUserPoolClient: false,
      CallbackURLs: Match.absent(),
    });
    stacks.Auth!.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
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

  it('ALB keeps WebSocket connections open for an hour and redirects HTTP', () => {
    stacks.Service!.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      LoadBalancerAttributes: Match.arrayWith([
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

  it('CloudFront serves both aliases with the WAF and SPA fallbacks', () => {
    stacks.Web!.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['gede.work', 'www.gede.work'],
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_200',
        WebACLId: Match.anyValue(),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/assets/*' }),
          Match.objectLike({ PathPattern: '/api/*', ViewerProtocolPolicy: 'https-only' }),
        ]),
      }),
    });
    stacks.Web!.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        Name: 'gede-prod-no-cache',
        MaxTTL: 0,
        MinTTL: 0,
        DefaultTTL: 0,
      }),
    });
    stacks.Edge!.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
    });
    stacks.Edge!.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'gede.work',
      SubjectAlternativeNames: ['www.gede.work'],
    });
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

  it('Ops wires alarms and the budget to the alerts email', () => {
    stacks.Ops!.resourceCountIs('AWS::CloudWatch::Alarm', 3);
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
  });

  it('LOAD-06 Synth runs the migrations against a throwaway Postgres in Docker before anything deploys', () => {
    const projects = Object.values(pipelineTemplate.findResources('AWS::CodeBuild::Project')) as {
      Properties: {
        Source: { BuildSpec: string };
        Environment: {
          PrivilegedMode?: boolean;
          EnvironmentVariables?: { Name: string; Value: string }[];
        };
      };
    }[];
    const synth = projects.filter((p) => p.Properties.Source.BuildSpec.includes('npm run verify'));
    expect(synth).toHaveLength(1);
    const buildSpec = JSON.parse(synth[0]!.Properties.Source.BuildSpec) as {
      phases: { build: { commands: string[] } };
    };
    const commands = buildSpec.phases.build.commands;
    // Parity runs right after verify and before the web build and cdk synth.
    expect(commands.indexOf('npm run db:parity -w packages/db')).toBe(
      commands.indexOf('npm run verify') + 1,
    );
    // Docker needs a privileged project (`dockerEnabledForSynth`), and CI=true
    // turns a missing Docker into a failure inside packages/db/scripts/parity.sh.
    expect(synth[0]!.Properties.Environment.PrivilegedMode).toBe(true);
    expect(synth[0]!.Properties.Environment.EnvironmentVariables).toEqual(
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
