import * as fs from 'node:fs';
import * as path from 'node:path';
import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface HostingStackProps extends StackProps {
  /** Lowercase env/name prefix (e.g. `gede-test`) for physical resource names. */
  namePrefix: string;
  /**
   * Custom domain to serve on, in addition to the CloudFront default domain.
   * Undefined (the `test` default) => no `domainNames`/certificate is set on
   * the distribution — the default `*.cloudfront.net` domain + CloudFront's
   * default viewer certificate are used (ACM cannot validate a domain we
   * don't control the DNS for, so we simply don't ask it to).
   */
  domainName?: string;
  /**
   * Override for the `BucketDeployment` source directory (issue 041).
   * `BucketDeployment` hashes whatever directory it's given, and that hash
   * lands in the synthesized template — so leaving this to the ambient
   * ("does `dist/` exist right now?") resolution below makes `cdk synth`
   * output, and therefore any snapshot of it, depend on the machine/moment
   * it ran on. Tests MUST pass the committed placeholder path explicitly so
   * synth output is identical on every machine and in CI. Left undefined
   * (the default), production/CI deploys are unaffected: the existing
   * dist-or-placeholder resolution still applies.
   */
  siteSourcePath?: string;
  /**
   * The Api stack's ALB DNS name (issue 047) — when supplied, adds a second
   * origin on THIS distribution behind a `/write*` path, ending the mixed-
   * content block: the browser calls `https://<cloudfront-domain>/write`
   * (same-origin, HTTPS, no CORS, no new cert — reuses CloudFront's own
   * cert) instead of the ALB's plain-HTTP-only endpoint directly. The ALB
   * origin itself stays HTTP internally (CloudFront-to-origin, not
   * viewer-to-CloudFront) — no ACM cert or custom domain is needed for this
   * path (DEPLOYMENT.md §7 — the DNS/cert seam stays inert). Undefined (the
   * default) => no `/write*` behavior is added, so existing synths/tests
   * that don't pass an Api stack are unaffected.
   */
  apiLoadBalancerDnsName?: string;
  /**
   * Issue 049 — when true (and `apiLoadBalancerDnsName` is set), adds a
   * SECOND path-based behavior on the same ALB origin, `/debug/db/*`,
   * fronting the read-only db-inspection Lambda — same same-origin-HTTPS
   * rationale as `/write*` above, but no-cache for the same "never cache a
   * live DB read" reason mutating POSTs must never be cached. False/
   * undefined (the default) => no `/debug/db/*` behavior is added — this is
   * the `test`-env-only gate's second half (the first half is the Api
   * stack's own `debugApiEnabled`, which controls whether the Lambda this
   * points at even exists).
   */
  debugApiEnabled?: boolean;
}

/**
 * `Gede-Test-Hosting` — the static PWA's live infrastructure (issue 040,
 * scope item 2). Private S3 origin (Origin Access Control, no public
 * access) behind a CloudFront distribution.
 */
export class HostingStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: HostingStackProps) {
    super(scope, id, props);

