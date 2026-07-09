import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';
import { normalizeAssetHashes } from './normalize-asset-hashes';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('MigrationStack (Gede-Test-Migrations) — issue 045', () => {
  function synth() {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { migrations } = buildAppStacks(app, 'test');
    return Template.fromStack(migrations);
  }

  function findRunnerFunctions(template: Template) {
    return template.findResources('AWS::Lambda::Function', {
      Properties: { Environment: Match.objectLike({ Variables: Match.objectLike({ DATABASE_SECRET_ARN: Match.anyValue() }) }) },
    });
  }

  it('runs the migration runner Lambda inside the VPC (the RDS has no public route — DEPLOYMENT.md §9)', () => {
    const template = synth();
    const runnerFns = Object.values(findRunnerFunctions(template)) as Array<{
      Properties: { VpcConfig?: { SubnetIds: unknown; SecurityGroupIds: unknown } };
    }>;
    expect(runnerFns).toHaveLength(1);
    expect(runnerFns[0].Properties.VpcConfig).toBeDefined();
    expect(runnerFns[0].Properties.VpcConfig?.SubnetIds).toBeDefined();
  });

  it('the runner\'s subnets are the private (NAT-egress) tier, not public or isolated', () => {
    const template = synth();
    const [fn] = Object.values(findRunnerFunctions(template)) as Array<{
      Properties: { VpcConfig?: { SubnetIds: Array<{ 'Fn::ImportValue': string }> } };
    }>;
    for (const subnet of fn.Properties.VpcConfig?.SubnetIds ?? []) {
      expect(subnet['Fn::ImportValue']).toEqual(expect.stringMatching(/privateSubnet/));
    }
  });

  it('is a bundled Lambda (esbuild asset), never inline code — applies the real src/db/migrations/*.sql, no forked SQL', () => {
    const template = synth();
    const [fn] = Object.values(findRunnerFunctions(template)) as Array<{ Properties: { Code: Record<string, unknown> } }>;
    expect(fn.Properties.Code.ZipFile).toBeUndefined();
    expect(fn.Properties.Code.S3Bucket).toBeDefined();
    expect(fn.Properties.Code.S3Key).toBeDefined();
  });

  it('runtime is nodejs20.x', () => {
    const template = synth();
    const [fn] = Object.values(findRunnerFunctions(template)) as Array<{ Properties: { Runtime: string } }>;
    expect(fn.Properties.Runtime).toMatch(/^nodejs20/);
  });

  it('adds exactly one ingress rule to the Data security group, on 5432, never 0.0.0.0/0', () => {
    const template = synth();
    const rule5432 = template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432, ToPort: 5432 },
    });
    expect(Object.keys(rule5432)).toHaveLength(1);
    const [rule] = Object.values(rule5432) as Array<{
      Properties: { CidrIp?: string; SourceSecurityGroupId?: unknown; GroupId: { 'Fn::ImportValue': string } };
    }>;
    expect(rule.Properties.CidrIp).toBeUndefined();
    expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
    expect(rule.Properties.GroupId['Fn::ImportValue']).toEqual(expect.stringMatching(/^Gede-Test-Data:/));
  });

  it('drives a CloudFormation custom resource (one-shot, idempotent runner) via a Provider Lambda — not an always-on service', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::ECS::Cluster', 0);
  });

  it('the custom resource\'s trigger property is a content hash of the migration files — deterministic, never machine/time-based (issue 041 lesson)', () => {
    const template = synth();
    const resources = template.findResources('AWS::CloudFormation::CustomResource');
    const [resource] = Object.values(resources) as Array<{
      Properties: { MigrationSetHash?: string; MigrationFileCount?: number };
    }>;
    expect(resource.Properties.MigrationSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resource.Properties.MigrationFileCount).toBe(15); // 0000-0014 (issue 067 added 0014)

    // Determinism: synthesizing twice from the same (unchanged) source files
    // produces the identical hash.
    const again = synth();
    const [resourceAgain] = Object.values(again.findResources('AWS::CloudFormation::CustomResource')) as Array<{
      Properties: { MigrationSetHash?: string };
    }>;
    expect(resourceAgain.Properties.MigrationSetHash).toBe(resource.Properties.MigrationSetHash);
  });

  it('is granted read-only access to the Data stack\'s database secret (least privilege — no wildcard resource)', () => {
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

  it('carries the four app-wide tags on the runner Lambda and its security group', () => {
    const template = synth();
    const expectedTagsArray = [
      { Key: 'Application', Value: 'GeDe' },
      { Key: 'Environment', Value: 'test' },
      { Key: 'ManagedBy', Value: 'CDK' },
      { Key: 'Organization', Value: 'quadnomics' },
    ];
    const [fn] = Object.values(findRunnerFunctions(template)) as Array<{ Properties: { Tags?: unknown } }>;
    expect(fn.Properties.Tags).toEqual(expect.arrayContaining(expectedTagsArray));
    template.hasResourceProperties('AWS::EC2::SecurityGroup', { Tags: Match.arrayWith(expectedTagsArray) });
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(normalizeAssetHashes(template.toJSON())).toMatchSnapshot();
  });
});
