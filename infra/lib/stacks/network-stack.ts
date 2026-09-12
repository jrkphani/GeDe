import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { AVAILABILITY_ZONES } from '../config.js';

/**
 * One VPC, two AZs, no NAT gateway.
 *
 * NAT is deliberately absent (≈ US$35/mo per AZ, the single largest avoidable line at this
 * scale). Consequences, accepted by design:
 *  - The Fargate service runs in the PUBLIC subnets with `assignPublicIp: true` so it can
 *    reach ECR, CloudWatch Logs, Secrets Manager and Cognito over the internet gateway.
 *    Its security group admits nothing but the ALB security group on the container port,
 *    so a public IP does not mean a public service.
 *  - RDS sits in the ISOLATED subnets (no route to the internet at all) and only admits
 *    the service security group on 5432.
 *  - S3 traffic (document snapshots) rides the gateway endpoint and never leaves the
 *    AWS network, which also keeps it off the NAT/IGW data-transfer bill.
 *
 * Growth step: when a private-only service is wanted, add `natGateways: 1`, a
 * PRIVATE_WITH_EGRESS subnet group, and move the service there. Nothing else changes.
 */
export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      availabilityZones: [...AVAILABILITY_ZONES],
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });
  }
}
