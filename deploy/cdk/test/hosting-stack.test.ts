import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildAppStacks } from '../lib/build-app';
import { normalizeAssetHashes } from './normalize-asset-hashes';

const TEST_CONTEXT = {
  'availability-zones:account=975049998516:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

// The committed placeholder (issue 041) — pinned explicitly as this suite's
// BucketDeployment source so the synthesized template (and its snapshot)
// never depends on whether *this* machine happens to have a built `dist/`.
const PLACEHOLDER_PATH = path.resolve(__dirname, '..', 'assets', 'placeholder');

describe('HostingStack (Gede-Test-Hosting)', () => {
  function synth(domainName?: string) {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { hosting } = buildAppStacks(app, 'test', domainName, PLACEHOLDER_PATH);
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
    // Defense-in-depth (issue 041): normalize any CDK asset hash to a stable
    // token before asserting, so the snapshot stays deterministic even if a
    // future asset-bearing construct is added without pinning its source.
    expect(normalizeAssetHashes(template.toJSON())).toMatchSnapshot();
  });
});

// issue 041 — the snapshot must not depend on the ambient filesystem.
//
// Un-pinned (production/CLI) behavior still resolves `dist/`-or-placeholder
// from whatever's on disk at synth time (hosting-stack.ts); that's correct
// for `cdk deploy`/CI's post-build synth. What must NOT happen is a *test*
// picking that ambient state up silently.
//
// IMPORTANT: this suite must NEVER mutate the real repo-root `dist/` —
// every other test file (tags.test.ts, network-stack.test.ts, etc.) also
// calls `buildAppStacks` *without* an override, so it hits HostingStack's
// real ambient `fs.existsSync(dist)` check against that same shared path.
// Jest runs test files concurrently in separate workers, so toggling the
// real `dist/` here would race those files' synths non-deterministically.
// Two independent temp directories stand in for "no local build" vs. "a
// contributor's local dist/" instead.
describe('HostingStack site source is pinned, not ambient (issue 041)', () => {
  function synthWith(sourcePath: string) {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { hosting } = buildAppStacks(app, 'test', undefined, sourcePath);
    return Template.fromStack(hosting).toJSON();
  }

  it('the pinned source alone determines the asset hash — different content differs, same content matches', () => {
    const tmpNoLocalBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'gede-041-no-build-'));
    fs.writeFileSync(path.join(tmpNoLocalBuild, 'index.html'), '<html>placeholder-equivalent</html>');

    const tmpContributorBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'gede-041-local-build-'));
    fs.writeFileSync(path.join(tmpContributorBuild, 'index.html'), '<html>a real build — different bytes</html>');

    try {
      // Sanity: siteSourcePath really does drive the asset hash — different
      // content produces a different template (proves the prop is wired up,
      // not silently ignored).
      expect(synthWith(tmpNoLocalBuild)).not.toEqual(synthWith(tmpContributorBuild));

      // The property issue 041 needs: pinning the SAME source is byte-
      // identical across repeated synths — independent of anything else on
      // the filesystem, in particular this repo's own (shared) `dist/`.
      expect(synthWith(PLACEHOLDER_PATH)).toEqual(synthWith(PLACEHOLDER_PATH));
    } finally {
      fs.rmSync(tmpNoLocalBuild, { recursive: true, force: true });
      fs.rmSync(tmpContributorBuild, { recursive: true, force: true });
    }
  });
});

// issue 041 — defense-in-depth: prove the normalizer actually replaces a
// real CDK asset hash (as it appears in a synthesized template's S3Key)
// with the stable token, independent of the siteSourcePath fix above.
describe('normalizeAssetHashes (issue 041 defense-in-depth)', () => {
  interface CfnResource {
    Type: string;
    Properties?: Record<string, unknown>;
  }

  it('renders a CDK asset S3Key as the normalized token', () => {
    const app = new cdk.App({ context: TEST_CONTEXT });
    const { hosting } = buildAppStacks(app, 'test', undefined, PLACEHOLDER_PATH);
    const template = Template.fromStack(hosting);
    const normalized = normalizeAssetHashes(template.toJSON()) as { Resources: Record<string, CfnResource> };

    const bucketDeployment = Object.values(normalized.Resources).find(
      (resource) => resource.Type === 'Custom::CDKBucketDeployment',
    );

    expect(bucketDeployment?.Properties?.SourceObjectKeys).toEqual(['<ASSET_HASH>.zip']);
  });
});
