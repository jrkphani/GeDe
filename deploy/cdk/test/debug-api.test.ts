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
  it('creates five Lambda functions (write-path + accept-invite + shape-proxy + electric-db-url composer + debug-path — issues 058/080 added three of them), still zero additional ECS::Service', () => {
    const { apiTemplate } = synth(true);
    apiTemplate.resourceCountIs('AWS::ECS::Service', 1);
    apiTemplate.resourceCountIs('AWS::Lambda::Function', 6); // write-path + accept-invite (080) + shape-proxy + electric-db-url composer + its cr.Provider framework Lambda + debug-path
  });

  it('the debug Lambda runs in the VPC private subnets with its own dedicated security group (alongside write-path + accept-invite + shape-proxy — the electric-db-url composer needs no VPC, it only calls Secrets Manager)', () => {
    const { apiTemplate } = synth(true);
    const fns = apiTemplate.findResources('AWS::Lambda::Function');
    const vpcFns = Object.values(fns).filter(
      (fn) => (fn as { Properties: { VpcConfig?: unknown } }).Properties.VpcConfig !== undefined,
    );
    expect(vpcFns).toHaveLength(4); // write-path + accept-invite (080) + shape-proxy + debug-path
  });

  it('the debug Lambda security group has its own distinct ingress rule to the Data stack\'s Postgres SG (a fifth rule, alongside sync + write-path + accept-invite + shape-proxy — issues 058/080)', () => {
    const { apiTemplate } = synth(true);
    const rule5432 = apiTemplate.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(5);
  });

  it('routes /debug/db/* via its own ALB listener rule, distinct from /sync*, /write*, and /accept*', () => {
    const { apiTemplate } = synth(true);
    apiTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 4);
    apiTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([
        Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/debug/db/*'] } }),
      ]),
    });
  });

  it('routes to the debug Lambda via a Lambda target group with health checks disabled (cost: no synthetic-invocation billing)', () => {
    const { apiTemplate } = synth(true);
    // Total is now 4: the pre-058 sync Fargate ALB target group is REPLACED
    // by the shape-proxy Lambda's target group (issue 058 — Electric itself
    // is never an ALB target), so write-path + accept-invite (080) +
    // shape-proxy + debug-path = 4.
    apiTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 4);
    const targetGroups = Object.values(
      apiTemplate.findResources('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Properties: { TargetType: 'lambda', HealthCheckEnabled: false },
      }),
    );
    // All four target groups are now Lambda-typed (unlike pre-058, where
    // the sync slot's target group was ECS/IP-typed) — write-path +
    // accept-invite + shape-proxy + debug-path.
    expect(targetGroups).toHaveLength(4);
  });

  it('creates CDK-generated Secrets Manager secrets: the debug token (this issue) plus Electric\'s own secret + composed DATABASE_URL secret (issue 058)', () => {
    const { apiTemplate } = synth(true);
    // The Data stack's DB secret is a cross-stack (imported) reference, not
    // a resource defined IN this stack's own template. This stack's OWN
    // secrets: DebugTokenSecret (this issue), ElectricSecret + Electric
    // DatabaseUrlSecret (issue 058).
    apiTemplate.resourceCountIs('AWS::SecretsManager::Secret', 3);
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
  it('creates no debug Lambda — exactly four Lambda functions (write-path + accept-invite + shape-proxy + electric-db-url composer, issues 058/080), ECS::Service count still 1', () => {
    const { apiTemplate } = synth(false);
    apiTemplate.resourceCountIs('AWS::ECS::Service', 1);
    apiTemplate.resourceCountIs('AWS::Lambda::Function', 5); // write-path + accept-invite (080) + shape-proxy + electric-db-url composer + its cr.Provider framework Lambda
  });

  it('creates no debug-token secret in the Api stack\'s own template — only Electric\'s own two secrets (issue 058) remain', () => {
    const { apiTemplate } = synth(false);
    apiTemplate.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  it('adds no /debug/db/* ALB listener rule — only /sync*, /write*, and /accept*', () => {
    const { apiTemplate } = synth(false);
    apiTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
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

  it('never creates a debug SG ingress rule to Postgres — exactly the sync + write-path + accept-invite + shape-proxy rules (four, issues 058/080)', () => {
    const { apiTemplate } = synth(false);
    const rule5432 = apiTemplate.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(4);
  });
});
