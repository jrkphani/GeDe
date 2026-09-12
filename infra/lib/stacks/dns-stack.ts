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
 * Only SES sends as `@<domain>` (share mail from `no-reply@`, Cognito once SES is out of the
 * sandbox), so the apex SPF names SES and nothing else and fails everything else. AuthStack's
 * `EmailIdentity` already writes the DKIM CNAMEs and the `mail.<domain>` MAIL FROM records.
 */
export const SPF_RECORD = 'v=spf1 include:amazonses.com -all';

/**
 * DMARC on the apex so a spoofed `no-reply@<domain>` is quarantined by receivers that check
 * (#116). Aggregate reports go to the alerts mailbox; there is no forensic (`ruf`) address.
 */
export function dmarcRecord(config: EnvConfig): string {
  return `v=DMARC1; p=quarantine; rua=mailto:${config.alertsEmail}`;
}

/**
 * Alias records into the (pre-existing) hosted zone. Deployed last so DNS never points at
 * something that is not there yet: apex + www → CloudFront (A + AAAA, CloudFront is
 * dual-stack), api + ws → ALB (A only: the VPC has no IPv6 block, so the ALB is IPv4).
 * Plus the mail authentication TXT records at the apex (SPF) and `_dmarc`.
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

    // A zone holds one TXT record set per name; the apex had none before this (checked
    // 2026-09-13), so a second SPF-bearing TXT at the apex must be added here, not by hand.
    new route53.TxtRecord(this, 'ApexSpf', { zone, values: [SPF_RECORD] });
    new route53.TxtRecord(this, 'Dmarc', {
      zone,
      recordName: '_dmarc',
      values: [dmarcRecord(config)],
    });
  }
}
