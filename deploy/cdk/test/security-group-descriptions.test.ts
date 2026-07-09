import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

/**
 * The EC2 API's own charset restriction for security-group-family
 * `Description`/`GroupDescription` fields — enforced ONLY at deploy time
 * (the API call, not `cdk synth` or CloudFormation validation), which is why
 * this bug (issue 058, apostrophes in `ComputeSecurityGroup`/
 * `ShapeProxySecurityGroup`/`AllowComputeToPostgres` descriptions) shipped
 * past `cdk synth --all` and the jest snapshots and only failed at
 * `cdk deploy`, rolling the stack back. See
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateSecurityGroup.html
 * ("Valid characters are a-z, A-Z, 0-9, spaces, and ._-:/()#,@[]+=&;{}!$*").
 * This test makes the violation a synth-time (CI) failure instead, so it can
 * never again reach `cdk deploy` silently.
 */
const EC2_SG_DESCRIPTION_CHARSET = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{1,255}$/;

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

interface Violation {
  logicalId: string;
  type: string;
  field: string;
  value: string;
}

function checkDescription(logicalId: string, type: string, field: string, value: unknown, violations: Violation[]) {
  if (typeof value !== 'string') return; // tokens (Fn::Join etc.) resolve fine; only literal strings are checkable here
  if (!EC2_SG_DESCRIPTION_CHARSET.test(value)) {
    violations.push({ logicalId, type, field, value });
  }
}

/**
 * Walks every `AWS::EC2::SecurityGroup`, `AWS::EC2::SecurityGroupIngress`,
 * and `AWS::EC2::SecurityGroupEgress` resource in the template — including
 * the inline `SecurityGroupIngress`/`SecurityGroupEgress` rule arrays CDK's
 * `addIngressRule`/`addEgressRule` fold into the owning `SecurityGroup`
 * resource rather than emitting as standalone resources — and asserts every
 * description-like field is within the EC2 API's allowed charset.
 */
function findSecurityGroupDescriptionViolations(template: Template): Violation[] {
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  const violations: Violation[] = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    const props = resource.Properties ?? {};

    if (resource.Type === 'AWS::EC2::SecurityGroup') {
      checkDescription(logicalId, resource.Type, 'GroupDescription', props.GroupDescription, violations);

      for (const [field, key] of [
        ['SecurityGroupIngress', 'SecurityGroupIngress'],
        ['SecurityGroupEgress', 'SecurityGroupEgress'],
      ] as const) {
        const rules = props[key] as Array<Record<string, unknown>> | undefined;
        if (!rules) continue;
        rules.forEach((rule, i) => {
          checkDescription(logicalId, resource.Type, `${field}[${i}].Description`, rule.Description, violations);
        });
      }
    }

    if (resource.Type === 'AWS::EC2::SecurityGroupIngress' || resource.Type === 'AWS::EC2::SecurityGroupEgress') {
      checkDescription(logicalId, resource.Type, 'Description', props.Description, violations);
    }
  }

  return violations;
}

describe('EC2 security-group descriptions stay within the EC2 API\'s allowed charset (issue 058 regression)', () => {
  const app = new cdk.App({ context: TEST_CONTEXT });
  const { network, hosting, dns, data, api, auth, migrations } = buildAppStacks(app, 'test', 'app.example.com', undefined, true);

  it.each([
    ['Gede-Test-Network', () => Template.fromStack(network)],
    ['Gede-Test-Hosting', () => Template.fromStack(hosting)],
    ['Gede-Test-Dns', () => Template.fromStack(dns)],
    ['Gede-Test-Data', () => Template.fromStack(data)],
    ['Gede-Test-Api', () => Template.fromStack(api)],
    ['Gede-Test-Auth', () => Template.fromStack(auth)],
    ['Gede-Test-Migrations', () => Template.fromStack(migrations)],
  ])('%s: every SecurityGroup/SecurityGroupIngress/SecurityGroupEgress description matches the EC2 charset', (_name, getTemplate) => {
    const template = getTemplate();
    const violations = findSecurityGroupDescriptionViolations(template);

    expect(violations).toEqual([]);
  });
});
