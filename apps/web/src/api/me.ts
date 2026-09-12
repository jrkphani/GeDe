import { apiFetch, type RequestOptions } from './client.js';

/**
 * `GET /api/me` → `{ id, sub, email, displayName, locale }`. The locale is
 * the user's persisted choice (I18N-05); absent until the sync API carries it.
 */
export interface Me {
  id: string;
  sub: string;
  email: string | null;
  displayName: string | null;
  locale: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function toMe(v: unknown): Me | null {
  if (!isRecord(v)) return null;
  const id = strOrNull(v.id);
  const sub = strOrNull(v.sub);
  if (id === null || sub === null) return null;
  return {
    id,
    sub,
    email: strOrNull(v.email),
    displayName: strOrNull(v.displayName),
    locale: strOrNull(v.locale),
  };
}

export async function getMe(options?: RequestOptions): Promise<Me> {
  const me = toMe(await apiFetch<unknown>('/me', options));
  if (!me) throw new Error('The profile response was not in the expected shape');
  return me;
}

export interface MePatch {
  displayName?: string | undefined;
  locale?: string | undefined;
}

/** `PATCH /api/me { displayName?, locale? }`. */
export async function updateMe(patch: MePatch, options?: RequestOptions): Promise<void> {
  await apiFetch<unknown>('/me', { ...options, method: 'PATCH', body: patch });
}
