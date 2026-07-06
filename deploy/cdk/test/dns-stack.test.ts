import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('DnsStack (Gede-Test-Dns) — no domain (the `test` default)', () => {
  function synth() {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { dns } = buildAppStacks(app, 'test');
    return Template.fromStack(dns);
  }

  it('creates no hosted zone and no ACM certificate', () => {
    const template = synth();
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('outputs the CloudFront URL as the app address', () => {
    const template = synth();
    const outputs = template.toJSON().Outputs as Record<string, { Description?: string }>;
    expect(outputs.AppUrl).toBeDefined();
    expect(outputs.AppUrl.Description).toMatch(/CloudFront default domain/);
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(template.toJSON()).toMatchSnapshot();
  });
});

describe('DnsStack (Gede-Test-Dns) — domainName supplied (the flip)', () => {
  function synth() {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { dns } = buildAppStacks(app, 'test', 'app.example.com');
    return Template.fromStack(dns);
  }

  it('creates a public hosted zone for the domain', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'app.example.com.',
    });
  });

  it('creates a DNS-validated ACM certificate (region is the stack region, us-east-1)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'app.example.com',
      ValidationMethod: 'DNS',
    });
    // The stack itself is pinned to us-east-1 for the `test` env (required
    // for CloudFront-attached ACM certs) — assert the stack's own region.
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { dns } = buildAppStacks(app, 'test', 'app.example.com');
    expect(dns.region).toBe('us-east-1');
  });

  it('creates A and AAAA alias records pointing at the distribution', () => {
    const template = synth();
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue() }),
    });
  });

  it('carries the four app-wide tags on the hosted zone', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      // CDK emits tags alphabetically by key; `arrayWith` matches as an
      // ordered subsequence, so list these in that order.
      HostedZoneTags: Match.arrayWith([
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
