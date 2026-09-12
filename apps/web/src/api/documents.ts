import { apiFetch, type RequestOptions } from './client.js';

/**
 * Documents API (services/sync, wave 1 contract). Field names follow the data
 * model in ARCHITECTURE-DIGEST §1.5; anything the server omits is treated as
 * absent, never invented.
 */
export type DocumentPermission = 'owner' | 'edit' | 'view';
export type DocumentKind = 'workscape';
export type DocumentsView = 'recents' | 'browse' | 'shared' | 'deleted' | 'archived';
export type LinkAccess = 'none' | 'view' | 'edit';

export interface Sharer {
  id: string;
  /** Null when the sharer has not set a display name. Never invent one. */
  name: string | null;
}

/**
 * What the reader guarantees: `id`, `title`, `updatedAt`, `createdAt`,
 * `ownerId`. The rest is optional so a response from before the wave-1 API
 * (or a partial fixture) still types; the reader fills the defaults below.
 */
export interface DocumentSummary {
  id: string;
  title: string;
  kind?: DocumentKind | undefined;
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  ownerName?: string | null | undefined;
  /** Set when another participant shared it with the caller. */
  sharedBy?: Sharer | undefined;
  /**
   * The service's one definition of "shared" (#139): a participant exists (a
   * share) or the link is on — the same facts as `everShared` (LIB-D1/D4), so
   * the title pill (SHARE-05), the library row (LIB-02), the Shared view
   * (LIB-01) and the delete/archive slot agree. A pending invitation is not a
   * participant and does not count.
   */
  sharedWithOthers?: boolean | undefined;
  /** Absent means the server did not say; the UI then treats the caller as a viewer. */
  permission?: DocumentPermission | undefined;
  sizeBytes?: number | undefined;
  deletedAt?: string | null | undefined;
  /** LIB-D6: set while archived by the owner. */
  archivedAt?: string | null | undefined;
  /**
   * LIB-D2/D4: true while the workscape has been shared and access remains —
   * a participant, or the link on. The server refuses Delete while it is true;
   * the toolbar offers Archive instead. Absent means the server did not say,
   * which is read as not shared (Delete stays offered; the server has the last word).
   */
  everShared?: boolean | undefined;
  /**
   * ONB-01 / LIB-D10: the caller's own guided sample — pinned first, badged
   * `Sample`, the tour's step-1 anchor; Delete and Archive are disabled for it.
   * The service answers false for someone else's sample shared with the caller.
   */
  sample?: boolean | undefined;
  linkAccess?: LinkAccess | undefined;
}

export interface Participant {
  userId: string;
  name: string | null;
  email: string | null;
  permission: 'edit' | 'view';
  invitedBy: string | undefined;
  /** `link`: came in through "anyone with the link"; the share goes with the link. */
  source: 'invite' | 'link';
}

export interface DocumentShares {
  owner: { id: string; name: string | null; email: string | null };
  participants: Participant[];
  linkAccess: 'none' | 'view' | 'edit';
}

/** Something to call a person by: their name, else their email, else nothing invented. */
export function displayNameOf(p: { name: string | null; email?: string | null }): string | null {
  return p.name ?? p.email ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toSharer(v: unknown): Sharer | undefined {
  if (!isRecord(v)) return undefined;
  const id = str(v.id);
  return id !== undefined ? { id, name: strOrNull(v.name) } : undefined;
}

function toPermission(v: unknown): DocumentPermission | undefined {
  return v === 'owner' || v === 'edit' || v === 'view' ? v : undefined;
}

/** What the caller may do; an unstated permission is read as view-only. */
export function permissionOf(doc: DocumentSummary): DocumentPermission {
  return doc.permission ?? 'view';
}

/**
 * LIB-D1/D2: what the fourth toolbar slot offers for a live row. `delete`
 * while nobody else holds access; `archive` once someone does (or the link
 * is on); `sample` for the guided sample, which offers neither (LIB-D10).
 */
export type DeletionMode = 'delete' | 'archive' | 'sample';

export function deletionModeOf(doc: DocumentSummary): DeletionMode {
  if (doc.sample === true) return 'sample';
  return doc.everShared === true ? 'archive' : 'delete';
}

/** Tolerant reader: required fields must be strings; optional ones are kept only when well-typed. */
export function toDocumentSummary(v: unknown): DocumentSummary | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const title = str(v.title);
  const updatedAt = str(v.updatedAt);
  if (id === undefined || title === undefined || updatedAt === undefined) return null;
  return {
    id,
    title,
    kind: 'workscape',
    updatedAt,
    createdAt: str(v.createdAt) ?? updatedAt,
    ownerId: str(v.ownerId) ?? '',
    ownerName: strOrNull(v.ownerName),
    sharedBy: toSharer(v.sharedBy),
    sharedWithOthers: v.sharedWithOthers === true,
    permission: toPermission(v.permission),
    sizeBytes: typeof v.sizeBytes === 'number' ? v.sizeBytes : undefined,
    deletedAt: str(v.deletedAt) ?? null,
    archivedAt: str(v.archivedAt) ?? null,
    everShared: v.everShared === true,
    sample: v.sample === true,
    linkAccess: v.linkAccess === 'view' || v.linkAccess === 'edit' ? v.linkAccess : 'none',
  };
}

