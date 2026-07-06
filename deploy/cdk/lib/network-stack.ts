import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * `Gede-Test-Network` — the account's network foundation (issue 040, scope
 * item 1).
 *
 * v1 is a 100% static PWA (S3 + CloudFront, both serverless) — nothing in
 * this stack sits on the static app's request path. This VPC exists purely
 * as a forward-looking foundation for v2 compute (docs/DEPLOYMENT.md §9),
 * so v2 attaches without re-architecting the network layer.
 *
 * Cost note (TECH_STACK criterion 2 — lowest AWS cost): a NAT Gateway costs
 * ~$32/month per AZ plus data-processing charges, and nothing in v1 needs
 * private-subnet egress to the internet (there is no server). We therefore
 * provision `natGateways: 0` and rely on public + isolated subnets only.
 * Isolated subnets have no route to the internet at all (not even via a NAT),
 * which is stricter than "private with NAT" and correctly reflects that
 * nothing lives there yet. When v2 compute needs outbound internet access
 * (pulling container images, OS updates, ACME/API calls), that is the
 * trigger to add a NAT Gateway + swap isolated for private-with-egress
 * subnets — a deliberate, reviewed cost decision, not a default.
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
      natGateways: 0, // Cost guard — see class doc. Asserted in network-stack.test.ts.
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
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
