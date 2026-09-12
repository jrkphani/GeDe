import * as cdk from 'aws-cdk-lib';
import {
  type aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secretsmanager,
  type aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';
import { PLACEHOLDER_WEB_DIR, WEB_DIST, dirExists } from '../paths.js';

export interface WebStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly certificate: acm.ICertificate;
  readonly webAcl: wafv2.CfnWebACL;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly appleSignIn: boolean;
}

/** Header CloudFront adds to every `/api/*` origin request; the ALB forwards nothing without it. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

/**
 * Generations of the origin-verify secret. The last one is what CloudFront presents; the ALB
 * accepts every one listed. Zero-downtime rotation is two merges: append a generation
 * (`[1, 2]`: CloudFront moves to 2, the ALB still accepts 1), then drop the old one (`[2]`).
 * Each generation is its own Secrets Manager secret with a fresh random value, so rotating
 * never edits a secret value by hand. See ADR-018.
 */
export const ORIGIN_VERIFY_GENERATIONS: readonly number[] = [1];

/**
 * viewer-request function for the SPA behaviours only. A path whose last segment has no
 * extension is a client-side route and is served `index.html`; real files (`/config.json`,
 * `/favicon.svg`, …) pass through, and a missing one returns S3's error unchanged. This
 * replaces the distribution-wide 403/404 → 200 `errorResponses`, which also rewrote `/api/*`
 * authorization and not-found responses into `200 text/html` (issue #38).
 */
const SPA_ROUTER_FUNCTION = `function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
`;

/** Shape of `/config.json`, read by apps/web at boot. Keep in sync with apps/web. */
interface WebRuntimeConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly appleSignIn: boolean;
}

/**
 * The SPA: private S3 bucket behind CloudFront (OAC), `/api/*` proxied to the ALB via its
 * public hostname with the origin-verify header, WAF attached, SPA fallback for deep links
 * via a viewer-request function on the shell behaviour only.
 */
