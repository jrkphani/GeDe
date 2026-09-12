import * as cdk from 'aws-cdk-lib';
import {
  type aws_cloudfront as cloudfront,
  type aws_elasticloadbalancingv2 as elbv2,
  aws_route53 as route53,
  aws_route53_targets as targets,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';

export interface DnsStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
  readonly distribution: cloudfront.IDistribution;
  readonly alb: elbv2.ILoadBalancerV2;
}

/**
 * Alias records into the (pre-existing) hosted zone. Deployed last so DNS never points at
 * something that is not there yet: apex + www → CloudFront (A + AAAA, CloudFront is
 * dual-stack), api + ws → ALB (A only: the VPC has no IPv6 block, so the ALB is IPv4).
 */
export class DnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: config.domain,
    });

    const web = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(props.distribution));
    const api = route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(props.alb));

    new route53.ARecord(this, 'ApexA', { zone, target: web });
    new route53.AaaaRecord(this, 'ApexAaaa', { zone, target: web });
    new route53.ARecord(this, 'WwwA', { zone, recordName: 'www', target: web });
    new route53.AaaaRecord(this, 'WwwAaaa', { zone, recordName: 'www', target: web });

    new route53.ARecord(this, 'ApiA', { zone, recordName: 'api', target: api });
    new route53.ARecord(this, 'WsA', { zone, recordName: 'ws', target: api });
  }
}
