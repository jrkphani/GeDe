import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from './network-stack';
import { HostingStack } from './hosting-stack';
import { DnsStack } from './dns-stack';
import { DataStack } from './data-stack';
import { ApiStack } from './api-stack';

// --- Env config (issue 040 §"Scope") ---------------------------------------
// Only one named env exists today: `test`. A future `prod` env is added here
// (its own account/region) when a domain + prod account decision land —
// see docs/issues/040-cdk-aws-deployment.md and TECH_STACK §6.1.
export type EnvName = 'test';

export interface EnvConfig {
  account: string;
  region: string;
  /** Stack name prefix, e.g. `Gede-Test` -> `Gede-Test-Network`. */
  stackPrefix: string;
  /** Lowercase physical-name prefix for globally-unique resources (S3 etc). */
  namePrefix: string;
}

export const ENVS: Record<EnvName, EnvConfig> = {
  test: {
    account: '975049998516',
    region: 'us-east-1',
    stackPrefix: 'Gede-Test',
    namePrefix: 'gede-test',
  },
};

export interface AppStacks {
  network: NetworkStack;
  hosting: HostingStack;
  dns: DnsStack;
  data: DataStack;
  api: ApiStack;
}

/**
 * Builds the five layered stacks (Network -> Hosting -> Dns, and
 * Network -> Data -> Api) on the given `app`, exactly as the real CLI
 * entrypoint (`bin/gede.ts`) does. Shared so the CDK test suite exercises
 * the identical wiring/tagging as a real synth — see
 * docs/issues/040-cdk-aws-deployment.md and docs/issues/030-*.md.
 *
 * Cross-stack wiring (issue 030 scope item 4): Network's VPC feeds both Data
 * and Api; Data's RDS security group feeds Api (which adds the one
 * permitted ingress rule against it — see api-stack.ts / data-stack.ts for
 * why that direction avoids a circular dependency). Hosting/Dns (issue 040,
 * v1's static path) are unaffected by any of this.
 */
export function buildAppStacks(
  app: cdk.App,
  envName: EnvName = 'test',
  domainName?: string,
  /**
   * Test-only override threaded through to `HostingStack.siteSourcePath`
   * (issue 041) — pins the `BucketDeployment` source so synth output never
   * depends on whether a built `dist/` happens to exist on this machine.
   * Never passed by the real CLI entrypoint (`bin/gede.ts`).
   */
  siteSourcePath?: string,
): AppStacks {
  const envConfig = ENVS[envName];
  const env: cdk.Environment = { account: envConfig.account, region: envConfig.region };

  // Tag strategy (issue 040 "Tag strategy" table) — applied once at the App
  // so every stack + resource inherits them.
  cdk.Tags.of(app).add('Organization', 'quadnomics');
  cdk.Tags.of(app).add('Application', 'GeDe');
  cdk.Tags.of(app).add('Environment', envName);
  cdk.Tags.of(app).add('ManagedBy', 'CDK');

  const network = new NetworkStack(app, `${envConfig.stackPrefix}-Network`, {
    env,
    description: 'GeDe network foundation (VPC + NAT + public/private/isolated subnets) — issue 040, extended by 030',
  });

  const hosting = new HostingStack(app, `${envConfig.stackPrefix}-Hosting`, {
    env,
    description: 'GeDe static hosting: private S3 + CloudFront — issue 040',
    namePrefix: envConfig.namePrefix,
    domainName,
    siteSourcePath,
  });
  hosting.addDependency(network);

  const dns = new DnsStack(app, `${envConfig.stackPrefix}-Dns`, {
    env,
    description: 'GeDe DNS seam (Route 53 + ACM), inert without a domain — issue 040',
    domainName,
    distribution: hosting.distribution,
  });
  dns.addDependency(hosting);

  const data = new DataStack(app, `${envConfig.stackPrefix}-Data`, {
    env,
    description: 'GeDe v2 backend: managed RDS PostgreSQL 17 in isolated subnets — issue 030 (ADR-0008)',
    vpc: network.vpc,
  });
  data.addDependency(network);

  const api = new ApiStack(app, `${envConfig.stackPrefix}-Api`, {
    env,
    description:
      'GeDe v2 backend: ECS Fargate compute tier (sync/auth stub slots, issues 032/033) behind an internet-facing ALB — issue 030 (ADR-0008)',
    vpc: network.vpc,
    databaseSecurityGroup: data.databaseSecurityGroup,
  });
  api.addDependency(network);
  api.addDependency(data);

  return { network, hosting, dns, data, api };
}
