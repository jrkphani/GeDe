import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

describe('HostingStack (Gede-Test-Hosting)', () => {
  function synth(domainName?: string) {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { hosting } = buildAppStacks(app, 'test', domainName);
    return Template.fromStack(hosting);
  }

  it('the S3 origin bucket blocks all public access', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('the distribution origin uses Origin Access Control (no OAI, no public bucket policy)', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            S3OriginConfig: { OriginAccessIdentity: '' },
            OriginAccessControlId: Match.anyValue(),
          }),
        ]),
      }),
    });
  });

  it('no domain => no Aliases and no ACM certificate on the distribution', () => {
    const template = synth();
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions);
    const config = (distribution as { Properties: { DistributionConfig: Record<string, unknown> } }).Properties
      .DistributionConfig;
    expect(config.Aliases).toBeUndefined();
    expect(config.ViewerCertificate).toBeUndefined();
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
  });

  it('has the §6.2 cache behaviors: immutable long-cache for hashed assets, no-cache default', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          CachePolicyId: Match.anyValue(),
          ResponseHeadersPolicyId: Match.anyValue(),
          Compress: true,
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: 'assets/*',
            ResponseHeadersPolicyId: Match.anyValue(),
            Compress: true,
          }),
        ]),
      }),
    });

    // The default (no-cache) policy: TTLs pinned to 0.
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 0,
        MinTTL: 0,
        MaxTTL: 0,
      }),
    });
    // The hashed-assets policy: 1-year (365-day) TTLs.
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 60 * 60 * 24 * 365,
        MinTTL: 60 * 60 * 24 * 365,
        MaxTTL: 60 * 60 * 24 * 365,
      }),
    });
  });

  it('sets the browser-facing Cache-Control header (not just edge TTL) via ResponseHeadersPolicy', () => {
    const template = synth();
    // A CachePolicy alone never reaches the browser — the shell must carry
    // `Cache-Control: no-cache` so the PWA update prompt is timely, and
    // hashed assets must carry `immutable` so the browser caches them for a
    // year. Assert the actual response headers, the mechanism the earlier
    // CachePolicy-only setup silently omitted.
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({ Header: 'Cache-Control', Value: 'no-cache', Override: true }),
          ]),
        },
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({
              Header: 'Cache-Control',
              Value: 'public, max-age=31536000, immutable',
              Override: true,
            }),
          ]),
        },
      }),
    });
  });

  it('routes SPA errors (403/404) to /index.html with a 200', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
  });

  it('enables HTTP/3 (+HTTP/2)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ HttpVersion: 'http2and3' }),
    });
  });

  it('publishes the built site via BucketDeployment', () => {
    const template = synth();
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });

  it('carries the four app-wide tags on the bucket and distribution', () => {
    const template = synth();
    // CDK emits tags alphabetically by key; `arrayWith` matches as an
    // ordered subsequence, so list these in that order.
    const expectedTags = Match.arrayWith([
      { Key: 'Application', Value: 'GeDe' },
      { Key: 'Environment', Value: 'test' },
      { Key: 'ManagedBy', Value: 'CDK' },
      { Key: 'Organization', Value: 'quadnomics' },
    ]);
    template.hasResourceProperties('AWS::S3::Bucket', { Tags: expectedTags });
    template.hasResourceProperties('AWS::CloudFront::Distribution', { Tags: expectedTags });
  });

  it('matches the snapshot', () => {
    const template = synth();
    expect(template.toJSON()).toMatchSnapshot();
  });
});
