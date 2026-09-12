import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  configFromEnv,
  loadConfig,
  parseConfig,
  setConfigForTests,
} from './config.js';

const valid = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_abc',
  userPoolClientId: 'client',
  apiUrl: 'https://api.example.test/',
  wsUrl: 'wss://api.example.test/ws',
  appleSignIn: false,
};

describe('parseConfig', () => {
  it('accepts a valid config and trims the trailing slash from apiUrl', () => {
    const c = parseConfig(valid);
    expect(c.apiUrl).toBe('https://api.example.test');
    expect(c.appleSignIn).toBe(false);
    expect(c.statusUrl).toBeNull();
  });

  it('rejects missing or empty required keys', () => {
    expect(() => parseConfig({ ...valid, userPoolId: '' })).toThrow(ConfigError);
    expect(() => parseConfig(null)).toThrow(ConfigError);
  });

  it('normalises appleSignIn and statusUrl', () => {
    expect(
      parseConfig({ ...valid, appleSignIn: { domain: 'auth.example.test' } }).appleSignIn,
    ).toEqual({
      domain: 'auth.example.test',
    });
    expect(() => parseConfig({ ...valid, appleSignIn: true })).toThrow(ConfigError);
    expect(parseConfig({ ...valid, statusUrl: 'https://status.example.test' }).statusUrl).toBe(
      'https://status.example.test',
    );
  });
});

describe('loadConfig', () => {
  afterEach(() => {
    setConfigForTests(null);
  });

  it('fetches /config.json once and caches it', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(valid), { status: 200 })),
    );
    const a = await loadConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const b = await loadConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to VITE_* values in dev when the file 404s', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    const env = {
      VITE_REGION: 'ap-southeast-1',
      VITE_USER_POOL_ID: 'pool',
      VITE_USER_POOL_CLIENT_ID: 'client',
    } as unknown as ImportMetaEnv;
    const c = await loadConfig({ fetchImpl: fetchImpl as unknown as typeof fetch, env, dev: true });
    expect(c.userPoolId).toBe('pool');
    expect(c.apiUrl).toBe('/api');
  });

  it('refuses to boot in production without the file', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(
      loadConfig({ fetchImpl: fetchImpl as unknown as typeof fetch, dev: false }),
    ).rejects.toThrow(ConfigError);
  });

  it('configFromEnv returns null when nothing is set', () => {
    expect(configFromEnv({} as ImportMetaEnv)).toBeNull();
  });
});
