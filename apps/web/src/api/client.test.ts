import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfigForTests } from '../config.js';
import { ApiError, apiFetch, backoffDelay, isRetryable } from './client.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('api client', () => {
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

  it('sends the bearer token and parses JSON', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(200, { ok: true })));
    const out = await apiFetch<{ ok: boolean }>('/documents', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => Promise.resolve('tok'),
    });
    expect(out).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/documents');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('retries 5xx and 429 up to four attempts with backoff, then throws with the attempt count', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(503, {}, { 'x-request-id': 'abc123def' })));
    const sleep = vi.fn(() => Promise.resolve());
    const err = await apiFetch('/documents', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      getToken: () => Promise.resolve(null),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).attempts).toBe(4);
    expect((err as ApiError).requestId).toBe('abc123def');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After on 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    const sleep = vi.fn(() => Promise.resolve());
    await apiFetch('/documents', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      getToken: () => Promise.resolve(null),
    });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('never retries 4xx', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(json(404, { message: 'no' })));
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      apiFetch('/documents/x', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
        getToken: () => Promise.resolve(null),
      }),
    ).rejects.toMatchObject({ status: 404, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats a network failure as retryable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(json(200, []));
    const sleep = vi.fn(() => Promise.resolve());
    const out = await apiFetch('/documents', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      getToken: () => Promise.resolve(null),
    });
    expect(out).toEqual([]);
  });

  it('backoff is exponential and jittered within 0.5x–1.5x', () => {
    expect(backoffDelay(1, () => 0)).toBe(200);
    expect(backoffDelay(1, () => 1)).toBe(600);
    expect(backoffDelay(3, () => 0.5)).toBe(1600);
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(400)).toBe(false);
  });
});
