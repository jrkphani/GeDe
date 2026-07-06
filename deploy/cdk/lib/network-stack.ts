import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * `Gede-Test-Network` — the account's network foundation (issue 040, scope
 * item 1; extended by issue 030 / ADR-0008 for the v2 backend).
 *
 * v1 is a 100% static PWA (S3 + CloudFront, both serverless) — nothing in
 * this stack sits on the static app's request path; the public + isolated
 * subnet tiers below are unused by v1 and cost nothing extra on their own.
 *
 * v2 (issue 030) turns this from a forward-looking foundation into a live
 * network: a NAT gateway + a PRIVATE_WITH_EGRESS ("private", compute) subnet
 * tier are added alongside the existing PUBLIC ("public") and
 * PRIVATE_ISOLATED ("isolated", data) tiers, per docs/DEPLOYMENT.md §9 and
 * ADR-0008. The isolated tier is unchanged — still no route to the internet
 * at all — and now hosts RDS (`Gede-Test-Data`); the new private tier hosts
 * the Fargate compute tier (`Gede-Test-Api`), egressing only via the NAT
 * gateway; the public tier now also carries the internet-facing ALB.
 *
 * Cost note (TECH_STACK criterion 2 — lowest AWS cost): a NAT Gateway costs
 * ~$32/month per AZ plus data-processing charges. We provision exactly
 * `natGateways: 1` (not one per AZ) — a single shared NAT for the `test`
 * env's compute egress, per DEPLOYMENT.md §9 ("one NAT gateway for test,
 * multi-AZ NAT only for prod"). A `prod` env should revisit this for
 * multi-AZ NAT redundancy.
 *
 * Deploy note: this change mutates the already-deployed `Gede-Test-Network`
 * stack (issue 040) on the next `cdk deploy` — CDK adds the NAT gateway +
 * new private subnets and their route tables in place; it does not replace
 * the VPC or the existing public/isolated subnets.
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      // Explicit AZs (not `maxAzs`) so `cdk synth` never triggers a live
      // "look up available AZs for this account/region" context call — this
      // app must synth with zero AWS credentials (issue 040 offline-synth
      // requirement). `us-east-1` always has these two AZs.
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      natGateways: 1, // Cost guard — see class doc. Asserted in network-stack.test.ts.
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Exported for a future v2 issue (compute stack) to import without
    // re-architecting the network layer.
    new CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${id}-VpcId`,
      description: 'VPC id — consumed by future v2 compute stacks.',
    });
  }
}
