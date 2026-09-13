import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pool's custom-message trigger (`infra/assets/custom-message/index.mjs`), loaded
 * through a computed specifier so the `.mjs` stays out of infra's TypeScript program;
 * `@gede/mail` resolves to its source through the vitest alias.
 */
const HANDLER = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/custom-message/index.mjs'),
).href;

interface CustomMessageEvent {
  triggerSource: string;
  userPoolId: string;
  userName: string;
  request: {
    userAttributes: Record<string, string>;
    codeParameter: string;
    usernameParameter?: string;
  };
  response: { smsMessage: string | null; emailMessage: string | null; emailSubject: string | null };
}
type Handler = (event: CustomMessageEvent) => Promise<CustomMessageEvent>;

const PLACEHOLDER = '{####}';

function event(
  triggerSource: string,
  attributes: Record<string, string> = { email: 'sembian@example.com' },
): CustomMessageEvent {
  return {
    triggerSource,
    userPoolId: 'ap-southeast-1_TEST',
    userName: 'a1b2c3d4',
    request: { userAttributes: attributes, codeParameter: PLACEHOLDER },
    response: { smsMessage: null, emailMessage: null, emailSubject: null },
  };
}

describe('custom-message trigger', () => {
  let handler: Handler;
  beforeEach(async () => {
    vi.resetModules();
    handler = ((await import(HANDLER)) as { handler: Handler }).handler;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('AUTH-03 the sign-up and resend codes render the branded signUpCode mail with the placeholder once', async () => {
    for (const source of ['CustomMessage_SignUp', 'CustomMessage_ResendCode']) {
      const out = await handler(event(source));
      expect(out.response.emailSubject).toBe('Your GeDe sign-up code');
      expect(out.response.emailMessage!.split(PLACEHOLDER)).toHaveLength(2);
      expect(out.response.emailMessage).toContain('<html lang="en-US"');
      expect(out.response.emailMessage).toContain('https://gede.work/icon-192.png');
      expect(out.response.emailMessage).toContain('sembian@example.com');
      expect(out.response.emailMessage!.length).toBeLessThan(20_000);
      // SMS is not a channel this pool uses; the trigger leaves it alone.
      expect(out.response.smsMessage).toBeNull();
    }
  });

  it('AUTH-04 the EMAIL_OTP sign-in code renders the signInCode mail, subject “Your GeDe sign-in code”', async () => {
    const out = await handler(event('CustomMessage_Authentication'));
    expect(out.response.emailSubject).toBe('Your GeDe sign-in code');
    expect(out.response.emailMessage).toContain('Sign in to GeDe');
    expect(out.response.emailMessage!.split(PLACEHOLDER)).toHaveLength(2);
  });

  it('AUTH-09 an email change renders the emailChangeCode mail for both attribute-verification sources', async () => {
    for (const source of [
      'CustomMessage_UpdateUserAttribute',
      'CustomMessage_VerifyUserAttribute',
    ]) {
      const out = await handler(event(source));
      expect(out.response.emailSubject).toBe('Confirm your new GeDe email address');
      expect(out.response.emailMessage!.split(PLACEHOLDER)).toHaveLength(2);
    }
  });

  it('I18N-05 the locale attribute picks the catalogue; a bare language or an unknown tag falls back', async () => {
    const ta = await handler(
      event('CustomMessage_Authentication', { email: 'a@b.c', locale: 'ta-IN' }),
    );
    expect(ta.response.emailSubject).toBe('உங்கள் GeDe உள்நுழைவுக் குறியீடு');
    expect(ta.response.emailMessage).toContain('<html lang="ta-IN"');
    expect(ta.response.emailMessage!.split(PLACEHOLDER)).toHaveLength(2);
    const hi = await handler(event('CustomMessage_SignUp', { email: 'a@b.c', locale: 'hi' }));
    expect(hi.response.emailMessage).toContain('<html lang="hi-IN"');
    const te = await handler(event('CustomMessage_SignUp', { email: 'a@b.c', locale: 'te-IN' }));
    expect(te.response.emailSubject).toBe('మీ GeDe సైన్-అప్ కోడ్');
    const fr = await handler(event('CustomMessage_SignUp', { email: 'a@b.c', locale: 'fr-FR' }));
    expect(fr.response.emailMessage).toContain('<html lang="en-US"');
    const none = await handler(event('CustomMessage_SignUp', { email: 'a@b.c' }));
    expect(none.response.emailMessage).toContain('<html lang="en-US"');
  });

  it('AUTH-04 an unhandled trigger source is returned untouched, so the pool’s own templates apply', async () => {
    for (const source of [
      'CustomMessage_AdminCreateUser',
      'CustomMessage_ForgotPassword',
      'Nonsense',
    ]) {
      const input = event(source);
      const out = await handler(input);
      expect(out).toBe(input);
      expect(out.response.emailMessage).toBeNull();
      expect(out.response.emailSubject).toBeNull();
    }
  });

  it('AUTH-04 the trigger fails open: a malformed event or a render fault returns the event as received, never a throw', async () => {
    const noPlaceholder = event('CustomMessage_SignUp');
    noPlaceholder.request.codeParameter = '';
    await expect(handler(noPlaceholder)).resolves.toBe(noPlaceholder);
    const noRequest = { triggerSource: 'CustomMessage_SignUp' } as unknown as CustomMessageEvent;
    await expect(handler(noRequest)).resolves.toBe(noRequest);
    await expect(handler(undefined as unknown as CustomMessageEvent)).resolves.toBeUndefined();
    // A response object Cognito did not send (frozen) makes the assignment throw; still no refusal.
    const frozen = event('CustomMessage_SignUp');
    Object.freeze(frozen.response);
    await expect(handler(frozen)).resolves.toBe(frozen);
    expect(console.error).toHaveBeenCalled();
  });
});
