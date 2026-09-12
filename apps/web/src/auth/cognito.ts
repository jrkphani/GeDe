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
  type SignInOutput,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { Hub, sharedInMemoryStorage } from 'aws-amplify/utils';
import type { AppConfig } from '../config.js';

export type SignInStep =
  | { kind: 'done' }
  | { kind: 'code'; destination: string | undefined }
  /** Cognito asked for something GeDe does not offer; `reason` is plain copy for the screen. */
  | { kind: 'unsupported'; reason: string };

export interface SessionUser {
  sub: string;
  email: string;
  name: string | undefined;
}

/** Errors the UI distinguishes; everything else surfaces as `message`. */
export type AuthFailure =
  | { kind: 'cancelled' }
  | { kind: 'unknown-email' }
  | { kind: 'exists' }
  | { kind: 'wrong-code' }
  | { kind: 'expired-code' }
  | { kind: 'other'; message: string };

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
      return 'This account has no passkey yet. Email me a code instead.';
    case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
      return 'This account is set to receive codes by SMS, which GeDe does not send. Contact support.';
    case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
    case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
    case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
    case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
      return 'This account requires an authenticator app, which GeDe does not support. Contact support.';
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
    case 'RESET_PASSWORD':
    case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
      return 'This account is set to use a password. GeDe signs in with a passkey or a code by email; contact support.';
    case 'CONFIRM_SIGN_UP':
      return 'This email has not been verified yet. Switch to Create account to finish setting it up.';
    default:
      return 'This account needs a sign-in method GeDe does not offer. Contact support.';
  }
}

function toStep(out: SignInOutput): SignInStep {
  const step = out.nextStep;
  switch (step.signInStep) {
    case 'DONE':
      return { kind: 'done' };
    case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
      return { kind: 'code', destination: step.codeDeliveryDetails?.destination };
    default:
      return { kind: 'unsupported', reason: describeUnsupportedStep(step.signInStep) };
  }
}

export function classifyError(err: unknown): AuthFailure {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : 'Something went wrong';
  switch (name) {
    case 'PasskeyAuthenticationCanceled':
    case 'PasskeyRegistrationCanceled':
    case 'PasskeyOperationAborted':
      return { kind: 'cancelled' };
    case 'UserNotFoundException':
      return { kind: 'unknown-email' };
    case 'UsernameExistsException':
      return { kind: 'exists' };
    case 'CodeMismatchException':
      return { kind: 'wrong-code' };
    case 'ExpiredCodeException':
      return { kind: 'expired-code' };
    default:
      return { kind: 'other', message };
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
 * same session without a second code.
 */
export async function startSignUp(
  email: string,
  name: string,
): Promise<{ destination: string | undefined }> {
  const out = await signUp({
    username: email,
    options: {
      userAttributes: { email, name },
      autoSignIn: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
    },
  });
  const step = out.nextStep;
  const destination =
    step.signUpStep === 'CONFIRM_SIGN_UP' ? step.codeDeliveryDetails.destination : undefined;
  return { destination };
}

export async function confirmSignUpCode(email: string, code: string): Promise<SignInStep> {
  const out = await confirmSignUp({ username: email, confirmationCode: code });
  if (out.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
    return toStep(await autoSignIn());
  }
  // Auto sign-in did not start (e.g. the listener timed out); fall back to a code sign-in.
  return startCodeSignIn(email);
}

export async function resendSignUp(email: string): Promise<void> {
  await resendSignUpCode({ username: email });
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
  await signOut({ global: false });
}

export async function currentUser(): Promise<SessionUser | null> {
  try {
    const user = await getCurrentUser();
    let email = '';
    let name: string | undefined;
    try {
      const attrs = await fetchUserAttributes();
      email = attrs.email ?? '';
      name = attrs.name;
    } catch {
      /* attributes are a nicety; the session is what matters */
    }
    return { sub: user.userId, email: email || user.username, name };
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
