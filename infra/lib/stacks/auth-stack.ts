import * as cdk from 'aws-cdk-lib';
import {
  aws_cognito as cognito,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
} from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig, PLAYWRIGHT_LIVE_ROLE_NAME, e2eUsername } from '../config.js';
import { E2E_USER_HANDLER_DIR, PRE_AUTH_HANDLER_DIR } from '../paths.js';

export interface AuthStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
  /** Provision the Sign in with Apple identity provider (needs the `gede/prod/apple-signin` secret). */
  readonly appleSignIn: boolean;
}

/** Secrets Manager secret holding the Apple developer credentials, JSON with these fields. */
const APPLE_SECRET_ID = 'gede/prod/apple-signin';

/** Client name of the pipeline's live-suite app client (`ADMIN_USER_PASSWORD_AUTH` only). */
export const E2E_CLIENT_NAME = 'gede-e2e';

/**
 * Cognito user pool (passwordless: email OTP + passkeys), its SPA client, the SES sending
 * identity for the domain, and — behind a context switch — Sign in with Apple.
 *
 * Plus what the pipeline's post-deploy `Playwright-Live` step needs to sign in without a
 * mailbox or a passkey (docs/TESTING.md "Live suite"): a second app client `gede-e2e` whose
 * only flow is `ADMIN_USER_PASSWORD_AUTH` (needs IAM credentials — the SPA client stays
 * `USER_AUTH`-only, ADR-011), one account `e2e@<domain>` whose permanent password lives in
 * Secrets Manager, and the grant that lets the step's role call `AdminInitiateAuth` on this
 * pool and read that secret. The password is a real sign-in credential for that account
 * (the pool's sign-in policy admits PASSWORD as a first factor, so `USER_AUTH` on the SPA
 * client takes it too); the secret's IAM is what guards it, not the client's flow list.
 */
