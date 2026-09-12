import { describe, expect, test } from 'vitest';

import { emailFromClaims } from './auth.js';

describe('emailFromClaims', () => {
  test('AUTH-01 prefers an email claim, falls back to an email-shaped username, else null', () => {
    expect(emailFromClaims({ email: 'a@example.com', username: 'x' })).toBe('a@example.com');
    expect(emailFromClaims({ username: 'b@example.com' })).toBe('b@example.com');
    expect(emailFromClaims({ username: 'SignInWithApple_001234.abcd' })).toBeNull();
    expect(emailFromClaims({ email: 'not-an-email' })).toBeNull();
    expect(emailFromClaims({})).toBeNull();
  });
});
