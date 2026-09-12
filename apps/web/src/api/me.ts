import { apiFetch, type RequestOptions } from './client.js';

/** LIB-05: the two library sorts the account can choose. */
export type LibrarySort = 'name' | 'date';

/**
 * `GET /api/me` → `{ id, sub, email, displayName, locale, tourDoneAt, librarySort, sampleDocumentId }`.
 * The locale is the user's persisted choice (I18N-05). `tourDoneAt` is the
 * per-account guided-tour flag (ONB-03): null while the tour is due.
 * `librarySort` is the Browse / Shared sort the account chose (LIB-05, #133):
 * null until chosen. `sampleDocumentId` is the account's guided sample
 * workscape (ONB-01), seeded by the service; null only on a service that
 * predates it.
 */
export interface Me {
  id: string;
  sub: string;
  email: string | null;
  displayName: string | null;
  locale: string | null;
  tourDoneAt: string | null;
  librarySort: LibrarySort | null;
  sampleDocumentId: string | null;
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
    tourDoneAt: strOrNull(v.tourDoneAt),
    librarySort: v.librarySort === 'name' || v.librarySort === 'date' ? v.librarySort : null,
    sampleDocumentId: strOrNull(v.sampleDocumentId),
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
  /** ONB-03: `true` when the tour ends (completed or skipped); `false` on Replay (ONB-08). */
  tourDone?: boolean | undefined;
  /** LIB-05 (#133): the library sort, per account. */
  librarySort?: LibrarySort | undefined;
}

/** `PATCH /api/me { displayName?, locale?, tourDone?, librarySort? }`. Resolves the profile as stored. */
export async function updateMe(patch: MePatch, options?: RequestOptions): Promise<Me> {
  const me = toMe(
    await apiFetch<unknown>('/me', { ...options, method: 'PATCH', body: patch, retry: true }),
  );
  if (!me) throw new Error('The profile response was not in the expected shape');
  return me;
}

/**
 * SHARE-02: `PATCH /api/me { idToken }`. The service verifies the Cognito ID
 * token itself and binds the address it attests — the SPA never sends the
 * address as a plain string. Pending invitations for that address become
 * shares in the same call. Resolves the profile as bound.
 */
export async function bindVerifiedEmail(idToken: string, options?: RequestOptions): Promise<Me> {
  const me = toMe(
    await apiFetch<unknown>('/me', { ...options, method: 'PATCH', body: { idToken }, retry: true }),
  );
  if (!me) throw new Error('The profile response was not in the expected shape');
  return me;
}