export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  /** The live suite's client; `services/sync` accepts its tokens beside the SPA's (`COGNITO_CLIENT_IDS`). */
  readonly e2eClient: cognito.UserPoolClient;
  /** `{ username, password }` of the live suite's account. */
  readonly e2eUserSecret: secretsmanager.Secret;
  readonly emailIdentity: ses.EmailIdentity;
  /** Stage outputs the pipeline's Playwright-Live step reads (`envFromCfnOutputs`). */
  readonly userPoolIdOutput: cdk.CfnOutput;
  readonly e2eClientIdOutput: cdk.CfnOutput;
  readonly e2eUserSecretArnOutput: cdk.CfnOutput;
  /**
   * Host of the Cognito hosted UI Apple redirects through (`gede-<env>.auth.<region>.amazoncognito.com`),
   * or `undefined` when Apple is off. `WebStack` writes it into `config.json` as
   * `appleSignIn: { domain }` (issue #61) and names it in the CSP; Amplify's `oauth.domain`
   * takes the bare host, no scheme.
   */
  readonly hostedUiDomain: string | undefined;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: config.domain,
    });

    // SES identity for the apex domain, DKIM via Easy DKIM records written into the zone.
    // Until SES leaves the sandbox Cognito keeps sending from its own address (below).
    this.emailIdentity = new ses.EmailIdentity(this, 'Ses', {
      identity: ses.Identity.publicHostedZone(zone),
      mailFromDomain: `mail.${config.domain}`,
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      // Cognito requires PASSWORD in the allowed first factors of a choice-based pool
      // (CloudFormation rejects a policy without it: "PASSWORD should be configured as
      // one of the allowed first auth factors", deploy 2026-09-12). Passwordless is
      // therefore enforced one level down: the SPA client below enables only the
      // USER_AUTH flow, and the web app never renders a password field (CLAUDE.md rule 6).
      signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: true, passkey: true } },
      passkeyRelyingPartyId: config.domain,
      passkeyUserVerification: cognito.PasskeyUserVerification.REQUIRED,
      // Nothing to recover in an OTP/passkey pool. With EMAIL_ONLY, `ForgotPassword` +
      // `ConfirmForgotPassword` on the public client could set a durable password on an
      // account that was never meant to have one (issue #35). NONE renders `admin_only`.
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      email: cognito.UserPoolEmail.withCognito(),
      // Once SES is out of the sandbox (production access granted in ap-southeast-1),
      // switch to the verified domain identity created above:
      // email: cognito.UserPoolEmail.withSES({
      //   fromEmail: `no-reply@${config.domain}`,
      //   fromName: 'GeDe',
      //   sesVerifiedDomain: config.domain,
      //   sesRegion: config.region,
      // }),
    });

    const supportedIdentityProviders = [cognito.UserPoolClientIdentityProvider.COGNITO];
    let apple: cognito.UserPoolIdentityProviderApple | undefined;

    if (props.appleSignIn) {
      // clientId/teamId/keyId are identifiers, not secrets, but they live in the same JSON
      // secret as the key. Render them as CloudFormation dynamic references
      // ({{resolve:secretsmanager:...}}) so they resolve at deploy time and never enter the
      // template in plaintext. `SecretValue.toString()` is rejected by the
      // `@aws-cdk/core:checkSecretUsage` flag for non-secret props, hence CfnDynamicReference.
      const field = (jsonField: string): string =>
        new cdk.CfnDynamicReference(
          cdk.CfnDynamicReferenceService.SECRETS_MANAGER,
          `${APPLE_SECRET_ID}:SecretString:${jsonField}`,
        ).toString();

      apple = new cognito.UserPoolIdentityProviderApple(this, 'Apple', {
        userPool: this.userPool,
        clientId: field('clientId'),
        teamId: field('teamId'),
        keyId: field('keyId'),
        privateKeyValue: cdk.SecretValue.secretsManager(APPLE_SECRET_ID, {
          jsonField: 'privateKey',
        }),
        scopes: ['email', 'name'],
        attributeMapping: {
          email: cognito.ProviderAttribute.APPLE_EMAIL,
          givenName: cognito.ProviderAttribute.APPLE_FIRST_NAME,
          familyName: cognito.ProviderAttribute.APPLE_LAST_NAME,
        },
      });
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.APPLE);

      // Hosted UI endpoint Apple redirects back through. The SPA never shows it.
      const domainPrefix = `gede-${config.envName}`;
      new cognito.UserPoolDomain(this, 'Domain', {
        userPool: this.userPool,
        cognitoDomain: { domainPrefix },
      });
      // A Cognito-prefix domain has a fixed shape, so the host is a plain string (no token)
      // and can be written into config.json and the CSP without a stack reference.
      this.hostedUiDomain = `${domainPrefix}.auth.${config.region}.amazoncognito.com`;
    } else {
      this.hostedUiDomain = undefined;
    }

    // The only attributes the product uses: email (sign-in alias, AUTH-03), the display
    // name (AUTH-03), locale, and the given/family names Apple maps (an IdP mapping fails
    // if the client cannot write its targets). `email_verified` is read-only by nature.
    // The ID token carries only readable attributes, so services/sync sees the same set.
    const readAttributes = new cognito.ClientAttributes().withStandardAttributes({
      email: true,
      emailVerified: true,
      fullname: true,
      givenName: true,
      familyName: true,
      locale: true,
    });
    const writeAttributes = new cognito.ClientAttributes().withStandardAttributes({
      email: true,
      fullname: true,
      givenName: true,
      familyName: true,
      locale: true,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'Spa', {
      userPool: this.userPool,
      generateSecret: false,
      // USER_AUTH only: never add `userPassword` or `userSrp` (ADR-011). The pool still
      // lists PASSWORD as a first factor because Cognito insists; this client cannot use it.
      authFlows: { user: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      // Each refresh issues a new refresh token and retires the old one after the grace
      // period (AUTH-09); Amplify v6 stores the rotated token (refreshAuthTokens.mjs).
      refreshTokenRotationGracePeriod: cdk.Duration.seconds(30),
      enableTokenRevocation: true,
      readAttributes,
      writeAttributes,
      supportedIdentityProviders,
      // Without Apple there is no hosted-UI flow at all; the L2 would otherwise default to
      // implicit+code grants with an https://example.com callback.
      ...(props.appleSignIn
        ? {
            oAuth: {
              flows: { authorizationCodeGrant: true },
              scopes: [
                cognito.OAuthScope.OPENID,
                cognito.OAuthScope.EMAIL,
                cognito.OAuthScope.PROFILE,
              ],
              callbackUrls: [`https://${config.domain}/auth/callback`],
              logoutUrls: [`https://${config.domain}/`],
            },
          }
        : { disableOAuth: true }),
    });
    if (apple) {
      // The client lists APPLE as a supported provider; it must not be created first.
      this.userPoolClient.node.addDependency(apple);
    }

    // ---- The live suite's way in (Playwright-Live) ---------------------------------------
    // A client of its own so the SPA client never gains a password flow. ADMIN_USER_PASSWORD_AUTH
    // needs IAM (`AdminInitiateAuth`); the step's role is the only principal granted it (below).
    // That alone does not make the password inert: the pool's sign-in policy lists PASSWORD as
    // a first factor (Cognito insists, see the pool), so the SPA client's USER_AUTH flow would
    // also take it for this one account — the only one with a password. Two guards: IAM on the
    // secret (the handler's role and the step's role are its only readers), and the
    // pre-authentication trigger below, which lets this account in through this client only.
    // Refresh tokens live a day: a run needs minutes.
    this.e2eClient = new cognito.UserPoolClient(this, 'E2e', {
      userPool: this.userPool,
      userPoolClientName: E2E_CLIENT_NAME,
      generateSecret: false,
      authFlows: { adminUserPassword: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      enableTokenRevocation: true,
      readAttributes,
      writeAttributes,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      disableOAuth: true,
    });

    const username = e2eUsername(config);
    // The pool's password policy wants ≥ 8 characters with every class; 32 with each class
    // required satisfies it. Quotes and backslashes are excluded so the JSON the handler
    // and the suite parse can never be broken by the value.
    this.e2eUserSecret = new secretsmanager.Secret(this, 'E2eUser', {
      secretName: `gede/${config.envName}/e2e-user`,
      description: `GeDe ${config.envName}: the live suite's Cognito account (${username})`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username }),
        generateStringKey: 'password',
        passwordLength: 32,
        requireEachIncludedType: true,
        excludeCharacters: '"\'\\`',
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Not `AwsCustomResource`: its handler logs the whole event, so the password would land in
    // CloudWatch. This handler receives the secret's ARN, reads it at run time and logs only
    // the outcome (infra/assets/e2e-user/index.mjs).
    const e2eUserHandler = new lambda.Function(this, 'E2eUserHandler', {
      description: `GeDe ${config.envName}: creates the live suite's Cognito user (custom resource)`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(E2E_USER_HANDLER_DIR),
      timeout: cdk.Duration.minutes(1),
      logGroup: new logs.LogGroup(this, 'E2eUserHandlerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    this.userPool.grant(
      e2eUserHandler,
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:AdminDeleteUser',
    );
    this.e2eUserSecret.grantRead(e2eUserHandler);
    const e2eUser = new cdk.CustomResource(this, 'E2eUserAccount', {
      resourceType: 'Custom::GedeE2eUser',
      serviceToken: e2eUserHandler.functionArn,
      properties: {
        UserPoolId: this.userPool.userPoolId,
        SecretArn: this.e2eUserSecret.secretArn,
        Username: username,
        DisplayName: 'GeDe live suite',
      },
    });
    // The function's role policy (the grants above) must exist before the first invoke.
    e2eUser.node.addDependency(e2eUserHandler);

    // What makes the password above *not* a browser credential: a pre-authentication trigger
    // that lets e2e@<domain> sign in only through gede-e2e (IAM-gated) and lets nobody else
    // use that client. The function finds the client by name at run time — passing its id
    // in would be a pool → trigger → client → pool cycle — so its one grant is
    // ListUserPoolClients, on any pool in the account (the pool ARN would close the cycle).
    const preAuth = new lambda.Function(this, 'PreAuth', {
      description: `GeDe ${config.envName}: pre-authentication trigger (e2e user ↔ gede-e2e client only)`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(PRE_AUTH_HANDLER_DIR),
      timeout: cdk.Duration.seconds(5),
      environment: { E2E_USERNAME: username, E2E_CLIENT_NAME: E2E_CLIENT_NAME },
      logGroup: new logs.LogGroup(this, 'PreAuthLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    preAuth.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'FindE2eClient',
        actions: ['cognito-idp:ListUserPoolClients'],
        resources: [
          cdk.Arn.format({ service: 'cognito-idp', resource: 'userpool', resourceName: '*' }, this),
        ],
      }),
    );
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_AUTHENTICATION, preAuth);

    // What the Playwright-Live CodeBuild role may do, attached here because only this stack
    // knows the exact pool and secret ARNs (PipelineStack creates the role by its fixed name).
    new iam.Policy(this, 'PlaywrightLive', {
      policyName: `gede-${config.envName}-playwright-live`,
      roles: [iam.Role.fromRoleName(this, 'PlaywrightLiveRole', PLAYWRIGHT_LIVE_ROLE_NAME)],
      statements: [
        new iam.PolicyStatement({
          sid: 'SignInAsE2eUser',
          actions: ['cognito-idp:AdminInitiateAuth'],
          resources: [this.userPool.userPoolArn],
        }),
        new iam.PolicyStatement({
          sid: 'ReadE2eUserSecret',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [this.e2eUserSecret.secretArn],
        }),
      ],
    });

    this.userPoolIdOutput = new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    this.e2eClientIdOutput = new cdk.CfnOutput(this, 'E2eClientId', {
      value: this.e2eClient.userPoolClientId,
    });
    this.e2eUserSecretArnOutput = new cdk.CfnOutput(this, 'E2eUserSecretArn', {
      value: this.e2eUserSecret.secretArn,
    });
  }
}
