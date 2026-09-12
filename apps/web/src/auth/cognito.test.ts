import { describe, expect, it } from 'vitest';
import { describeUnsupportedStep } from './cognito.js';

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
