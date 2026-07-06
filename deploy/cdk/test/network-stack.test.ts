import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

describe('NetworkStack (Gede-Test-Network)', () => {
  function synth() {
    const app = new cdk.App({ context: { 'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'] } });
    const { network } = buildAppStacks(app, 'test');
    return Template.fromStack(network);
  }

  it('provisions a VPC with 2 AZs, public + isolated subnets', () => {
    const template = synth();

    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs x 2 subnet groups (public, isolated) = 4 subnets.
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
  });

  it('cost guard: creates zero NAT gateways', () => {
    const template = synth();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('has no route to the internet from the isolated subnets (no NAT/IGW route)', () => {
    const template = synth();
    // Only the 2 public-subnet route tables should have a 0.0.0.0/0 route
    // (to the Internet Gateway); the 2 isolated-subnet route tables must not.
    const routes = template.findResources('AWS::EC2::Route', {
      Properties: { DestinationCidrBlock: '0.0.0.0/0' },
    });
    expect(Object.keys(routes)).toHaveLength(2);
    for (const route of Object.values(routes)) {
      expect((route as { Properties: Record<string, unknown> }).Properties).toEqual(
        expect.objectContaining({ GatewayId: expect.anything() }),
      );
    }
  });

  it('carries the four app-wide tags on the VPC', () => {
    const template = synth();
    template.hasResourceProperties('AWS::EC2::VPC', {
      // CDK emits tags alphabetically by key; `arrayWith` matches as an
      // ordered subsequence, so list these in that order.
      Tags: Match.arrayWith([
        { Key: 'Application', Value: 'GeDe' },
        { Key: 'Environment', Value: 'test' },
        { Key: 'ManagedBy', Value: 'CDK' },
        { Key: 'Organization', Value: 'quadnomics' },
      ]),
    });
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
