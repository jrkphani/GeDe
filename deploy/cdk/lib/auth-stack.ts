import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

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
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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
