import { accessToken } from '../auth/cognito.js';
import { getConfig } from '../config.js';

/** A non-2xx response, carrying what the error pages need. */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    public readonly status: number,
    message: string,
    /** Server request id (`x-request-id`) for the copyable reference. */
    public readonly requestId: string | undefined,
    /** Parsed JSON body when the server sent one. */
    public readonly body?: unknown,
    /** Attempts made before giving up (for the "attempt 3 of 4" meta). */
    public readonly attempts = 1,
  ) {
    super(message);
  }
}

/** Retry policy from the error-pages spec: 5xx and 429 retry, four attempts, exponential and jittered; 4xx never. */
export const MAX_ATTEMPTS = 4;
export const BASE_DELAY_MS = 400;

export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** attempt is 1-based; returns the wait before the *next* attempt. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = 0.5 + random(); // 0.5x – 1.5x
  return Math.round(exp * jitter);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /**
   * Retry 5xx / 429 / network failures with backoff. Opt-in: on by default
   * for GET only, which is safe to repeat; a write that the service may have
   * applied before answering (or that answers 5xx by design, such as an
   * invitation whose mail was refused) must ask for it explicitly. Review of
   * #76: an unretried `POST /invites` used to become four rows, four mails
   * and four units of the invitation budget.
   */
  retry?: boolean | undefined;
  /** Test seams. */
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  getToken?: (() => Promise<string | null>) | undefined;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Authenticated JSON request against `{apiUrl}{path}`. Resolves with the parsed
 * body (or `undefined` for 204). Throws `ApiError` after retries are exhausted.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const getToken = options.getToken ?? accessToken;
  const url = `${getConfig().apiUrl}${path}`;
  const method = options.method ?? 'GET';
  const retry = options.retry ?? method === 'GET';
  const maxAttempts = retry ? MAX_ATTEMPTS : 1;

  let lastError: ApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const token = await getToken();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      const init: RequestInit = { method, headers, credentials: 'omit' };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      if (options.signal !== undefined) init.signal = options.signal;
      res = await fetchImpl(url, init);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      // Network failure: treat like a 503 and retry with backoff.
      lastError = new ApiError(503, 'Network request failed', undefined, undefined, attempt);
      if (attempt < maxAttempts) await sleep(backoffDelay(attempt));
      continue;
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }

    const requestId = res.headers.get('x-request-id') ?? undefined;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    lastError = new ApiError(
      res.status,
      `${res.status} ${res.statusText}`,
      requestId,
      body,
      attempt,
    );
    if (!isRetryable(res.status) || attempt === maxAttempts) throw lastError;
    await sleep(retryAfterMs(res) ?? backoffDelay(attempt));
  }
  // Unreachable in practice; the loop either returns or throws.
  throw lastError ?? new ApiError(500, 'Request failed', undefined);
}
