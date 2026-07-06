import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

describe('NetworkStack (Gede-Test-Network)', () => {
  function synth() {
    const app = new cdk.App({ context: { 'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'] } });
    const { network } = buildAppStacks(app, 'test');
    return Template.fromStack(network);
  }

  it('provisions a VPC with 2 AZs, public + private + isolated subnets', () => {
    const template = synth();

    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs x 3 subnet groups (public, private, isolated) = 6 subnets
    // (issue 030 adds the "private" compute tier to the issue-040 shape).
    template.resourceCountIs('AWS::EC2::Subnet', 6);
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
  });

  it('has 2 private (compute) and 2 isolated (data) subnets, tagged accordingly', () => {
    const template = synth();
    const privateSubnets = template.findResources('AWS::EC2::Subnet', {
      Properties: { Tags: Match.arrayWith([{ Key: 'aws-cdk:subnet-name', Value: 'private' }]) },
    });
    const isolatedSubnets = template.findResources('AWS::EC2::Subnet', {
      Properties: { Tags: Match.arrayWith([{ Key: 'aws-cdk:subnet-name', Value: 'isolated' }]) },
    });
    expect(Object.keys(privateSubnets)).toHaveLength(2);
    expect(Object.keys(isolatedSubnets)).toHaveLength(2);
  });

  it('cost guard: creates exactly one NAT gateway (single-AZ compute egress in `test`)', () => {
    const template = synth();
    // Issue 030 (ADR-0008) requires v2 compute egress, so the issue-040
    // zero-NAT guard becomes a one-NAT guard: not zero (v1's static-only
    // shape) and not one-per-AZ (the more expensive default `natGateways:
    // subnetConfiguration.length` would produce).
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('routes public subnets to the Internet Gateway, private subnets to the NAT gateway, and isolated subnets nowhere', () => {
    const template = synth();
    const routes = template.findResources('AWS::EC2::Route', {
      Properties: { DestinationCidrBlock: '0.0.0.0/0' },
    });
    // 2 public route tables -> IGW, 2 private route tables -> the single NAT
    // gateway. The 2 isolated route tables get no 0.0.0.0/0 route at all —
    // unchanged from issue 040's guarantee.
    expect(Object.keys(routes)).toHaveLength(4);

    const properties = Object.values(routes).map(
      (route) => (route as { Properties: Record<string, unknown> }).Properties,
    );
    const gatewayRoutes = properties.filter((p) => p.GatewayId !== undefined);
    const natRoutes = properties.filter((p) => p.NatGatewayId !== undefined);
    expect(gatewayRoutes).toHaveLength(2);
    expect(natRoutes).toHaveLength(2);
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
