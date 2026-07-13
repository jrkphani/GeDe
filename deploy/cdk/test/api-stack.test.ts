import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('ApiStack (Gede-Test-Api)', () => {
  function synth() {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { api } = buildAppStacks(app, 'test');
    return Template.fromStack(api);
  }

  it('the ALB is internet-facing, in the public subnets', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
    const albs = template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer');
    const [alb] = Object.values(albs) as Array<{ Properties: { Subnets: Array<{ 'Fn::ImportValue': string }> } }>;
    for (const subnet of alb.Properties.Subnets) {
      expect(subnet['Fn::ImportValue']).toEqual(expect.stringMatching(/publicSubnet/));
    }
  });

  it('creates an ECS Fargate cluster with exactly one service (the real ElectricSQL sync service, issue 058 — auth moved to Cognito, issue 033/ADR-0009)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.hasResourceProperties('AWS::ECS::Service', { LaunchType: 'FARGATE' });
  });

  it('the stub services run in the private (NAT-egress) subnets, not public or isolated, with no public IP', () => {
    const template = synth();
    const services = template.findResources('AWS::ECS::Service');
    for (const service of Object.values(services) as Array<{
      Properties: {
        NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: string; Subnets: Array<{ 'Fn::ImportValue': string }> } };
      };
    }>) {
      const netConfig = service.Properties.NetworkConfiguration.AwsvpcConfiguration;
      expect(netConfig.AssignPublicIp).toBe('DISABLED');
      for (const subnet of netConfig.Subnets) {
        expect(subnet['Fn::ImportValue']).toEqual(expect.stringMatching(/privateSubnet/));
      }
    }
  });

  it('the Electric task has its own ECS-level container healthcheck (issue 058) — but is NEVER an ALB target group (Electric\'s HTTP API has no per-request auth of its own; see api-stack.ts\'s class doc)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ HealthCheck: Match.objectLike({ Command: Match.anyValue() }) }),
      ]),
    });
    // Every ALB target group in this stack is Lambda-typed (write-path +
    // shape-proxy) — none references the Electric ECS service/task directly.
    const targetGroups = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup')) as Array<{
      Properties: { TargetType: string };
    }>;
    expect(targetGroups.length).toBeGreaterThan(0);
    for (const tg of targetGroups) {
      expect(tg.Properties.TargetType).toBe('lambda');
    }
  });

  it('the Electric service is registered on a private Cloud Map DNS name (issue 058) — reachable only from inside the VPC, not the public ALB', () => {
    const template = synth();
    template.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: 'gede.internal' });
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'sync' });
  });

  it('uses the real ElectricSQL image on the sync slot (issue 058) — never the nginx:alpine placeholder', () => {
    const template = synth();
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const images = Object.values(taskDefs).map(
      (t) => (t as { Properties: { ContainerDefinitions: Array<{ Image: string }> } }).Properties.ContainerDefinitions[0].Image,
    );
    expect(images).toHaveLength(1);
    for (const image of images) {
      expect(image).toMatch(/electricsql\/electric/);
      expect(image).not.toMatch(/nginx/);
    }
  });

  it('the Electric container reads DATABASE_URL and ELECTRIC_SECRET via ECS-native secret resolution (issue 058) — never a plaintext env var', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'DATABASE_URL' }),
            Match.objectLike({ Name: 'ELECTRIC_SECRET' }),
          ]),
        }),
      ]),
    });
  });

  it('routes /sync*, /write*, and /accept* via distinct ALB listener rules; there is no /auth* route (Cognito replaces it, issue 033/ADR-0009)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/sync*'] } })]),
    });
    const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Properties: {
        Conditions: Match.arrayWith([Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/auth*'] } })]),
      },
    });
    expect(Object.keys(rules)).toHaveLength(0);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/write*'] } })]),
    });
    // Issue 080 — the dedicated accept-invite route.
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/accept*'] } })]),
    });
  });

  it('routes /accept* to a Lambda target group (issue 080) with health checks disabled', () => {
    const template = synth();
    const acceptRule = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Properties: {
        Conditions: Match.arrayWith([Match.objectLike({ Field: 'path-pattern', PathPatternConfig: { Values: ['/accept*'] } })]),
      },
    });
    expect(Object.keys(acceptRule)).toHaveLength(1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'lambda',
      HealthCheckEnabled: false,
    });
  });

  it('grants the Data stack\'s RDS security group ingress from exactly the four Api-owned security groups on 5432 — never 0.0.0.0/0', () => {
    const template = synth();
    // Four rules now: the Fargate compute SG (the real Electric service,
    // issue 058), the write-path Lambda's own SG (issue 043), the
    // shape-proxy Lambda's own SG (issue 058, for workspace-membership
    // lookups), and the accept-invite Lambda's own SG (issue 080) — each a
    // separate, independent ingress grant rather than reusing one SG for
    // multiple tiers, so each can be tightened/removed independently later.
    const rule5432 = template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(4);
    for (const rule of Object.values(rule5432) as Array<{
      Properties: { CidrIp?: string; SourceSecurityGroupId?: unknown; GroupId: { 'Fn::ImportValue': string } };
    }>) {
      expect(rule.Properties.CidrIp).toBeUndefined();
      expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
      // Both rules target the Data stack's (imported) security group,
      // proving the reference is one-directional (Api -> Data), never the
      // reverse.
      expect(rule.Properties.GroupId['Fn::ImportValue']).toEqual(expect.stringMatching(/^Gede-Test-Data:/));
    }
  });

  it('no 0.0.0.0/0 ingress rule ever targets port 5432 (only the ALB\'s port 80 is internet-open, by design)', () => {
    const template = synth();
    const allIngress = {
      ...template.findResources('AWS::EC2::SecurityGroupIngress'),
      ...template.findResources('AWS::EC2::SecurityGroup'), // inline ingress on the ALB SG itself
    };
    for (const resource of Object.values(allIngress) as Array<{ Properties: Record<string, unknown> }>) {
      const props = resource.Properties;
      const inlineRules = (props.SecurityGroupIngress as Array<Record<string, unknown>> | undefined) ?? [
        props as Record<string, unknown>,
      ];
      for (const rule of inlineRules) {
        if (rule.CidrIp === '0.0.0.0/0') {
          expect(rule.FromPort).not.toBe(5432);
        }
      }
    }
  });

  it('carries the four app-wide tags on the cluster, ALB, and services', () => {
    const template = synth();
    const expectedTags = Match.arrayWith([
      { Key: 'Application', Value: 'GeDe' },
      { Key: 'Environment', Value: 'test' },
      { Key: 'ManagedBy', Value: 'CDK' },
      { Key: 'Organization', Value: 'quadnomics' },
    ]);
    template.hasResourceProperties('AWS::ECS::Cluster', { Tags: expectedTags });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Tags: expectedTags });
    template.hasResourceProperties('AWS::ECS::Service', { Tags: expectedTags });
  });

  it('cost guard: single-listener/ALB (no per-AZ duplication)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  });

  it('issue 076: the ALB has an explicit 60s idle timeout — >= the shape-proxy Lambda\'s 30s timeout, so the ALB never cuts the connection before the Lambda itself would', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        Match.objectLike({ Key: 'idle_timeout.timeout_seconds', Value: '60' }),
      ]),
    });
  });

  it('issue 076: the shape-proxy Lambda\'s timeout is 30s — above Electric\'s ~20s long-poll hold (was 15s, which fired first and severed the fetch, causing ALB 502s)', () => {
    const template = synth();
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
      Properties: { Environment?: { Variables: Record<string, unknown> }; Timeout?: number };
    }>;
    const shapeProxyFn = fns.find((f) => f.Properties.Environment?.Variables.ELECTRIC_INTERNAL_URL !== undefined);
    expect(shapeProxyFn).toBeDefined();
    expect(shapeProxyFn!.Properties.Timeout).toBe(30);
  });

  it('the Electric Fargate service runs 1 always-on task (desiredCount 1) — verified live: logical replication was already active, the task acquired its replication slot and streamed from Postgres cleanly', () => {
    const template = synth();
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  });

  it('the Electric Fargate service has no LoadBalancers property (Cloud Map only, never an ALB target — issue 058\'s whole point, and the exact shape mismatch that made the 030 stub\'s logical id unreusable)', () => {
    const template = synth();
    const services = template.findResources('AWS::ECS::Service');
    const [service] = Object.values(services) as Array<{ Properties: Record<string, unknown> }>;
    expect(service.Properties.LoadBalancers).toBeUndefined();
  });

  describe('Write-path API (issue 043, ADR-0010) — cost/shape guard (test-first plan item 6)', () => {
    // Issue 058 added two more Lambdas alongside the write-path one
    // (ShapeProxyFunction + ElectricDbUrlComposerFunction, the latter's
    // cr.Provider also synthesizes its own framework Lambda) - a bare
    // `Object.values(fns)` destructure of "the one Lambda" no longer
    // identifies the write-path function specifically. This helper finds it
    // by its distinguishing env vars (COGNITO_ISSUER + DATABASE_SECRET_ARN,
    // but NOT ELECTRIC_INTERNAL_URL, which only the shape-proxy carries).
    function findWriteApiFunction(template: ReturnType<typeof synth>) {
      const fns = Object.values(template.findResources('AWS::Lambda::Function')) as Array<{
        Properties: {
          Code: Record<string, unknown>;
          Environment?: { Variables: Record<string, unknown> };
          VpcConfig?: { SubnetIds: unknown; SecurityGroupIds: string[] };
        };
      }>;
      const fn = fns.find(
        (f) =>
          f.Properties.Environment?.Variables.COGNITO_ISSUER !== undefined &&
          f.Properties.Environment.Variables.ELECTRIC_INTERNAL_URL === undefined,
      );
      expect(fn).toBeDefined();
      return fn!;
    }

    it('is a Lambda function, not another Fargate/ECS service — the ECS::Service count stays at 1 (the real Electric sync service, issue 058; auth removed per 033/ADR-0009)', () => {
      const template = synth();
      template.resourceCountIs('AWS::ECS::Service', 1);
      // write-path + accept-invite (issue 080) + shape-proxy +
      // electric-db-url composer + its cr.Provider framework Lambda (issue
      // 058; debugApi is off by default in this describe block's plain
      // `synth()`).
      template.resourceCountIs('AWS::Lambda::Function', 5);
      template.hasResourceProperties('AWS::Lambda::Function', { Runtime: Match.stringLikeRegexp('nodejs20') });
    });

    it('bundles the REAL write-path handler (esbuild asset, not the issue-043 inline 503 stub) — issue 046', () => {
      const template = synth();
      const fn = findWriteApiFunction(template);
      // The issue-043 stub was `lambda.Code.fromInline(...)`, which renders
      // as a literal `ZipFile` string in the template. The bundled
      // NodejsFunction instead renders as an S3 asset reference.
      expect(fn.Properties.Code.ZipFile).toBeUndefined();
      expect(JSON.stringify(fn.Properties.Code.ZipFile ?? '')).not.toContain('write-path not yet wired');
      expect(fn.Properties.Code.S3Bucket).toBeDefined();
      expect(fn.Properties.Code.S3Key).toBeDefined();
    });

    it('wires COGNITO_ISSUER as a cross-stack reference to the Auth User Pool — never a hardcoded/PLACEHOLDER string (issue 046)', () => {
      const template = synth();
      const fn = findWriteApiFunction(template);
      const issuer = fn.Properties.Environment!.Variables.COGNITO_ISSUER;
      const issuerJson = JSON.stringify(issuer);
      expect(issuerJson).not.toContain('PLACEHOLDER_USER_POOL_ID');
      // A genuine cross-stack reference resolves through an Fn::ImportValue
      // (or equivalent token) naming the Auth stack, not a literal string.
      expect(issuerJson).toContain('Gede-Test-Auth');
    });

    it('routes to the Lambda via an ALB target group of TargetType Lambda, with its health check disabled (cost: no synthetic-invocation billing)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        TargetType: 'lambda',
        HealthCheckEnabled: false,
      });
    });

    it('the Lambda runs inside the VPC\'s private (NAT-egress) subnets, with its own security group — not the compute SG the Electric service uses', () => {
      const template = synth();
      const fn = findWriteApiFunction(template);
      expect(fn.Properties.VpcConfig).toBeDefined();
      expect(fn.Properties.VpcConfig?.SubnetIds).toBeDefined();
    });

    it('the write-path + accept-invite + shape-proxy Lambdas\' security groups each ingress to the Data stack\'s Postgres SG, distinct from the Fargate compute SG\'s rule (issue 080: four distinct SGs now, not three)', () => {
      const template = synth();
      const rule5432 = template.findResources('AWS::EC2::SecurityGroupIngress', {
        Properties: { FromPort: 5432, ToPort: 5432 },
      });
      const sourceIds = (Object.values(rule5432) as Array<{ Properties: { SourceSecurityGroupId: { 'Fn::GetAtt': [string, string] } } }>).map(
        (r) => r.Properties.SourceSecurityGroupId['Fn::GetAtt'][0],
      );
      expect(new Set(sourceIds).size).toBe(4); // compute (Electric) + write-path + shape-proxy + accept-invite — four distinct security groups
    });

    it('is granted read-only access to exactly the Data stack\'s database secret (least privilege — no wildcard resource)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([Match.stringLikeRegexp('secretsmanager:GetSecretValue')]),
              Effect: 'Allow',
              Resource: Match.objectLike({ 'Fn::ImportValue': Match.stringLikeRegexp('^Gede-Test-Data:') }),
            }),
          ]),
        },
      });
    });

    it('carries the four app-wide tags on the write-path Lambda and its security group', () => {
      const template = synth();
      const expectedTags = Match.arrayWith([
        { Key: 'Application', Value: 'GeDe' },
        { Key: 'Environment', Value: 'test' },
        { Key: 'ManagedBy', Value: 'CDK' },
        { Key: 'Organization', Value: 'quadnomics' },
      ]);
      template.hasResourceProperties('AWS::Lambda::Function', { Tags: expectedTags });
      template.hasResourceProperties('AWS::EC2::SecurityGroup', { Tags: expectedTags });
    });
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
