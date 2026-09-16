/**
 * The Amplify boundary. Everything that touches `aws-amplify/auth` lives here
 * so screens depend on a small, mockable surface. See README.md for which
 * Cognito API each function maps to and why.
 */
import { Amplify } from 'aws-amplify';
import {
  associateWebAuthnCredential,
  autoSignIn,
  confirmSignIn,
  confirmSignUp,
  fetchAuthSession,
  fetchUserAttributes,
  getCurrentUser,
  resendSignUpCode,
  signIn,
  signInWithRedirect,
  signOut,
  signUp,
  updateUserAttributes,
  type SignInOutput,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { Hub, sharedInMemoryStorage } from 'aws-amplify/utils';
import type { AppConfig } from '../config.js';
import { clearReplicas } from '../doc/replica.js';
import { clearViewState } from '../doc/view-state.js';
import type { CodeKind } from './codes.js';

/** A step that asks for a code. `code` says which one Cognito sent (`codes.ts`: its length). */
export interface CodeStep {
  kind: 'code';
  /** Which confirm call answers it — and, through `CODE_LENGTH`, how long the code is. */
  code: CodeKind;
  destination: string | undefined;
}

export type SignInStep =
  | { kind: 'done' }
  | CodeStep
  /** Cognito asked for something GeDe does not offer; `reason` is plain copy for the screen. */
  | { kind: 'unsupported'; reason: string };

export interface SessionUser {
  sub: string;
  email: string;
  name: string | undefined;
  /** The pool's `locale` attribute — what the custom-message trigger renders codes in (I18N-05). */
  locale?: string | undefined;
}

/**
 * Errors the UI distinguishes. `other` carries plain copy for the screen, never
 * the SDK's text (#144): the pool's messages ("PreAuthentication failed with
 * error …", "Incorrect username or password.") are not written for people.
 */
export type AuthFailure =
  | { kind: 'cancelled' }
  | { kind: 'unknown-email' }
  | { kind: 'exists' }
  | { kind: 'wrong-code' }
  | { kind: 'expired-code' }
  | { kind: 'other'; message: string };

/** Plain copy for the pool's other exceptions, by SDK name (#144). */
export function describeOtherFailure(name: string): string {
  switch (name) {
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'Too many attempts for now. Wait a few minutes and try again.';
    case 'NetworkError':
    case 'NetworkingError':
      return 'The service could not be reached. Check the connection and try again.';
    case 'NotAuthorizedException':
      return 'That sign-in did not go through. Check the address and try again.';
    case 'UserLambdaValidationException':
      // The pool's pre-authentication trigger refused: only the pipeline's account is
      // ever refused this way (infra auth-stack), so a person seeing it is in the wrong place.
      return 'This account cannot sign in from here. Contact support.';
    case 'CodeDeliveryFailureException':
      return 'The code could not be sent to this address. Check it and try again.';
    case 'InvalidParameterException':
      return 'Something about that request was not accepted. Check the address and try again.';
    default:
      return 'Something went wrong. Try again, or contact support if it continues.';
  }
}

/**
 * A pool answer that is a failure in GeDe's terms even though the SDK returned
 * it as a next step. `classifyError` hands the failure through unchanged.
 */
export class AuthFailureError extends Error {
  override name = 'AuthFailureError';
  constructor(readonly failure: AuthFailure) {
    super(failure.kind);
  }
}

export function configureAuth(config: AppConfig): void {
  const origin = window.location.origin;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        loginWith: {
          email: true,
          ...(config.appleSignIn
            ? {
                oauth: {
                  domain: config.appleSignIn.domain,
                  scopes: ['openid', 'email', 'profile'],
                  redirectSignIn: [`${origin}/sign-in`],
                  redirectSignOut: [`${origin}/signed-out`],
                  responseType: 'code' as const,
                  providers: ['Apple' as const],
                },
              }
            : {}),
        },
      },
    },
  });
  // AUTH-09: Amplify.configure installs localStorage; swap it for memory afterwards.
  cognitoUserPoolsTokenProvider.setKeyValueStorage(sharedInMemoryStorage);
}

