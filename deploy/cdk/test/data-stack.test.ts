import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('DataStack (Gede-Test-Data)', () => {
  function synth() {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { data } = buildAppStacks(app, 'test');
    return Template.fromStack(data);
  }

  it('provisions RDS PostgreSQL 17 on db.t4g.micro', () => {
    const template = synth();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^17'),
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  it('is not publicly accessible, storage-encrypted, and single-AZ (cost guard, `test` env)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: false,
    });
  });

  it('has automated backups enabled and a retained-snapshot removal policy', () => {
    const template = synth();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: Match.anyValue(),
    });
    const instances = template.findResources('AWS::RDS::DBInstance');
    const [instance] = Object.values(instances) as Array<{ Properties: { BackupRetentionPeriod: number } }>;
    expect(instance.Properties.BackupRetentionPeriod).toBeGreaterThan(0);
    // RemovalPolicy.SNAPSHOT => DeletionPolicy/UpdateReplacePolicy = Snapshot.
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
    });
  });

  it('is placed in the Network stack\'s isolated subnets (cross-stack reference), not private or public', () => {
    const template = synth();
    const subnetGroups = template.findResources('AWS::RDS::DBSubnetGroup');
    const [subnetGroup] = Object.values(subnetGroups) as Array<{
      Properties: { SubnetIds: Array<{ 'Fn::ImportValue': string }> };
    }>;
    const subnetIds = subnetGroup.Properties.SubnetIds;
    expect(subnetIds).toHaveLength(2);
    for (const subnetId of subnetIds) {
      const importValue = subnetId['Fn::ImportValue'];
      expect(importValue).toEqual(expect.stringMatching(/^Gede-Test-Network:/));
      // CDK's auto-generated export names embed the source construct's
      // logical id (`VpcisolatedSubnet1Subnet...` / `...2Subnet...`) — this
      // is how we know the DB landed in the "isolated" subnet group and not
      // "private" or "public" without needing a live AWS account to check.
      expect(importValue).toEqual(expect.stringMatching(/isolatedSubnet/));
    }
  });

  it('credentials are generated into Secrets Manager (no standing secret in the repo)', () => {
    const template = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: Match.stringLikeRegexp('gede_admin'),
      }),
    });
  });

  it('the database security group has no ingress rules of its own — never 0.0.0.0/0 — the one permitted rule is added by the Api stack', () => {
    const template = synth();
    const ingressResources = template.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.keys(ingressResources)).toHaveLength(0);
    // Belt-and-braces: no *rule* (inline or standalone) in this stack's
    // template admits 0.0.0.0/0 — checked structurally (not a raw string
    // search, since the security group's own description text legitimately
    // mentions "0.0.0.0/0" in prose).
    const securityGroups = template.findResources('AWS::EC2::SecurityGroup');
    for (const sg of Object.values(securityGroups) as Array<{
      Properties: { SecurityGroupIngress?: Array<{ CidrIp?: string }> };
    }>) {
      for (const rule of sg.Properties.SecurityGroupIngress ?? []) {
        expect(rule.CidrIp).not.toBe('0.0.0.0/0');
      }
    }
  });

  it('carries the four app-wide tags on the database and its security group', () => {
    const template = synth();
    const expectedTags = Match.arrayWith([
      { Key: 'Application', Value: 'GeDe' },
      { Key: 'Environment', Value: 'test' },
      { Key: 'ManagedBy', Value: 'CDK' },
      { Key: 'Organization', Value: 'quadnomics' },
    ]);
    template.hasResourceProperties('AWS::RDS::DBInstance', { Tags: expectedTags });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', { Tags: expectedTags });
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
