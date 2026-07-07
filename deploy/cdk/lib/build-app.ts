import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from './network-stack';
import { HostingStack } from './hosting-stack';
import { DnsStack } from './dns-stack';
import { DataStack } from './data-stack';
import { MigrationStack } from './migration-stack';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';

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
  auth: AuthStack;
  migrations: MigrationStack;
}

/**
 * Builds the seven layered stacks (Network -> Hosting -> Dns, Network -> Data
 * -> Migrations, Network -> Data -> Api, and the standalone Auth stack) on
 * the given `app`, exactly as the real CLI entrypoint (`bin/gede.ts`) does.
 * Shared so the CDK test suite exercises the identical wiring/tagging as a
 * real synth — see docs/issues/040-cdk-aws-deployment.md,
 * docs/issues/030-*.md, docs/issues/033-auth-account.md, and issue 045 (M11,
 * "close the cloud write loop" — the RDS migration runner).
 *
 * Cross-stack wiring (issue 030 scope item 4, extended by issue 045):
 * Network's VPC feeds Data, Migrations, and Api; Data's RDS security group
 * feeds both Migrations and Api (each adds its own permitted ingress rule
 * against it — see api-stack.ts / migration-stack.ts / data-stack.ts for why
 * that direction avoids a circular dependency). Hosting/Dns (issue 040, v1's
 * static path) are unaffected by any of this. **Auth (issue 033, ADR-0009) is
 * intentionally standalone** — Cognito is a regional managed resource outside
 * the VPC, so it has no dependency on Network/Data/Api and no cross-stack
 * security-group wiring; it only needs the app-level tags (applied once
 * below, to every stack under `app`).
 *
 * **Migrations (issue 045) is deliberately NOT a dependency of Api**: the
 * real write-path Lambda (a later issue, 046) will assume 045's migrations
 * have already applied the RDS schema by deploy time, but that's a
 * deploy-ORDER concern for the CI pipeline, not a synth-time one — see
 * migration-stack.ts's comments for why no `addDependency` encodes it here.
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

  const migrations = new MigrationStack(app, `${envConfig.stackPrefix}-Migrations`, {
    env,
    description:
      'GeDe v2 backend: one-shot migration runner — applies src/db/migrations/*.sql to the RDS via a VPC-attached custom-resource Lambda — issue 045',
    vpc: network.vpc,
    databaseSecurityGroup: data.databaseSecurityGroup,
    databaseSecret: data.database.secret!,
    databaseEndpoint: data.database.dbInstanceEndpointAddress,
  });
  migrations.addDependency(network);
  migrations.addDependency(data);

  const api = new ApiStack(app, `${envConfig.stackPrefix}-Api`, {
    env,
    description:
      'GeDe v2 backend: ECS Fargate compute tier (sync/auth stub slots, issues 032/033) + the serverless write-path API (issue 043) behind an internet-facing ALB — issue 030 (ADR-0008), ADR-0010',
    vpc: network.vpc,
    databaseSecurityGroup: data.databaseSecurityGroup,
    databaseSecret: data.database.secret!,
    databaseEndpoint: data.database.dbInstanceEndpointAddress,
  });
  api.addDependency(network);
  api.addDependency(data);
  // See this function's class doc + migration-stack.ts's own comments: NO
  // `api.addDependency(migrations)` — the deploy-order relationship between
  // the migration runner and the (currently still-stubbed) write-path Lambda
  // is a CI-pipeline concern, not a CDK/CloudFormation one.

  const auth = new AuthStack(app, `${envConfig.stackPrefix}-Auth`, {
    env,
    description:
      'GeDe v2 identity: Cognito User Pool + public App Client (email/password, PKCE/SRP, no client secret) — issue 033 (ADR-0009), replacing the Api stack\'s former `auth` Fargate stub',
  });

  return { network, hosting, dns, data, api, auth, migrations };
}
