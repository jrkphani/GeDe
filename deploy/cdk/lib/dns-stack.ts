import { Stack, StackProps, CfnOutput, Fn } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

export interface DnsStackProps extends StackProps {
  /**
   * The custom domain to serve on. Undefined (the `test` default) => this
   * stack is an inert pass-through: no hosted zone, no cert, just the
   * CloudFront URL as an output (issue 040 scope item 3).
   */
  domainName?: string;
  /** The Hosting stack's distribution — always required so the CloudFront
   * URL can be surfaced as an output even in the no-domain case. */
  distribution: cloudfront.IDistribution;
}

/**
 * `Gede-Test-Dns` — the Route 53 seam (issue 040, scope item 3).
 *
 * Seam design / "clean interface" (issue 040 implementation note):
 * - No `domainName` (default): pure pass-through, outputs the CloudFront
 *   URL. No `AWS::Route53::HostedZone`, no ACM cert — a hosted zone with no
 *   delegated domain is inert, and ACM can't DNS-validate a domain we don't
 *   control.
 * - `domainName` supplied: this stack CREATES a new public hosted zone
 *   (docs/DEPLOYMENT.md §7 has the operator register the domain elsewhere
 *   and delegate its NS records to this zone — so we create, not look up),
 *   a DNS-validated ACM certificate in us-east-1 (validated against that
 *   same zone — no live AWS lookup needed at synth time, so `cdk synth`
 *   stays offline-safe), and A/AAAA alias records pointing at the
 *   distribution.
 *
 * Chicken-and-egg note: CloudFront needs the certificate ARN *at
 * distribution-creation time* to attach the domain as an alternate name,
 * but this stack's cert can only be created after Hosting exists (avoiding
 * a circular stack dependency: Dns depends on Hosting's distribution for
 * alias records, so Hosting cannot also depend on Dns for the cert without
 * a cycle). The documented flip (see deploy/cdk/README.md) is therefore
 * two `cdk deploy` passes: (1) deploy Dns with `-c domainName=...` to
 * create the zone + cert, note the cert ARN output; (2) redeploy Hosting
 * with `-c domainName=... -c certificateArn=...` so the distribution picks
 * up the alternate name + cert (CloudFront updates in place, no
 * replacement); Dns's alias records already point at the distribution from
 * step 1 and need no further changes.
 */
export class DnsStack extends Stack {
  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    if (!props.domainName) {
      new CfnOutput(this, 'AppUrl', {
        value: `https://${props.distribution.distributionDomainName}`,
        description: 'The test-env app URL (CloudFront default domain; no custom domain configured).',
      });
      return;
    }

    const domainName = props.domainName;

    const zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: domainName,
      comment: `GeDe ${domainName} — created by CDK (Gede-Test-Dns). Delegate the registrar's NS records here.`,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(props.distribution));

    new route53.ARecord(this, 'AliasRecordA', {
      zone,
      recordName: domainName,
      target: aliasTarget,
    });
    new route53.AaaaRecord(this, 'AliasRecordAAAA', {
      zone,
      recordName: domainName,
      target: aliasTarget,
    });

    new CfnOutput(this, 'HostedZoneNameServers', {
      // `hostedZoneNameServers` is a token list — must go through `Fn.join`,
      // not `Array.prototype.join`, or CFN emits a corrupted encoded token.
      value: Fn.join(', ', zone.hostedZoneNameServers ?? []),
      description: "Delegate the domain registrar's NS records to these.",
    });
    new CfnOutput(this, 'CertificateArn', {
      value: certificate.certificateArn,
      description:
        'Feed this back into Gede-Test-Hosting as `-c certificateArn=<arn>` (with `-c domainName=...`) to attach the alternate name — see README "domain-flip".',
    });
    new CfnOutput(this, 'AppUrl', {
      value: `https://${domainName}`,
      description: 'The custom-domain app URL (active once Hosting is redeployed with the certificate).',
    });
  }
}