/** Single-document responses arrive as `{ document }`; accept a bare object too. */
function unwrapDocument(raw: unknown): DocumentSummary | null {
  if (isRecord(raw) && 'document' in raw) return toDocumentSummary(raw.document);
  return toDocumentSummary(raw);
}

function encode(id: string): string {
  return encodeURIComponent(id);
}

/** `GET /api/documents?view=` — the server scopes the list; the client orders and groups it. */
export async function listDocuments(
  view: DocumentsView,
  options?: RequestOptions,
): Promise<DocumentSummary[]> {
  const raw = await apiFetch<unknown>(`/documents?view=${view}`, options);
  const items = isRecord(raw) && Array.isArray(raw.documents) ? raw.documents : [];
  return items.map(toDocumentSummary).filter((d): d is DocumentSummary => d !== null);
}

export async function getDocument(id: string, options?: RequestOptions): Promise<DocumentSummary> {
  const doc = unwrapDocument(await apiFetch<unknown>(`/documents/${encode(id)}`, options));
  if (!doc) throw new Error('The document response was not in the expected shape');
  return doc;
}

/** LIB-06: the + control creates an untitled workscape. */
export async function createDocument(options?: RequestOptions): Promise<DocumentSummary> {
  const doc = unwrapDocument(
    await apiFetch<unknown>('/documents', {
      ...options,
      method: 'POST',
      body: { title: 'Untitled' },
    }),
  );
  if (!doc) throw new Error('The create response was not in the expected shape');
  return doc;
}

export async function renameDocument(
  id: string,
  title: string,
  options?: RequestOptions,
): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}`, {
    ...options,
    method: 'PATCH',
    body: { title },
    retry: true,
  });
}

/**
 * Soft delete: the workscape moves to Recently Deleted for 30 days (LIB-08,
 * LIB-D5). The server answers 409 `shared` for a workscape someone holds
 * access to (LIB-D2) and 409 `sample` for the guided sample (LIB-D10).
 */
export async function deleteDocument(id: string, options?: RequestOptions): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}`, {
    ...options,
    method: 'DELETE',
    retry: true,
  });
}

/** Owner only; a workscape that is not in Recently Deleted answers 409 `conflict`. */
export async function recoverDocument(id: string, options?: RequestOptions): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/recover`, {
    ...options,
    method: 'POST',
    retry: true,
  });
}

/** LIB-D3: archive keeps every participant's access; the row leaves the owner's views only. */
export async function archiveDocument(id: string, options?: RequestOptions): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/archive`, {
    ...options,
    method: 'POST',
    retry: true,
  });
}

/** LIB-D6: back into the owner's views; a workscape that is not archived answers 409 `conflict`. */
export async function unarchiveDocument(id: string, options?: RequestOptions): Promise<void> {
  await apiFetch<unknown>(`/documents/${encode(id)}/unarchive`, {
    ...options,
    method: 'POST',
    retry: true,
  });
}

function countOf(raw: unknown, key: string): number {
  return isRecord(raw) && typeof raw[key] === 'number' ? raw[key] : 0;
}

export interface RecoveredAll {
  count: number;
  /** The recovered ids, so Undo can delete each again (LIB-D9). Empty when the server sent none. */
  ids: string[];
}

/** Recovers everything deleted within the 30-day window; resolves with how many, and which. */
export async function recoverAllDocuments(options?: RequestOptions): Promise<RecoveredAll> {
  const raw = await apiFetch<unknown>('/documents/recover-all', {
    ...options,
    method: 'POST',
    retry: true,
  });
  const ids =
    isRecord(raw) && Array.isArray(raw.ids)
      ? raw.ids.filter((id): id is string => typeof id === 'string')
      : [];
  return { count: countOf(raw, 'recovered'), ids };
}

/** Permanent: purges everything in Recently Deleted; resolves with how many. */
export async function deleteAllDocuments(options?: RequestOptions): Promise<number> {
  const raw = await apiFetch<unknown>('/documents/delete-all', {
    ...options,
    method: 'POST',
    retry: true,
  });
  return countOf(raw, 'deleted');
}

function toParticipant(v: unknown): Participant | null {
  if (!isRecord(v)) return null;
  const userId = str(v.userId);
  if (userId === undefined) return null;
  return {
    userId,
    name: strOrNull(v.name),
    email: strOrNull(v.email),
    permission: v.permission === 'edit' ? 'edit' : 'view',
    invitedBy: str(v.invitedBy),
    source: v.source === 'link' ? 'link' : 'invite',
  };
}

export function toDocumentShares(v: unknown): DocumentShares | null {
  if (!isRecord(v) || !isRecord(v.owner)) return null;
  const ownerId = str(v.owner.id);
  if (ownerId === undefined) return null;
  const participants = Array.isArray(v.participants)
    ? v.participants.map(toParticipant).filter((p): p is Participant => p !== null)
    : [];
  const linkAccess = v.linkAccess === 'view' || v.linkAccess === 'edit' ? v.linkAccess : 'none';
  return {
    owner: { id: ownerId, name: strOrNull(v.owner.name), email: strOrNull(v.owner.email) },
    participants,
    linkAccess,
  };
}

/** LIB-07: everyone with permission on a workscape. */
export async function getDocumentShares(
  id: string,
  options?: RequestOptions,
): Promise<DocumentShares> {
  const shares = toDocumentShares(
    await apiFetch<unknown>(`/documents/${encode(id)}/shares`, options),
  );
  if (!shares) throw new Error('The shares response was not in the expected shape');
  return shares;
}
