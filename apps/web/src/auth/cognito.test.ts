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

  it('classifyError keeps the pool exceptions it distinguishes and passes AuthFailureError through', () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(classifyError(named('UserNotFoundException'))).toEqual({ kind: 'unknown-email' });
    expect(classifyError(named('PasskeyAuthenticationCanceled'))).toEqual({ kind: 'cancelled' });
    expect(classifyError(new AuthFailureError({ kind: 'exists' }))).toEqual({ kind: 'exists' });
    expect(classifyError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
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
