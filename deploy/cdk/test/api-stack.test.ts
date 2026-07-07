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

  it('creates an ECS Fargate cluster with exactly one service (the sync stub slot — auth moved to Cognito, issue 033/ADR-0009)', () => {
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

  it('each stub service has a container healthcheck and an ALB-managed, health-checked target group', () => {
    const template = synth();
    // 2 target groups: the sync Fargate stub (issue 030; auth removed per 033/
    // ADR-0009) PLUS the issue 043 write-path Lambda target group (asserted
    // separately below, in the "Write-path API" describe block).
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ HealthCheck: Match.objectLike({ Command: Match.anyValue() }) }),
      ]),
    });
  });

  it('uses the clearly-marked nginx placeholder image on the sync stub slot — 032 replaces it', () => {
    const template = synth();
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const images = Object.values(taskDefs).map(
      (t) => (t as { Properties: { ContainerDefinitions: Array<{ Image: string }> } }).Properties.ContainerDefinitions[0].Image,
    );
    expect(images).toHaveLength(1);
    for (const image of images) {
      expect(image).toMatch(/nginx/);
    }
  });

  it('routes /sync* and /write* via distinct ALB listener rules; there is no /auth* route (Cognito replaces it, issue 033/ADR-0009)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 2);
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
  });

  it('grants the Data stack\'s RDS security group ingress from exactly the two Api-owned security groups on 5432 — never 0.0.0.0/0', () => {
    const template = synth();
    // Two rules now: the Fargate compute SG (sync/auth stub slots, issue
    // 030) and the write-path Lambda's own SG (issue 043) — added as
    // separate, independent ingress grants rather than reusing one SG for
    // both tiers, so each can be tightened/removed independently later.
    const rule5432 = template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(2);
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

  it('cost guard: each stub service runs a single task, single-listener/ALB (no per-AZ duplication)', () => {
    const template = synth();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    const services = template.findResources('AWS::ECS::Service');
    for (const service of Object.values(services) as Array<{ Properties: { DesiredCount: number } }>) {
      expect(service.Properties.DesiredCount).toBe(1);
    }
  });

  describe('Write-path API (issue 043, ADR-0010) — cost/shape guard (test-first plan item 6)', () => {
    it('is a Lambda function, not another Fargate/ECS service — the ECS::Service count stays at 1 (the sync stub slot; auth removed per 033/ADR-0009)', () => {
      const template = synth();
      template.resourceCountIs('AWS::ECS::Service', 1);
      template.resourceCountIs('AWS::Lambda::Function', 1);
      template.hasResourceProperties('AWS::Lambda::Function', { Runtime: Match.stringLikeRegexp('nodejs20') });
    });

    it('routes to the Lambda via an ALB target group of TargetType Lambda, with its health check disabled (cost: no synthetic-invocation billing)', () => {
      const template = synth();
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
        TargetType: 'lambda',
        HealthCheckEnabled: false,
      });
    });

    it('the Lambda runs inside the VPC\'s private (NAT-egress) subnets, with its own security group — not the compute SG shared by the stub services', () => {
      const template = synth();
      const fns = template.findResources('AWS::Lambda::Function');
      const [fn] = Object.values(fns) as Array<{
        Properties: { VpcConfig?: { SubnetIds: unknown; SecurityGroupIds: string[] } };
      }>;
      expect(fn?.Properties.VpcConfig).toBeDefined();
      expect(fn?.Properties.VpcConfig?.SubnetIds).toBeDefined();
    });

    it('the write-path Lambda\'s security group ingresses to the Data stack\'s Postgres SG, distinct from the Fargate compute SG\'s rule', () => {
      const template = synth();
      const rule5432 = template.findResources('AWS::EC2::SecurityGroupIngress', {
        Properties: { FromPort: 5432, ToPort: 5432 },
      });
      const sourceIds = (Object.values(rule5432) as Array<{ Properties: { SourceSecurityGroupId: { 'Fn::GetAtt': [string, string] } } }>).map(
        (r) => r.Properties.SourceSecurityGroupId['Fn::GetAtt'][0],
      );
      expect(new Set(sourceIds).size).toBe(2); // two distinct security groups, not the same one twice
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
