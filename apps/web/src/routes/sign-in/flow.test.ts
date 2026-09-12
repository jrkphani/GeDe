import { describe, expect, it } from 'vitest';
import { canContinue, flowReducer, initialFlow, isValidEmail } from './flow.js';

describe('sign-in flow reducer', () => {
  it('AUTH-03 Continue is disabled until the email is syntactically valid', () => {
    expect(canContinue(initialFlow({ email: 'meena' }))).toBe(false);
    expect(canContinue(initialFlow({ email: 'meena@1cloudhub' }))).toBe(false);
    expect(canContinue(initialFlow({ email: 'meena@1cloudhub.com' }))).toBe(true);
    expect(isValidEmail(' a@b.co ')).toBe(true);
  });

  it('AUTH-03 sign-up additionally needs a display name', () => {
    const s = initialFlow({ mode: 'sign-up', email: 'meena@1cloudhub.com' });
    expect(canContinue(s)).toBe(false);
    expect(canContinue({ ...s, name: 'Meena' })).toBe(true);
  });

  it('AUTH-02 switching mode keeps the typed email and returns to the email step', () => {
    let s = initialFlow({ email: 'meena@1cloudhub.com' });
    s = flowReducer(s, { type: 'go-method' });
    s = flowReducer(s, { type: 'go-code', purpose: 'sign-in', destination: 'm***@1cloudhub.com' });
    s = flowReducer(s, { type: 'set-code', code: '123' });
    s = flowReducer(s, { type: 'set-mode', mode: 'sign-up' });
    expect(s.mode).toBe('sign-up');
    expect(s.step).toBe('email');
    expect(s.email).toBe('meena@1cloudhub.com');
    expect(s.code).toBe('');
  });

  it('busy/error/notice transitions clear each other', () => {
    let s = flowReducer(initialFlow(), { type: 'busy', busy: 'code' });
    expect(s.busy).toBe('code');
    s = flowReducer(s, { type: 'error', message: 'nope' });
    expect(s.busy).toBeNull();
    expect(s.error).toBe('nope');
    s = flowReducer(s, { type: 'set-code', code: '1' });
    expect(s.error).toBeNull();
  });
});
