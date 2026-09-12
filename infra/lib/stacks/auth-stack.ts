import * as cdk from 'aws-cdk-lib';
import { aws_cognito as cognito, aws_route53 as route53, aws_ses as ses } from 'aws-cdk-lib';
import { type Construct } from 'constructs';

import { type EnvConfig } from '../config.js';

export interface AuthStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly hostedZoneId: string;
  /** Provision the Sign in with Apple identity provider (needs the `gede/prod/apple-signin` secret). */
  readonly appleSignIn: boolean;
}

/** Secrets Manager secret holding the Apple developer credentials, JSON with these fields. */
const APPLE_SECRET_ID = 'gede/prod/apple-signin';

/**
 * Cognito user pool (passwordless: email OTP + passkeys), its SPA client, the SES sending
 * identity for the domain, and — behind a context switch — Sign in with Apple.
 */
export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly emailIdentity: ses.EmailIdentity;

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
      new cognito.UserPoolDomain(this, 'Domain', {
        userPool: this.userPool,
        cognitoDomain: { domainPrefix: `gede-${config.envName}` },
      });
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

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
