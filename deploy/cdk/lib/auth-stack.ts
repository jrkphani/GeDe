import * as path from 'path';
import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// Amazon RDS global CA bundle (deploy/cdk/lib/rds-global-bundle.pem) — copied
// into the provisioning Lambda's bundle so albAdapter.ts can verify the RDS
// server cert. Mirrors api-stack.ts's write Lambda and migration-stack.ts's
// runner — same shared source file, no duplication.
const RDS_CA_SOURCE = path.resolve(__dirname, 'rds-global-bundle.pem');

export interface AuthStackProps extends StackProps {
  /**
   * The Network stack's VPC (issue 050) — the PostConfirmation provisioning
   * Lambda below needs it to reach the Data stack's isolated-subnet RDS.
   * Cognito itself is still a regional managed resource OUTSIDE the VPC
   * (issue 033) — only the new trigger Lambda is VPC-attached.
   */
  vpc: ec2.IVpc;
  /**
   * The Data stack's RDS security group (issue 050). This stack adds the
   * ONE ingress rule it needs (provisioning Lambda SG -> 5432) as a forward
   * reference — the same one-directional pattern api-stack.ts and
   * migration-stack.ts already use for their own Lambda SGs (see
   * api-stack.ts's class doc for the circular-dependency rationale; it
   * applies here identically).
   */
  databaseSecurityGroup: ec2.ISecurityGroup;
  /**
   * The Data stack's generated RDS credentials secret (issue 050) — the
   * provisioning Lambda connects as this (master/owner) role, exactly like
   * the migration runner, so its bootstrap INSERTs into `workspaces`/
   * `workspace_members` are exempt from RLS (migration 0008's owner-
   * exemption) — there is no existing membership row yet to authorize a
   * least-privileged `app_user` write against.
   */
  databaseSecret: secretsmanager.ISecret;
  /** The Data stack's RDS endpoint address (issue 050). */
  databaseEndpoint: string;
}

