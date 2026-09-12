/**
 * Static deployment configuration. Everything that varies per environment lives here;
 * everything that varies per checkout (hosted zone id, feature switches) comes from
 * `cdk.json` context — see `readContext()` in `bin/gede.ts`.
 */
export interface EnvConfig {
  readonly account: string;
  readonly region: string;
  readonly domain: string;
  readonly envName: string;
  readonly alertsEmail: string;
  readonly budgetUsd: number;
}

export const PROD = {
  account: '975049998516',
  region: 'ap-southeast-1',
  domain: 'gede.work',
  envName: 'prod',
  alertsEmail: 'jrkphani@icloud.com',
  budgetUsd: 100,
} as const satisfies EnvConfig;

/** CloudFront certificates and WAF web ACLs with CLOUDFRONT scope must live in us-east-1. */
export const EDGE_REGION = 'us-east-1';

/** Hardcoded so `cdk synth` is offline and the subnet layout never drifts with AZ lookups. */
export const AVAILABILITY_ZONES = ['ap-southeast-1a', 'ap-southeast-1b'] as const;

/** Values read from `cdk.json` context (or `-c key=value` on the command line). */
export interface AppContext {
  readonly codeConnectionArn: string;
  readonly hostedZoneId: string;
  readonly appleSignIn: boolean;
  readonly githubRepo: string;
  readonly githubBranch: string;
}

/** Value of `hostedZoneId` in cdk.json before the domain is registered. */
export const HOSTED_ZONE_PLACEHOLDER = 'REPLACE_AFTER_DOMAIN_REGISTRATION';

/**
 * Tags applied to every resource. CDK aspects do not cross `Stage` boundaries, so these are
 * applied to the App (pipeline stack) and again to each `GedeStage`.
 */
export function appTags(config: EnvConfig): Readonly<Record<string, string>> {
  return {
    Organization: 'quadnomics',
    Application: 'GeDe',
    Environment: config.envName,
    ManagedBy: 'CDK',
  };
}
