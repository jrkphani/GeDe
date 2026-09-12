import { describe, expect, it, vi } from 'vitest';
import type * as AmplifyAuth from 'aws-amplify/auth';
import {
  AuthFailureError,
  classifyError,
  describeUnsupportedStep,
  startCodeSignIn,
  startPasskeySignIn,
} from './cognito.js';

// FAKE Amplify boundary: `signIn` answers with the shapes the pool returns; `signOut` is the
// network call beside the replica clean-up this file checks. Everything else is real.
vi.mock('aws-amplify/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AmplifyAuth>()),
  signIn: vi.fn(),
  signUp: vi.fn(),
  updateUserAttributes: vi.fn(),
  signOut: vi.fn(() => Promise.resolve()),
}));
const amplifyAuth = await import('aws-amplify/auth');

type FirstFactorStep = Extract<
  AmplifyAuth.SignInOutput['nextStep'],
  { signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION' }
>;

/** What Amplify makes of Cognito's `SELECT_CHALLENGE` answer under `preventUserExistenceErrors`. */
const selectChallenge = (
  availableChallenges: NonNullable<FirstFactorStep['availableChallenges']>,
): AmplifyAuth.SignInOutput => ({
  isSignedIn: false,
  nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', availableChallenges },
});

describe('sign-in steps', () => {
  it('AUTH-04 an unknown email (SELECT_CHALLENGE without EMAIL_OTP) fails as unknown-email, for the code and the passkey alike', async () => {
    vi.mocked(amplifyAuth.signIn).mockResolvedValue(
      selectChallenge(['PASSWORD_SRP', 'PASSWORD', 'WEB_AUTHN']),
    );
    for (const start of [startCodeSignIn, startPasskeySignIn]) {
      const err = await start('audit-nobody@example.invalid').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthFailureError);
      expect(classifyError(err)).toEqual({ kind: 'unknown-email' });
    }
  });

  it('AUTH-04 a known account without a passkey (SELECT_CHALLENGE with EMAIL_OTP) is a plain next step, not a failure', async () => {
    vi.mocked(amplifyAuth.signIn).mockResolvedValue(selectChallenge(['EMAIL_OTP', 'WEB_AUTHN']));
    await expect(startPasskeySignIn('meena@1cloudhub.com')).resolves.toEqual({
      kind: 'unsupported',
      reason: 'This account has no passkey yet. Email me a one-time code instead.',
    });
  });

  it('AUTH-06 an email code challenge carries the masked destination', async () => {
    vi.mocked(amplifyAuth.signIn).mockResolvedValue({
      isSignedIn: false,
      nextStep: {
        signInStep: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
        codeDeliveryDetails: { destination: 'm***@1cloudhub.com', deliveryMedium: 'EMAIL' },
      },
    });
    await expect(startCodeSignIn('meena@1cloudhub.com')).resolves.toEqual({
      kind: 'code',
      destination: 'm***@1cloudhub.com',
    });
  });

  it('AUTH-04 the obfuscated "password reset required" answer for an unknown email (RESET_PASSWORD step, or the raw exception) is unknown-email too (#46, ADR 040)', async () => {
    // What Amplify makes of the 400 PasswordResetRequiredException the pool sends for some
    // unknown addresses under preventUserExistenceErrors (final audit, 2026-09-13).
    vi.mocked(amplifyAuth.signIn).mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: 'RESET_PASSWORD' },
    });
    for (const start of [startCodeSignIn, startPasskeySignIn]) {
      const err = await start('nobody-final-audit@example.invalid').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthFailureError);
      expect(classifyError(err)).toEqual({ kind: 'unknown-email' });
    }
    const raw = Object.assign(new Error('Password reset required for the user'), {
      name: 'PasswordResetRequiredException',
    });
    expect(classifyError(raw)).toEqual({ kind: 'unknown-email' });
  });

  it('classifyError keeps the pool exceptions it distinguishes and passes AuthFailureError through', () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(classifyError(named('UserNotFoundException'))).toEqual({ kind: 'unknown-email' });
    expect(classifyError(named('PasskeyAuthenticationCanceled'))).toEqual({ kind: 'cancelled' });
    expect(classifyError(new AuthFailureError({ kind: 'exists' }))).toEqual({ kind: 'exists' });
  });

  it('AUTH-05 every other exception becomes plain copy by name; the SDK message never reaches the screen (#144)', () => {
    const named = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(
      classifyError(
        named(
          'UserLambdaValidationException',
          'PreAuthentication failed with error This account signs in only through the pipeline..',
        ),
      ),
    ).toEqual({
      kind: 'other',
      message: 'This account cannot sign in from here. Contact support.',
    });
    expect(classifyError(named('LimitExceededException', 'Attempt limit exceeded'))).toEqual({
      kind: 'other',
      message: 'Too many attempts for now. Wait a few minutes and try again.',
    });
    expect(
      classifyError(named('NotAuthorizedException', 'Incorrect username or password.')),
    ).toEqual({
      kind: 'other',
      message: 'That sign-in did not go through. Check the address and try again.',
    });
    const other = classifyError(new Error('boom'));
    expect(other.kind).toBe('other');
    if (other.kind === 'other') {
      expect(other.message).not.toContain('boom');
      expect(other.message).toBe(
        'Something went wrong. Try again, or contact support if it continues.',
      );
    }
    for (const name of [
      'NetworkError',
      'CodeDeliveryFailureException',
      'InvalidParameterException',
      'TooManyRequestsException',
      'Whatever',
    ]) {
      const f = classifyError(named(name, `raw ${name} text`));
      expect(f.kind).toBe('other');
      if (f.kind === 'other') {
        expect(f.message).not.toContain('raw');
        expect(f.message).not.toMatch(/Exception|Error\b/);
        expect(f.message.endsWith('.')).toBe(true);
      }
    }
  });
});