export class WebStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly appUrl: cdk.CfnOutput;
  /** One per generation, oldest first; ServiceStack's listener rule accepts all of them. */
  readonly originVerifySecrets: readonly secretsmanager.ISecret[];

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });
    const { config } = props;
    const prefix = `gede-${config.envName}`;

    // ---- Origin verification (issue #33) ------------------------------------------------
    // The ALB is internet-facing (the WebSocket must reach it directly, ADR-010) but only
    // forwards `/api/*` when this header carries the current value. Alphanumeric only: ALB
    // header conditions treat `*` and `?` as wildcards and the value must stay under 128 chars.
    this.originVerifySecrets = ORIGIN_VERIFY_GENERATIONS.map(
      (generation) =>
        new secretsmanager.Secret(this, `OriginVerify${String(generation)}`, {
          description: `GeDe ${config.envName}: ${ORIGIN_VERIFY_HEADER} value CloudFront presents to the ALB (generation ${String(generation)})`,
          generateSecretString: { passwordLength: 64, excludePunctuation: true },
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
    );
    const presented = this.originVerifySecrets.at(-1);
    if (!presented) {
      throw new Error('ORIGIN_VERIFY_GENERATIONS must list at least one generation');
    }

    const bucket = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    // index.html and config.json must never be served stale: the SPA's asset URLs are
    // content-hashed, so the shell is the only thing that has to be fresh.
    const noCache = new cloudfront.CachePolicy(this, 'NoCache', {
      cachePolicyName: `${prefix}-no-cache`,
      comment: 'GeDe SPA shell: never cached at the edge',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
    });

    // Every origin the SPA talks to, checked against apps/web/index.html and apps/web/src:
    // Google Fonts (stylesheet + font files), the Cognito user-pool API (Amplify), the
    // WebSocket on the ALB, and — only with Apple sign-in — the hosted-UI token endpoint.
    // `style-src 'unsafe-inline'` is required by Radix (positioning styles are set inline)
    // and React style props. Scripts stay `'self'`: the Vite build emits no inline script.
    // `worker-src blob:` covers Vite's inlined workers (regex/fuzzy matching run in workers).
    const connectSrc = [
      "'self'",
      `https://cognito-idp.${config.region}.amazonaws.com`,
      `wss://ws.${config.domain}`,
      // AuthStack's hosted-UI `domainPrefix` is the same `gede-<env>` prefix.
      ...(props.appleSignIn ? [`https://${prefix}.auth.${config.region}.amazoncognito.com`] : []),
    ];
    const contentSecurityPolicy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      `connect-src ${connectSrc.join(' ')}`,
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    const securityHeaders: cloudfront.ResponseSecurityHeadersBehavior = {
      contentSecurityPolicy: { contentSecurityPolicy, override: true },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
      strictTransportSecurity: {
        accessControlMaxAge: cdk.Duration.days(365),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      xssProtection: { protection: true, modeBlock: true, override: true },
    };

    const shellHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ShellHeaders', {
      responseHeadersPolicyName: `${prefix}-shell`,
      securityHeadersBehavior: securityHeaders,
      customHeadersBehavior: {
        customHeaders: [{ header: 'Cache-Control', value: 'no-cache', override: true }],
      },
    });

    const assetHeaders = new cloudfront.ResponseHeadersPolicy(this, 'AssetHeaders', {
      responseHeadersPolicyName: `${prefix}-assets`,
      securityHeadersBehavior: securityHeaders,
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Cache-Control', value: 'public, max-age=31536000, immutable', override: true },
        ],
      },
    });

    // `unsafeUnwrap` renders a `{{resolve:secretsmanager:…}}` dynamic reference: CloudFormation
    // substitutes the value at deploy time and it never appears in the template or cdk.out.
    const apiOrigin = new origins.HttpOrigin(`api.${config.domain}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
      customHeaders: { [ORIGIN_VERIFY_HEADER]: presented.secretValue.unsafeUnwrap() },
    });

    const spaRouter = new cloudfront.Function(this, 'SpaRouter', {
      functionName: `${prefix}-spa-router`,
      comment: 'GeDe SPA: serve index.html for extension-less paths (client-side routes)',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(SPA_ROUTER_FUNCTION),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `GeDe ${config.envName} web`,
      domainNames: [config.domain, `www.${config.domain}`],
      certificate: props.certificate,
      webAclId: props.webAcl.attrArn,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: noCache,
        responseHeadersPolicy: shellHeaders,
        // SPA deep links are rewritten here, per behaviour, so `/api/*` errors stay intact.
        functionAssociations: [
          { function: spaRouter, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: assetHeaders,
        },
        '/api/*': {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Host becomes the origin hostname (api.<domain>); the viewer Host is not a
          // spoofable input for the service (issue #42).
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        },
      },
      // No distribution-wide `errorResponses`: they would rewrite `/api/*` 403/404 to 200.
    });

    const runtimeConfig: WebRuntimeConfig = {
      region: config.region,
      userPoolId: props.userPoolId,
      userPoolClientId: props.userPoolClientId,
      apiUrl: `https://${config.domain}/api`,
      wsUrl: `wss://ws.${config.domain}/ws`,
      appleSignIn: props.appleSignIn,
    };

    new s3deploy.BucketDeployment(this, 'Deploy', {
      destinationBucket: bucket,
      sources: [
        s3deploy.Source.asset(this.webDistDir()),
        s3deploy.Source.jsonData('config.json', runtimeConfig),
      ],
      distribution: this.distribution,
      distributionPaths: ['/index.html', '/config.json'],
      prune: true,
      memoryLimit: 1024,
    });

    this.appUrl = new cdk.CfnOutput(this, 'AppUrl', { value: `https://${config.domain}` });
  }

  /** `apps/web/dist` when built; otherwise the placeholder page so a local synth still works. */
  private webDistDir(): string {
    if (dirExists(WEB_DIST)) {
      return WEB_DIST;
    }
    cdk.Annotations.of(this).addWarningV2(
      'gede:placeholder-web-dist',
      'apps/web/dist not found; deploying infra/assets/placeholder/web instead. Run `npm run build --workspace apps/web` first.',
    );
    return PLACEHOLDER_WEB_DIR;
  }
}
