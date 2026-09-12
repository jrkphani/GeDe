import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigForTests } from '../config.js';
import { getMe, toMe, updateMe } from './me.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('me api', () => {
  beforeEach(() => {
    setConfigForTests({
      region: 'r',
      userPoolId: 'p',
      userPoolClientId: 'c',
      apiUrl: 'https://api.test',
      wsUrl: 'wss://api.test/ws',
      appleSignIn: false,
      statusUrl: null,
    });
  });
  afterEach(() => {
    setConfigForTests(null);
  });

  it('I18N-05 GET /me carries the persisted locale; a profile without one reads null', async () => {
    expect(toMe({ id: 'u1', sub: 's', email: null, displayName: 'M' })).toEqual({
      id: 'u1',
      sub: 's',
      email: null,
      displayName: 'M',
      locale: null,
    });
    expect(toMe({ sub: 's' })).toBeNull();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json(200, { id: 'u1', sub: 's', email: 'm@x.test', locale: 'en-IN' })),
    );
    const me = await getMe({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('t'),
    });
    expect(me.locale).toBe('en-IN');
  });

  it('I18N-05 PATCH /me sends only the fields given', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    await updateMe(
      { locale: 'ta-IN' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: () => Promise.resolve('t') },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/me');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ locale: 'ta-IN' });
  });
});