/** Plain copy for the next steps the pool could ask for; the SDK's enum never reaches the screen. */
export function describeUnsupportedStep(step: string): string {
  switch (step) {
    case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
      return 'This account has no passkey yet. Email me a one-time code instead.';
    case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
      return 'This account is set to receive codes by SMS, which GeDe does not send. Contact support.';
    case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
    case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
    case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
    case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
      return 'This account requires an authenticator app, which GeDe does not support. Contact support.';
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
    case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
      return 'This account is set to use a password. GeDe signs in with a passkey or a code by email; contact support.';
    case 'CONFIRM_SIGN_UP':
      return 'This email has not been verified yet. Switch to Create account to finish setting it up.';
    default:
      return 'This account needs a sign-in method GeDe does not offer. Contact support.';
  }
}

/**
 * AUTH-04 under `preventUserExistenceErrors` (ADR-040, #46): the pool never raises
 * UserNotFoundException. An unknown address is answered with one of three shapes,
 * two of which are decidable here:
 *
 * - `SELECT_CHALLENGE` listing the pool's generic factors (PASSWORD, PASSWORD_SRP,
 *   WEB_AUTHN) and no EMAIL_OTP. A known account with a verified address always
 *   lists EMAIL_OTP, so its absence is "no account".
 * - `PasswordResetRequiredException`, which the SDK turns into a RESET_PASSWORD step.
 *   No GeDe account has a password to reset — the SPA client has no password flow
 *   (ADR-011) and recovery is admin-only — so this too can only mean "no account".
 * - A simulated EMAIL_OTP challenge with a masked destination, identical to a real
 *   one. Nothing in the response, and no side-effect-free API, tells them apart
 *   (ResendConfirmationCode is obfuscated for confirmed users as well — measured,
 *   ADR-040). The code step says so and points to Create account.
 */
function toStep(out: SignInOutput): SignInStep {
  const step = out.nextStep;
  switch (step.signInStep) {
    case 'DONE':
      return { kind: 'done' };
    case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
      // Every code a SignInOutput asks for is the EMAIL_OTP first factor: eight digits.
      return { kind: 'code', code: 'sign-in', destination: step.codeDeliveryDetails?.destination };
    case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
      if (!(step.availableChallenges ?? []).includes('EMAIL_OTP')) {
        throw new AuthFailureError({ kind: 'unknown-email' });
      }
      return { kind: 'unsupported', reason: describeUnsupportedStep(step.signInStep) };
    case 'RESET_PASSWORD':
      throw new AuthFailureError({ kind: 'unknown-email' });
    default:
      return { kind: 'unsupported', reason: describeUnsupportedStep(step.signInStep) };
  }
}

export function classifyError(err: unknown): AuthFailure {
  if (err instanceof AuthFailureError) return err.failure;
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'PasskeyAuthenticationCanceled':
    case 'PasskeyRegistrationCanceled':
    case 'PasskeyOperationAborted':
      return { kind: 'cancelled' };
    case 'UserNotFoundException':
    case 'PasswordResetRequiredException': // the obfuscated "no account" (see toStep)
      return { kind: 'unknown-email' };
    case 'UsernameExistsException':
      return { kind: 'exists' };
    case 'CodeMismatchException':
      return { kind: 'wrong-code' };
    case 'ExpiredCodeException':
      return { kind: 'expired-code' };
    default:
      return { kind: 'other', message: describeOtherFailure(name) };
  }
}

/** AUTH-05: Cognito passkeys ride on WebAuthn; hide the option where it is absent. */
export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function';
}

/** AUTH-04/05 — passkey first factor. Amplify runs the WebAuthn ceremony inside `signIn`. */
export async function startPasskeySignIn(email: string): Promise<SignInStep> {
  const out = await signIn({
    username: email,
    options: { authFlowType: 'USER_AUTH', preferredChallenge: 'WEB_AUTHN' },
  });
  return toStep(out);
}

/** AUTH-04/06 — one-time code by email. Calling it again re-sends a fresh code. */
export async function startCodeSignIn(email: string): Promise<SignInStep> {
  const out = await signIn({
    username: email,
    options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
  });
  return toStep(out);
}

export async function confirmCode(code: string): Promise<SignInStep> {
  return toStep(await confirmSignIn({ challengeResponse: code }));
}

/**
 * AUTH-03 sign-up: no password — Cognito's passwordless sign-up. The
 * verification code confirms the address; auto sign-in then continues on the
 * same session without a second code. `locale` is the device's active locale
 * (I18N-05): it becomes the pool's `locale` attribute, which the custom-message
 * trigger reads to render this very confirmation code — and every later code —
 * in that language (infra/assets/custom-message).
 */