describe('describeUnsupportedStep', () => {
  it('AUTH-05 maps every pool step to plain copy; the SDK enum never reaches the screen', () => {
    const steps = [
      'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
      'CONFIRM_SIGN_IN_WITH_SMS_CODE',
      'CONFIRM_SIGN_IN_WITH_TOTP_CODE',
      'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
      'CONFIRM_SIGN_UP',
      'SOMETHING_NEW',
    ];
    for (const step of steps) {
      const copy = describeUnsupportedStep(step);
      expect(copy).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
      expect(copy.endsWith('.')).toBe(true);
    }
    expect(describeUnsupportedStep('CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION')).toBe(
      'This account has no passkey yet. Email me a one-time code instead.',
    );
  });
});

describe('locale attribute', () => {
  it('I18N-05 sign-up writes the device locale as the pool’s locale attribute; a locale change updates it', async () => {
    const { startSignUp, syncLocaleAttribute } = await import('./cognito.js');
    vi.mocked(amplifyAuth.signUp).mockResolvedValue({
      isSignUpComplete: false,
      nextStep: {
        signUpStep: 'CONFIRM_SIGN_UP',
        codeDeliveryDetails: { destination: 'm***@1cloudhub.com', deliveryMedium: 'EMAIL' },
      },
    });
    await expect(startSignUp('meena@1cloudhub.com', 'Meena', 'ta-IN')).resolves.toEqual({
      destination: 'm***@1cloudhub.com',
    });
    expect(amplifyAuth.signUp).toHaveBeenCalledWith({
      username: 'meena@1cloudhub.com',
      options: {
        userAttributes: { email: 'meena@1cloudhub.com', name: 'Meena', locale: 'ta-IN' },
        autoSignIn: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
      },
    });
    vi.mocked(amplifyAuth.updateUserAttributes).mockResolvedValue(
      {} as AmplifyAuth.UpdateUserAttributesOutput,
    );
    await syncLocaleAttribute('hi-IN');
    expect(amplifyAuth.updateUserAttributes).toHaveBeenCalledWith({
      userAttributes: { locale: 'hi-IN' },
    });
  });
});

describe('signOutLocal', () => {
  it('AUTH-09 clears every local document replica so nothing is left on this device', async () => {
    const { signOutLocal } = await import('./cognito.js');
    const { IndexeddbPersistence } = await import('y-indexeddb');
    const { Doc } = await import('yjs');
    const { registerReplica, replicaStoreName } = await import('../doc/replica.js');
    const name = replicaStoreName('sub-1', 'doc-signout');
    const persistence = new IndexeddbPersistence(name, new Doc());
    registerReplica(name);
    await persistence.whenSynced;
    await persistence.destroy();
    const before = (await indexedDB.databases()).map((d) => d.name);
    expect(before).toContain(name);
    await signOutLocal();
    const after = (await indexedDB.databases()).map((d) => d.name);
    expect(after).not.toContain(name);
    expect(amplifyAuth.signOut).toHaveBeenCalledWith({ global: false });
  });
});
