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

/**
 * us-east-1 only: the CloudFront certificate and the CLOUDFRONT-scoped web ACL.
 * Consumed cross-region by WebStack (`crossRegionReferences: true` on both sides).
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
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: `gede-${config.envName}-common-rules`,
          },
        },
      ],
    });
  }
}
