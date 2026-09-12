import * as cdk from 'aws-cdk-lib';
import {
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';

export interface EdgeStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
}

/** Requests per source IP per 5-minute window before the WAF blocks that IP. */
export const RATE_LIMIT_PER_IP = 2000;

/** AWS managed rule groups on the distribution, in priority order after the rate rule. */
export const WAF_MANAGED_RULE_GROUPS: readonly string[] = [
  'AWSManagedRulesCommonRuleSet',
  'AWSManagedRulesKnownBadInputsRuleSet',
  'AWSManagedRulesAmazonIpReputationList',
];

/**
 * us-east-1 only: the CloudFront certificate and the CLOUDFRONT-scoped web ACL.
 * Consumed cross-region by WebStack (`crossRegionReferences: true` on both sides).
 *
 * The ACL sees every `/api/*` call and the SPA itself; since issue #33 the ALB refuses
 * `/api/*` without CloudFront's origin-verify header, so this is the only way in. The
 * WebSocket stays direct to the ALB (ADR-010) and is not covered here.
 */
export class EdgeStack extends cdk.Stack {
  readonly certificate: acm.Certificate;
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });
    const { config } = props;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: config.domain,
    });

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domain,
      subjectAlternativeNames: [`www.${config.domain}`],
      validation: acm.CertificateValidation.fromDns(zone),
    });

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `gede-${config.envName}-web`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: `gede-${config.envName}-web`,
      },
      rules: [
        // Cheapest check first: a flooding IP is blocked before the managed groups inspect it.
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: RATE_LIMIT_PER_IP, aggregateKeyType: 'IP' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: `gede-${config.envName}-rate-limit`,
          },
        },
        ...WAF_MANAGED_RULE_GROUPS.map((name, index): wafv2.CfnWebACL.RuleProperty => ({
          name,
          priority: index + 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: `gede-${config.envName}-${metricSuffix(name)}`,
          },
        })),
      ],
    });
  }
}

/** `AWSManagedRulesCommonRuleSet` → `common-rules` (keeps the pre-existing metric name). */
function metricSuffix(ruleGroup: string): string {
  return ruleGroup
    .replace(/^AWSManagedRules/, '')
    .replace(/RuleSet$/, 'Rules')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}
