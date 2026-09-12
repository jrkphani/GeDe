/**
 * Permission Guard (ARCHITECTURE §1.3): who may do what with a document.
 * Consulted on every REST call and on every WebSocket upgrade; the room then
 * enforces the resolved permission on every sync message (SHARE-03).
 */
import { AppError } from './errors.js';
import type { DocumentPermission, DocumentRecord, Repo } from './repo/types.js';

export interface Resolved {
  readonly document: DocumentRecord;
  /** `null` when the user has no relationship with the document. */
  readonly permission: DocumentPermission | null;
}

/**
 * `owner` for the owner, the share's permission for a participant, otherwise
 * `null`. Soft-deleted documents are visible to their owner only (for the
 * Recently Deleted view) and never to participants.
 */
export async function resolvePermission(
  repo: Repo,
  userId: string,
  documentId: string,
): Promise<Resolved | undefined> {
  const document = await repo.documents.get(documentId);
  if (!document) return undefined;
  if (document.ownerId === userId) return { document, permission: 'owner' };
  if (document.deletedAt !== null) return { document, permission: null };
  const shared = await repo.documents.sharePermission(documentId, userId);
  if (shared !== undefined) return { document, permission: shared };
  // TODO(SHARE-01 link access): when `document.linkAccess` is `view` or `edit`
  // and the request presents the document's `link_token`, grant that level.
  // Until the link flow ships this branch grants nothing — no fabricated access.
  return { document, permission: null };
}

export function permissionFor(
  repo: Repo,
  userId: string,
  documentId: string,
): Promise<DocumentPermission | null> {
  return resolvePermission(repo, userId, documentId).then((r) => r?.permission ?? null);
}

export function canEdit(permission: DocumentPermission | null): boolean {
  return permission === 'owner' || permission === 'edit';
}

/** Resolve or throw the matching error-page status: 404 unknown, 403 not a participant. */
export async function requirePermission(
  repo: Repo,
  userId: string,
  documentId: string,
  minimum: 'view' | 'edit' | 'owner',
): Promise<Resolved & { permission: DocumentPermission }> {
  const resolved = await resolvePermission(repo, userId, documentId);
  if (!resolved) throw new AppError(404, 'not_found', 'Nothing at this address');
  const { permission } = resolved;
  if (permission === null) {
    throw new AppError(403, 'forbidden', 'You do not have access to this workscape');
  }
  const allowed =
    minimum === 'view' ||
    (minimum === 'edit' && canEdit(permission)) ||
    (minimum === 'owner' && permission === 'owner');
  if (!allowed) {
    throw new AppError(403, 'forbidden', 'You do not have access to this workscape');
  }
  return { document: resolved.document, permission };
}