/**
 * `Gede-<Env>-Auth` - the v2 identity tier (issue 033, ADR-0009, superseding
 * the better-auth Fargate slot from issue 030/ADR-0008): a Cognito **User
 * Pool** + a public **App Client**, both **regional managed resources
 * OUTSIDE the VPC** - there is no NAT/compute path for auth, and no Fargate
 * service/target-group/ALB route (`api-stack.ts` no longer runs an `auth`
 * stub; see that file's class doc).
 *
 * - **Email/password sign-up + verification.** `selfSignUpEnabled` with
 *   `autoVerify.email` - a user signs up with an email + password and
 *   confirms with the emailed code before signing in (Cognito's standard
 *   `CUSTOM_MESSAGE`/verification flow; no Hosted UI involved - the SPA
 *   drives this via `amazon-cognito-identity-js`, ADR-0009 "Custom login
 *   screen, not Hosted UI").
 * - **A real password policy** (min length 8, upper/lower/digit required) -
 *   Cognito's zero-config default is effectively no policy, which would
 *   silently under-deliver on "a password policy" in the issue scope.
 * - **Public SPA App Client, SRP only, no client secret.** `generateSecret:
 *   false` + `authFlows.userSrp` (the SDK's `authenticateUser` never sends
 *   the plaintext password over the wire - Secure Remote Password protocol).
 *   `ALLOW_USER_PASSWORD_AUTH` is deliberately NOT enabled - a public client
 *   with a plaintext-password flow is a straightforward credential-leak
 *   surface; SRP is the whole reason to prefer the SDK over a raw REST call.
 *   OAuth/PKCE (authorization-code + PKCE, needed for the Google Workspace
 *   federation fast-follow, ADR-0009) is deliberately NOT configured yet -
 *   it requires at least one real callback URL, which doesn't exist before
 *   a domain is wired (issue 040/Hosting-Dns seam); add it alongside that
 *   fast-follow issue rather than stub a fake localhost callback here.
 * - **Groups/roles seam** (issues 034/035): a starter `member` group so
 *   workspace-role wiring has somewhere to attach without its own migration
 *   later.
 * - **JWKS seam**: exports the User Pool id, the App Client id (both consumed
 *   by the frontend build, e.g. `VITE_COGNITO_USER_POOL_ID`/`_CLIENT_ID`),
 *   and the User Pool's public JWKS URI - issue 032's sync/API and issue 034's
 *   RLS validate the Cognito-issued JWT against this endpoint and read the
 *   `sub` claim as the row-scoping identity (ADR-0009). Full server-side JWT
 *   verification is out of scope for 033 (a later issue wires it); this
 *   stack only publishes the seam.
 * - **Auto-provisioning (issue 050)**: a `PostConfirmation` Lambda trigger
 *   that, on first confirm, idempotently creates the user's personal
 *   `workspaces` row + owner `workspace_members` row in RDS
 *   (src/server/provisionWorkspace/{handler,albAdapter}.ts) — the missing
 *   server-side piece that lets a signed-in client's write-queue actually
 *   flush somewhere real (034's tenancy check otherwise rejects every write
 *   whose workspace isn't already in RDS with the caller as a member).
 *   Deliberately a `LambdaConfig` attachment on the EXISTING User Pool, never
 *   a `Schema`/custom-attribute change — the latter forces a full User Pool
 *   REPLACEMENT in CloudFormation (destroying every existing user), which
 *   this design avoids entirely by deriving the workspace id from the
 *   token's `sub` instead of storing it on the pool (src/domain/
 *   workspaceId.ts's `workspaceIdForSub` — "they agree by construction, not
 *   by a stored/fetched value"). Verified via `cdk diff`: the
 *   `AWS::Cognito::UserPool` resource must show Modify, never Replace.
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  /** The PostConfirmation provisioning Lambda (issue 050) — VPC-attached, unlike the pool/client above. */
  public readonly provisionWorkspaceFunction: lambda.Function;
  public readonly provisionWorkspaceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // --- Provisioning trigger (issue 050) ------------------------------------
    // Built BEFORE the User Pool so its ARN can be passed straight into the
    // pool's own `lambdaTriggers` prop below — a single, in-place
    // `LambdaConfig` property on the pool resource, not a separate
    // `addTrigger()` call after the fact. Either shape produces the same
    // CloudFormation property; this one keeps the pool's full configuration
    // (including its trigger) visible in one constructor call.
    this.provisionWorkspaceSecurityGroup = new ec2.SecurityGroup(this, 'ProvisionWorkspaceSecurityGroup', {
      vpc: props.vpc,
      description: `${id} PostConfirmation provisioning Lambda (issue 050) - egress to Postgres (5432) only; nothing ingresses to it over the network.`,
      allowAllOutbound: true,
    });

    new ec2.CfnSecurityGroupIngress(this, 'AllowProvisionWorkspaceToPostgres', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.provisionWorkspaceSecurityGroup.securityGroupId,
      description:
        'PostConfirmation provisioning Lambda (issue 050) to Postgres 5432 - a distinct ingress rule on the Data security group (alongside the compute/write-API/debug-API Lambda rules); still never 0.0.0.0/0.',
    });

    const rootLockFile = path.resolve(__dirname, '..', '..', '..', 'package-lock.json');

    this.provisionWorkspaceFunction = new nodejs.NodejsFunction(this, 'ProvisionWorkspaceFunction', {
      description: `${id} Cognito PostConfirmation trigger (issue 050) - idempotently creates the confirmed user's personal workspace + owner membership in Postgres.`,
      entry: path.resolve(__dirname, '..', '..', '..', 'src', 'server', 'provisionWorkspace', 'albAdapter.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.provisionWorkspaceSecurityGroup],
      depsLockFilePath: rootLockFile,
      environment: {
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_ENDPOINT: props.databaseEndpoint,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node20',
        // Offline synth (issue 041 lesson, mirrors api-stack.ts/migration-stack.ts)
        // — esbuild is a deploy/cdk devDependency specifically so this never
        // needs Docker.
        forceDockerBundling: false,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // Copy Amazon's RDS CA bundle alongside the handler so albAdapter.ts
          // can verify the RDS server cert. Mirrors api-stack.ts/migration-stack.ts.
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp "${RDS_CA_SOURCE}" "${outputDir}/rds-global-bundle.pem"`,
          ],
        },
      },
    });
    props.databaseSecret.grantRead(this.provisionWorkspaceFunction);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Issue 050 — an in-place `LambdaConfig` attachment, NOT a `Schema`/
      // custom-attribute change (see class doc: the latter forces a pool
      // REPLACEMENT). This is the only new property on the pool.
      lambdaTriggers: {
        postConfirmation: this.provisionWorkspaceFunction,
      },
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'AppClient', {
      userPool: this.userPool,
      // Public SPA client - no long-lived secret in the browser (ADR-0009).
      generateSecret: false,
      authFlows: {
        userSrp: true,
        // Neither `userPassword` nor `adminUserPassword` - see class doc.
      },
      preventUserExistenceErrors: true,
    });

    // Groups/roles seam for later tenancy (issues 034/035) - a default
    // group so workspace-role wiring attaches to an existing construct
    // rather than needing its own follow-up migration.
    new cognito.CfnUserPoolGroup(this, 'MembersGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'member',
      description: 'Default group for authenticated users - seam for workspace roles (issues 034/035).',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${id}-UserPoolId`,
      description: 'Cognito User Pool id - consumed by the frontend build (VITE_COGNITO_USER_POOL_ID).',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${id}-UserPoolClientId`,
      description: 'Cognito App Client id - consumed by the frontend build (VITE_COGNITO_CLIENT_ID).',
    });

    new CfnOutput(this, 'UserPoolJwksUri', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/jwks.json`,
      exportName: `${id}-UserPoolJwksUri`,
      description:
        'JWKS endpoint for validating the Cognito-issued JWT (RS256) - the seam 032 (sync/API) and 034 (RLS, keyed on the `sub` claim) validate against.',
    });
  }
}