export async function startSignUp(email: string, name: string, locale: string): Promise<CodeStep> {
  const out = await signUp({
    username: email,
    options: {
      userAttributes: { email, name, locale },
      autoSignIn: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
    },
  });
  const step = out.nextStep;
  const destination =
    step.signUpStep === 'CONFIRM_SIGN_UP' ? step.codeDeliveryDetails.destination : undefined;
  // The sign-up verification code: six digits, answered by `confirmSignUpCode`.
  return { kind: 'code', code: 'sign-up', destination };
}

export async function confirmSignUpCode(email: string, code: string): Promise<SignInStep> {
  const out = await confirmSignUp({ username: email, confirmationCode: code });
  if (out.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
    return toStep(await autoSignIn());
  }
  // Auto sign-in did not start (e.g. the listener timed out); fall back to a code sign-in.
  // That step is a `sign-in` code — eight digits, answered by `confirmCode` — and says so.
  return startCodeSignIn(email);
}

export async function resendSignUp(email: string): Promise<void> {
  await resendSignUpCode({ username: email });
}

/**
 * I18N-05 — mirror the account's locale choice into the pool's `locale` attribute, so
 * the next sign-in code (sent before the service is ever asked) arrives in that
 * language. A nicety beside `PATCH /api/me`: the caller treats a failure as
 * "saved on this device only". The client may write `locale` (infra auth-stack).
 */
export async function syncLocaleAttribute(locale: string): Promise<void> {
  await updateUserAttributes({ userAttributes: { locale } });
}

/** AUTH-08 — Sign in with Apple through the pool's OIDC provider. */
export async function startAppleSignIn(): Promise<void> {
  await signInWithRedirect({ provider: 'Apple' });
}

/** AUTH-07 — register a passkey for the signed-in user. */
export async function registerPasskey(): Promise<void> {
  await associateWebAuthnCredential();
}

/** AUTH-09 — local sign-out revokes the refresh token and clears memory. */
export async function signOutLocal(): Promise<void> {
  try {
    await signOut({ global: false });
  } finally {
    // "Nothing is left on this device": every local document replica and every
    // per-user table view (ADR-026) goes with the session.
    clearViewState();
    await clearReplicas();
  }
}

export async function currentUser(): Promise<SessionUser | null> {
  try {
    const user = await getCurrentUser();
    let email = '';
    let name: string | undefined;
    let locale: string | undefined;
    try {
      const attrs = await fetchUserAttributes();
      email = attrs.email ?? '';
      name = attrs.name;
      locale = attrs.locale;
    } catch {
      /* attributes are a nicety; the session is what matters */
    }
    return { sub: user.userId, email: email || user.username, name, locale };
  } catch {
    return null;
  }
}

/**
 * A fresh bearer token, forced through Cognito's refresh: for a socket the
 * server closed with 4401, the cached token is exactly what failed.
 */
export async function refreshAccessToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession({ forceRefresh: true });
    return session.tokens?.accessToken.toString() ?? null;
  } catch {
    return null;
  }
}

/**
 * The ID token, for `PATCH /api/me { idToken }` (SHARE-02): it carries the
 * verified email the access token does not, and the service — never this
 * app — decides what to bind from it. Not a bearer credential for anything else.
 */
export async function idToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

/** Bearer token for the API, refreshed silently by Amplify when expired. */
export async function accessToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.accessToken.toString() ?? null;
  } catch {
    return null;
  }
}

export type AuthEvent =
  | 'signedIn'
  | 'signedOut'
  | 'tokenRefresh_failure'
  | 'signInWithRedirect'
  | 'signInWithRedirect_failure';

/** Subscribe to Amplify's auth channel; returns the unsubscribe function. */
export function onAuthEvent(handler: (event: AuthEvent) => void): () => void {
  return Hub.listen('auth', ({ payload }) => {
    switch (payload.event) {
      case 'signedIn':
      case 'signedOut':
      case 'tokenRefresh_failure':
      case 'signInWithRedirect':
      case 'signInWithRedirect_failure':
        handler(payload.event);
        break;
      default:
        break;
    }
  });
}
