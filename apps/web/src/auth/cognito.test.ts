import { describe, expect, it, vi } from 'vitest';
import type * as AmplifyAuth from 'aws-amplify/auth';
import { describeUnsupportedStep } from './cognito.js';

// Amplify's sign-out is the network call; the replica clean-up beside it is what this file checks.
vi.mock('aws-amplify/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof AmplifyAuth>()),
  signOut: vi.fn(() => Promise.resolve()),
}));
const amplifyAuth = await import('aws-amplify/auth');

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
      'This account has no passkey yet. Email me a code instead.',
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
