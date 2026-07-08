// Test-first plan item 6 (issue 049): the debug/db inspection API's CDK
// assertions. Covers both halves of the `test`-env-only gate — the Api
// stack's Lambda + `/debug/db/*` ALB route, and the Hosting stack's
// CloudFront no-cache behavior — proving each exists when the `debugApi`
// flag is on and is ENTIRELY ABSENT when it's off (the default), with the
// `ECS::Service` count unchanged either way (this is a Lambda, not a third
// Fargate service).
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

function synth(debugApi: boolean) {
  const app = new cdk.App({ context: TEST_CONTEXT });
  const { api, hosting } = buildAppStacks(app, 'test', undefined, undefined, debugApi);
  return { apiTemplate: Template.fromStack(api), hostingTemplate: Template.fromStack(hosting) };
}

describe('Debug/db inspection API (issue 049) — enabled (debugApi=true)', () => {
  it('creates exactly one additional Lambda function (write-path + debug-path = 2), still zero additional ECS::Service', () => {
    const { apiTemplate } = synth(true);
    apiTemplate.resourceCountIs('AWS::ECS::Service', 1);
    apiTemplate.resourceCountIs('AWS::Lambda::Function', 2);
  });

  it('the debug Lambda runs in the VPC private subnets with its own dedicated security group', () => {
    const { apiTemplate } = synth(true);
    const fns = apiTemplate.findResources('AWS::Lambda::Function');
    const vpcFns = Object.values(fns).filter(
      (fn) => (fn as { Properties: { VpcConfig?: unknown } }).Properties.VpcConfig !== undefined,
    );
    expect(vpcFns).toHaveLength(2); // write-path + debug-path
  });

  it('the debug Lambda security group has its own distinct ingress rule to the Data stack\'s Postgres SG (a third rule, alongside sync + write-path)', () => {
    const { apiTemplate } = synth(true);
    const rule5432 = apiTemplate.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(3);
  });

  it('routes /debug/db/* via its own ALB listener rule, distinct from /sync* and /write*', () => {
    const { apiTemplate } = synth(true);
    apiTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
    apiTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([
        Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/debug/db/*'] } }),
      ]),
    });
  });

  it('routes to the debug Lambda via a Lambda target group with health checks disabled (cost: no synthetic-invocation billing)', () => {
    const { apiTemplate } = synth(true);
    apiTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 3);
    const targetGroups = Object.values(
      apiTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Properties: { TargetType: 'lambda', HealthCheckEnabled: false },
      }),
    );
    expect(targetGroups).toHaveLength(2); // write-path + debug-path
  });

  it('creates a CDK-generated Secrets Manager secret for the debug token, and grants the debug Lambda read access to it', () => {
    const { apiTemplate } = synth(true);
    // The Data stack's DB secret is a cross-stack (imported) reference, not
    // a resource defined IN this stack's own template — only the debug-token
    // secret this stack itself creates shows up here.
    apiTemplate.resourceCountIs('AWS::SecretsManager::Secret', 1);
    apiTemplate.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ ExcludePunctuation: true }),
    });
    apiTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('secretsmanager:GetSecretValue')]),
            Effect: 'Allow',
            Resource: Match.objectLike({ Ref: Match.stringLikeRegexp('DebugTokenSecret') }),
          }),
        ]),
      },
    });
  });

  it('bundles the real debugApi/albAdapter.ts handler (an S3 asset, not an inline stub)', () => {
    const { apiTemplate } = synth(true);
    const fns = Object.values(apiTemplate.findResources('AWS::Lambda::Function')) as Array<{
      Properties: { Code: Record<string, unknown>; Environment?: { Variables: Record<string, unknown> } };
    }>;
    const debugFn = fns.find((fn) => fn.Properties.Environment?.Variables.DEBUG_TOKEN_SECRET_ARN !== undefined);
    expect(debugFn).toBeDefined();
    expect(debugFn?.Properties.Code.S3Bucket).toBeDefined();
    expect(debugFn?.Properties.Code.S3Key).toBeDefined();
  });

  it('the Hosting distribution forwards /debug/db/* to the Api ALB with caching disabled', () => {
    const { hostingTemplate } = synth(true);
    hostingTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: 'debug/db/*',
            ViewerProtocolPolicy: 'redirect-to-https',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // AWS-managed CachingDisabled
            AllowedMethods: Match.arrayWith(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']),
          }),
        ]),
      }),
    });
  });

  it('the /debug/db/* origin is the same Api ALB as /write* — a cross-stack reference, not a hardcoded DNS name', () => {
    const { hostingTemplate } = synth(true);
    const distributions = hostingTemplate.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions) as Array<{
      Properties: { DistributionConfig: { Origins: Array<{ DomainName: unknown }> } };
    }>;
    const domainNames = distribution.Properties.DistributionConfig.Origins.map((o) => JSON.stringify(o.DomainName));
    expect(domainNames.some((d) => d.includes('Gede-Test-Api'))).toBe(true);
  });
});

describe('Debug/db inspection API (issue 049) — disabled (debugApi=false, the default — prod must never get this)', () => {
  it('creates no debug Lambda — exactly one Lambda function (write-path only), ECS::Service count still 1', () => {
    const { apiTemplate } = synth(false);
    apiTemplate.resourceCountIs('AWS::ECS::Service', 1);
    apiTemplate.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('creates no debug-token secret in the Api stack\'s own template', () => {
    const { apiTemplate } = synth(false);
    apiTemplate.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  it('adds no /debug/db/* ALB listener rule — only /sync* and /write*', () => {
    const { apiTemplate } = synth(false);
    apiTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
    const rules = apiTemplate.findResources('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Properties: {
        Conditions: Match.arrayWith([
          Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/debug/db/*'] } }),
        ]),
      },
    });
    expect(Object.keys(rules)).toHaveLength(0);
  });

  it('adds no /debug/db/* CloudFront behavior', () => {
    const { hostingTemplate } = synth(false);
    const distributions = hostingTemplate.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions) as Array<{
      Properties: { DistributionConfig: { CacheBehaviors?: Array<{ PathPattern: string }> } };
    }>;
    const pathPatterns = (distribution.Properties.DistributionConfig.CacheBehaviors ?? []).map((b) => b.PathPattern);
    expect(pathPatterns).not.toContain('debug/db/*');
  });

  it('never creates a debug SG ingress rule to Postgres — exactly the sync + write-path rules (two)', () => {
    const { apiTemplate } = synth(false);
    const rule5432 = apiTemplate.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(2);
  });
});
