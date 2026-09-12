import * as cdk from 'aws-cdk-lib';
import {
  type aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
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
 * public hostname, WAF attached, SPA fallback for deep links.
 */
export class WebStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly appUrl: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, { ...props, crossRegionReferences: true });
    const { config } = props;
    const prefix = `gede-${config.envName}`;

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

    const securityHeaders: cloudfront.ResponseSecurityHeadersBehavior = {
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

    const apiOrigin = new origins.HttpOrigin(`api.${config.domain}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
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
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        },
      },
      // SPA deep links: S3 answers 403 for unknown keys behind OAC; the router takes over.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
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
