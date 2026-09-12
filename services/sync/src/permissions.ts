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
 * `null`. This is the relationship only; whether a soft-deleted document may
 * be *served* is decided by the caller (`requirePermission`, the WebSocket
 * upgrade): the owner sees it in Recently Deleted, a participant is told it
 * is gone (404), a stranger is told nothing beyond "no access" (403).
 */
export async function resolvePermission(
  repo: Repo,
  userId: string,
  documentId: string,
): Promise<Resolved | undefined> {
  const document = await repo.documents.get(documentId);
  if (!document) return undefined;
  if (document.ownerId === userId) return { document, permission: 'owner' };
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

/**
 * Resolve or throw the matching error-page status (ARCHITECTURE §3): 404 for
 * an unknown document and for a participant of a deleted one ("may have been
 * deleted by its owner"), 403 for a non-participant — deleted or not, and
 * never with the title.
 */
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
  if (resolved.document.deletedAt !== null && permission !== 'owner') {
    throw new AppError(404, 'not_found', 'Nothing at this address');
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