    // --- Private origin bucket -----------------------------------------
    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${props.namePrefix}-site-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // `test` env only: let `cdk destroy` tear the bucket down cleanly
      // (docs/DEPLOYMENT.md §10). A future `prod` env should use RETAIN.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Domain / certificate (DNS seam) --------------------------------
    // A real cert can only be attached once the Gede-Test-Dns stack has
    // created it (DNS-validated certs need the hosted zone to exist first).
    // Rather than a circular stack dependency (Dns needs this distribution
    // for its alias records; this distribution would need Dns's cert), the
    // documented seam (README "domain-flip") is: Dns creates the zone +
    // cert and outputs the cert ARN; a human/CI feeds that ARN back in via
    // the `certificateArn` context on a follow-up `cdk deploy` of Hosting.
    // With no `domainName` (the default), none of this applies and the
    // distribution uses CloudFront's default cert/domain only.
    const certificateArn = this.node.tryGetContext('certificateArn') as string | undefined;
    const certificate =
      props.domainName && certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'ImportedCertificate', certificateArn)
        : undefined;

    // --- Cache behaviors (TECH_STACK §6.2) ------------------------------
    // Default (catch-all) behavior covers index.html, sw.js, and any other
    // unhashed path: no-cache, so a deploy's new shell is visible immediately.
    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: `${props.namePrefix}-no-cache`,
      comment: 'index.html / sw.js / unhashed paths — always revalidate (TECH_STACK §6.2).',
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
    });

    // Hashed, content-addressed assets (Vite's `assets/*` output) are
    // immutable for a year — safe because a new build always emits new
    // hashed filenames.
    const immutableAssetsCachePolicy = new cloudfront.CachePolicy(this, 'ImmutableAssetsCachePolicy', {
      cachePolicyName: `${props.namePrefix}-immutable-assets`,
      comment: 'Hashed build assets — immutable, max-age=1y (TECH_STACK §6.2).',
      defaultTtl: Duration.days(365),
      minTtl: Duration.days(365),
      maxTtl: Duration.days(365),
    });

    // --- Browser cache-control (TECH_STACK §6.2) ------------------------
    // A CachePolicy only governs how long *CloudFront's edge* holds an
    // object; it does NOT put a `Cache-Control` header on the response the
    // *browser* sees. The PWA's update story (registerType: 'prompt') needs
    // the browser itself to revalidate the shell/SW and to treat hashed
    // assets as immutable — so we set the header explicitly via
    // ResponseHeadersPolicy on each behavior (`override: true`, since the
    // private S3 origin sends no Cache-Control of its own).
    const noCacheHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'NoCacheHeadersPolicy', {
      responseHeadersPolicyName: `${props.namePrefix}-no-cache-headers`,
      comment: 'index.html / sw.js — browser must revalidate (TECH_STACK §6.2).',
      customHeadersBehavior: {
        customHeaders: [{ header: 'Cache-Control', value: 'no-cache', override: true }],
      },
    });

    const immutableAssetsHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'ImmutableAssetsHeadersPolicy', {
      responseHeadersPolicyName: `${props.namePrefix}-immutable-assets-headers`,
      comment: 'Hashed build assets — immutable, max-age=1y (TECH_STACK §6.2).',
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cache-Control', value: 'public, max-age=31536000, immutable', override: true },
        ],
      },
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    // --- API origin (issue 047 — ending the mixed-content block) -------
    // The write-path Lambda (issue 043/046) sits behind an ALB with ONLY an
    // HTTP:80 listener (no cert, no custom domain — DEPLOYMENT.md §7/§9a).
    // A page served HTTPS from this SAME distribution cannot call that
    // ALB directly (active mixed content — hard-blocked by every modern
    // browser). Fronting the ALB as a second CloudFront origin under
    // `/write*` gives HTTPS + same-origin in one move: CloudFront terminates
    // TLS for the viewer (reusing ITS OWN cert — no ACM/domain needed) and
    // talks to the ALB over plain HTTP internally, exactly like S3 does
    // above. Preferred over an ALB HTTPS listener (the issue's alternative)
    // because that path requires a registered custom domain + DNS-validated
    // ACM cert (the inert Gede-Test-Dns seam) purely to mint a cert for a
    // domain we don't otherwise need yet.
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      'assets/*': {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: immutableAssetsCachePolicy,
        responseHeadersPolicy: immutableAssetsHeadersPolicy,
        compress: true,
      },
    };

    if (props.apiLoadBalancerDnsName) {
      additionalBehaviors['write*'] = {
        origin: new origins.HttpOrigin(props.apiLoadBalancerDnsName, {
          // The ALB has no HTTPS listener (DEPLOYMENT.md §9a) — CloudFront
          // talks to it over plain HTTP; the viewer never sees that hop
          // (viewerProtocolPolicy below governs the browser-facing side).
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Mutating POSTs must NEVER be cached (issue 047 design brief) — the
        // AWS-managed CachingDisabled policy (TTL 0) is the standard "don't
        // cache this" policy; no hand-rolled CachePolicy needed.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // The default (GET/HEAD only) would reject the write API's POST
        // outright — allow the full method set the ALB route accepts.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Forward the Authorization header (+ body/query) through to the
        // ALB — CloudFront strips non-forwarded headers by default, which
        // would silently drop the JWT handleWriteRequest (043) requires.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      };
    }

    // --- ElectricSQL shape-proxy origin (issue 058) ----------------------
    // Same mixed-content rationale as `/write*` above: the shape-proxy
    // Lambda (deploy/cdk/lib/api-stack.ts's ShapeProxyFunction) sits behind
    // the SAME plain-HTTP-only ALB, so this is a THIRD path-based behavior
    // on that one ALB origin. `VITE_SYNC_URL` (the client's `syncBaseUrl()`,
    // src/sync/config.ts) is wired to point at THIS CloudFront path
    // (`https://<cloudfront-domain>/sync`) — never Electric's own address,
    // which is not internet-reachable at all (issue 058's whole point; see
    // api-stack.ts's class doc). No-cache: a shape's long-poll response must
    // never be served stale from the edge, and Electric's own protocol
    // headers (electric-offset/-handle/-schema/-cursor) must reach the
    // client on every request, not just a cache miss.
    if (props.apiLoadBalancerDnsName) {
      additionalBehaviors['sync*'] = {
        origin: new origins.HttpOrigin(props.apiLoadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Electric's shape protocol uses both GET (the default long-poll)
        // and POST (large `where`/`params` subsets, per Electric's own
        // subset-security docs) — allow the full method set like the other
        // two API behaviors.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Forward the Authorization header through — the shape-proxy's own
        // auth gate (src/server/shapeProxy/handler.ts) needs the caller's
        // Cognito JWT, exactly like /write*'s handleWriteRequest does.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      };
    }

    // --- Debug/db inspection API origin (issue 049) ---------------------
    // Same mixed-content rationale as `/write*` above, extended to a SECOND
    // path on the same ALB origin: `/debug/db/*` fronts the read-only
    // db-inspection Lambda (api-stack.ts's `debugApiEnabled`). Only added
    // when BOTH an Api ALB DNS name AND `debugApiEnabled` are supplied —
    // this is the `test`-env-only gate's CloudFront half; the Api stack's
    // own `debugApiEnabled` gates whether the Lambda it forwards to even
    // exists. No-cache for the same reason `/write*` is no-cache: a live DB
    // read must never be served stale from the edge.
    if (props.apiLoadBalancerDnsName && props.debugApiEnabled) {
      additionalBehaviors['debug/db/*'] = {
        origin: new origins.HttpOrigin(props.apiLoadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // GET (counts/rows) and POST (the guarded query op) both need to pass through.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Forward x-debug-token/Authorization through — CloudFront strips
        // non-forwarded headers by default, which would silently turn every
        // request into a 401 (handleDebugRequest's auth gate never sees the token).
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      };
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.namePrefix} — GeDe static PWA`,
      defaultRootObject: 'index.html',
      // HTTP/3 (+HTTP/2) support (issue 040 scope).
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: noCachePolicy,
        responseHeadersPolicy: noCacheHeadersPolicy,
        // CloudFront auto-negotiates Brotli/gzip against the viewer's
        // Accept-Encoding when `compress` is true — there is no separate
        // "enable Brotli" flag on the L2 construct.
        compress: true,
      },
      additionalBehaviors,
      // SPA/PWA routing: unknown paths (deep links) come back from S3 as
      // 403 (private bucket via OAC) — map both 403 and 404 to index.html
      // with a 200 so client-side routing takes over.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
      ],
      // Default CloudFront domain/cert unless a real domain + cert (from
      // the Dns stack seam, see above) are both available.
      domainNames: props.domainName && certificate ? [props.domainName] : undefined,
      certificate,
    });

    // --- Publish the built site -----------------------------------------
    // `cdk synth`/tests must succeed even when `dist/` doesn't exist yet
    // (e.g. a fresh checkout, or CDK tests running before `npm run build`).
    // Resolve the real web-app `dist/` and fall back to a tiny committed
    // placeholder so BucketDeployment always has a valid asset directory.
    // CI (deploy.yml) always runs `npm run build` first, so production
    // deploys publish the real `dist/`; local `cdk synth`/tests use the
    // placeholder and never assert on its contents.
    //
    // `props.siteSourcePath` (issue 041) short-circuits all of this for
    // tests: pass the committed placeholder explicitly so BucketDeployment's
    // asset hash — and therefore the synthesized template/snapshot — never
    // depends on whether *this* machine happens to have a `dist/` built.
    const repoDistPath = path.resolve(__dirname, '..', '..', '..', 'dist');
    const placeholderPath = path.resolve(__dirname, '..', 'assets', 'placeholder');
    const siteSourcePath = props.siteSourcePath ?? (fs.existsSync(repoDistPath) ? repoDistPath : placeholderPath);

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(siteSourcePath)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      // Only the shell paths need invalidating on deploy (TECH_STACK §6.2 /
      // DEPLOYMENT.md §10) — hashed assets are new filenames, never stale.
      distributionPaths: ['/index.html', '/sw.js'],
      // The default 128MB deployment Lambda OOMs on the ~38MB `dist/` (issue
      // 042 self-hosts the ~22MB onnxruntime WASM for offline semantic search
      // — deliberately not CDN-fetched, so no external dependency). Give it
      // room to unzip + upload the bundle.
      memoryLimit: 1024,
    });

    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront default domain — the test-env app URL.',
    });
    new CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Private S3 origin bucket (OAC only, no public access).',
    });
  }
}
