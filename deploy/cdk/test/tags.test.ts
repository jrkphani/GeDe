import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

const REQUIRED_TAGS = [
  { Key: 'Organization', Value: 'quadnomics' },
  { Key: 'Application', Value: 'GeDe' },
  { Key: 'Environment', Value: 'test' },
  { Key: 'ManagedBy', Value: 'CDK' },
];

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

/**
 * Every CloudFormation resource type that supports *some* form of tagging
 * uses a `Tags` array of `{Key, Value}` — except Route 53 hosted zones,
 * which use `HostedZoneTags`. Custom::* resources (Lambda-backed CDK
 * providers, e.g. BucketDeployment's helper Lambda) do not accept tags in
 * their resource properties at all — CDK tags the underlying Lambda/IAM
 * role resources instead, which this test does verify.
 */
function tagArrayOf(resource: CfnResource): unknown {
  const props = resource.Properties ?? {};
  return props.Tags ?? props.HostedZoneTags;
}

describe('Tag strategy — every taggable resource carries the four app-wide tags', () => {
  const app = new cdk.App({ context: TEST_CONTEXT });
  const { network, hosting, dns, data, api, auth, migrations } = buildAppStacks(app, 'test', 'app.example.com');

  it.each([
    ['Gede-Test-Network', () => Template.fromStack(network)],
    ['Gede-Test-Hosting', () => Template.fromStack(hosting)],
    ['Gede-Test-Dns', () => Template.fromStack(dns)],
    ['Gede-Test-Data', () => Template.fromStack(data)],
    ['Gede-Test-Api', () => Template.fromStack(api)],
    ['Gede-Test-Auth', () => Template.fromStack(auth)],
    ['Gede-Test-Migrations', () => Template.fromStack(migrations)],
  ])('%s: all taggable resources carry Organization/Application/Environment/ManagedBy', (_name, getTemplate) => {
    const template = getTemplate();
    const resources = template.toJSON().Resources as Record<string, CfnResource>;

    const untagged: string[] = [];
    for (const [logicalId, resource] of Object.entries(resources)) {
      const tags = tagArrayOf(resource);
      if (tags === undefined) continue; // resource type doesn't support tags at all
      for (const required of REQUIRED_TAGS) {
        const found = (tags as unknown[]).some(
          (t) => JSON.stringify(t) === JSON.stringify(required),
        );
        if (!found) untagged.push(`${logicalId} (${resource.Type}) missing ${required.Key}=${required.Value}`);
      }
    }

    expect(untagged).toEqual([]);
  });
});
