/**
 * REST under `/api` (ARCHITECTURE §1.3 "Documents & Sharing API"). Every route
 * here runs behind the auth hook; `request.user` is always set.
 *
 * Library (LIB-01, LIB-02, LIB-08, LIB-D1..D11: delete vs archive), profile
 * (AUTH-09, I18N-05) and the single-document routes. Sharing — the participant list, invitations,
 * permission changes, link access, stop sharing (LIB-07, SHARE-01, SHARE-02)
 * — is in `share.ts`, registered from here under the same hooks.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { encodeSeededDocument } from '@gede/core';

import { currentUser, requireUser, toAuthUser, type AuthUser, type UserResolver } from '../auth.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { count } from '../metrics.js';
import { canEdit, requirePermission } from '../permissions.js';
import type { ProjectionWorker } from '../projection/worker.js';
import {
  EmailTakenError,
  type DocumentListing,
  type DocumentPermission,
  type DocumentRecord,
  type DocumentSummary,
  type ProfilePatch,
  type PurgedDocument,
} from '../repo/types.js';
import { documentPrefix, snapshotKey } from '../s3.js';
import type { RoomManager } from '../ws/room-manager.js';
import { CLOSE_FORBIDDEN, CLOSE_NOT_FOUND } from '../ws/route.js';
import { NOT_FOUND, oneLine, parse, parseId } from './parse.js';
import { registerShareRoutes } from './share.js';

/** I18N-05: the locales the product ships (root CLAUDE.md "Numbers, dates, collation go through Intl"). */
export const SUPPORTED_LOCALES = ['en-US', 'en-GB', 'en-IN', 'ta-IN', 'hi-IN', 'te-IN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LIBRARY_VIEWS = ['recents', 'browse', 'shared', 'deleted', 'archived'] as const;

const titleSchema = oneLine(200);
const createBody = z.object({ title: titleSchema.optional() }).strict().default({});
const patchBody = z.object({ title: titleSchema }).strict();
const listQuery = z.object({ view: z.enum(LIBRARY_VIEWS).default('recents') });
/** FIND-03: a search phrase; every word must match. Control characters are refused as for titles. */
const searchQuery = z.object({ q: oneLine(200) });

/** Most hits one search answers (the find bar pages nothing yet). */
export const SEARCH_LIMIT = 50;
/** Characters of context either side of the first match in a snippet. */
const SNIPPET_CONTEXT = 40;
/**
 * `idToken` (SHARE-02, #42): the SPA's Cognito ID token, verified server-side
 * to bind the caller's address. A JWT is three base64url segments; anything
 * else is refused before the verifier sees it.
 */
const profileBody = z
  .object({
    displayName: oneLine(80).optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    idToken: z
      .string()
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u, 'Not a token')
      .optional(),
    /** ONB-03 / ONB-07 / ONB-08: `true` when the tour ends (done or skipped), `false` on Replay. */
    tourDone: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.locale !== undefined ||
      b.idToken !== undefined ||
      b.tourDone !== undefined,
    { message: 'Nothing to change' },
  );

/** The seed snapshot's sequence number; the first client update is seq 2. */
export const INITIAL_SNAPSHOT_SEQ = 1;

/** Documents per transaction for Delete All (#109): bounded like the nightly purge. */
export const DELETE_ALL_BATCH_SIZE = 50;

/** What `DELETE /api/me` answers (#111, ADR-038). */
export interface ErasureView {
  erased: true;
  /** `deleted` when the Cognito user is gone; `skipped` when the deploy has not enabled it; `failed` when Cognito refused (logged, alarmed). */
  identity: 'deleted' | 'skipped' | 'failed';
  documentsTransferred: number;
  documentsDeleted: number;
}

/** A document as the API returns it. Only `workscape` exists as a kind today. */
export interface DocumentView {
  id: string;
  title: string;
  kind: 'workscape';
  ownerId: string;
  permission: DocumentPermission;
  linkAccess: DocumentRecord['linkAccess'];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** LIB-D6: set while archived. */
  archivedAt: string | null;
  /** LIB-D2/D4: true while the document has been shared and access remains; Delete is refused. */
  everShared: boolean;
  /**
   * ONB-01 / LIB-D10: the caller's own guided sample — pinned, flagged
   * `Sample`, the tour's step-1 target; Delete and Archive are refused.
   * Someone else's sample shared with the caller is an ordinary shared row,
   * so this is false for it.
   */
  sample: boolean;
}

/** A library row (LIB-02): the document plus size, owner and sharing facts. */
export interface DocumentSummaryView extends DocumentView {
  sizeBytes: number;
  ownerName: string | null;
  sharedBy?: { id: string; name: string | null };
  sharedWithOthers: boolean;
}

export interface ProfileView {
  id: string;
  sub: string;
  email: string | null;
  displayName: string | null;
  locale: string | null;
  /** ONB-03: ISO time the tour was completed or skipped; null means the tour is due. */
  tourDoneAt: string | null;
  /** ONB-01: the account's guided sample workscape. */
  sampleDocumentId: string | null;
}

function view(doc: DocumentRecord, permission: DocumentPermission): DocumentView {
  return {
    id: doc.id,
    title: doc.title,
    kind: 'workscape',
    ownerId: doc.ownerId,
    permission,
    linkAccess: doc.linkAccess,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    deletedAt: doc.deletedAt?.toISOString() ?? null,
    archivedAt: doc.archivedAt?.toISOString() ?? null,
    everShared: doc.everShared,
    // ONB-01: "the sample" in a library is the caller's own; a participant on
    // someone else's sample sees a shared workscape like any other.
    sample: doc.sample && permission === 'owner',
  };
}

/** LIB-D10: the guided sample is exempt from Delete and Archive; say which. */
function refuseSample(
  doc: Pick<DocumentRecord, 'sample'>,
  verb: 'deleted' | 'archived' | 'renamed',
): void {
  if (doc.sample) {
    throw new AppError(409, 'sample', `The guided sample cannot be ${verb}`);
  }
}

/**
 * A person's name as the library shows it to `permission` (#102, the share
 * sheet's rule): the display name; failing that the address, but only for
 * the owner and editors — a viewer, or anyone who redeemed a view link, is
 * never handed an email address.
 */
export function personName(
  person: { name: string | null; email: string | null },
  permission: DocumentPermission,
): string | null {
  return person.name ?? (canEdit(permission) ? person.email : null);
}

function summaryView(doc: DocumentSummary, permission: DocumentPermission): DocumentSummaryView {
  const out: DocumentSummaryView = {
    ...view(doc, permission),
    sizeBytes: doc.sizeBytes,
    ownerName: personName({ name: doc.ownerName, email: doc.ownerEmail }, permission),
    sharedWithOthers: doc.sharedWithOthers,
  };
  if (doc.sharedBy !== null) {
    out.sharedBy = { id: doc.sharedBy.id, name: personName(doc.sharedBy, permission) };
  }
  return out;
}

function viewListing(listing: DocumentListing): DocumentSummaryView {
  return summaryView(listing, listing.permission);
}

function profileView(user: AuthUser): ProfileView {
  return {
    id: user.id,
    sub: user.sub,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale,
    tourDoneAt: user.tourDoneAt === null ? null : user.tourDoneAt.toISOString(),
    sampleDocumentId: user.sampleDocumentId,
  };
}

/** One hit as the API returns it (FIND-03); ids locate the cell, the snippet previews it. */
export interface SearchHitView {
  sheetId: string;
  tableId: string;
  rowId: string;
  columnId: string;
  snippet: string;
}

/**
 * A short window of the cell text around the first word of the query
 * (case-insensitive), with ellipses where it was cut. Falls back to the
 * head of the text when the words matched only after normalisation.
 */
export function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const lower = flat.toLowerCase();
  let at = -1;
  for (const word of words) {
    const found = lower.indexOf(word);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, (at < 0 ? 0 : at) + SNIPPET_CONTEXT * 2);
  const head = start > 0 ? '…' : '';
  const tail = end < flat.length ? '…' : '';
  return `${head}${flat.slice(start, end)}${tail}`;
}

export function registerApi(
  app: FastifyInstance,
  deps: Deps,
  resolver: UserResolver,
  rooms: RoomManager,
  projection: Pick<ProjectionWorker, 'schedule'>,
): void {
  const repo = deps.db;

  app.register(
    (api, _opts, done) => {
      // preValidation, not onRequest: the per-address limiter (`ip-limit.ts`) is an
      // onRequest hook and must count a caller before the 401 for a missing token
      // is thrown; the body (≤ bodyLimit) is parsed before that 401, which is
      // accepted. The per-user limiter then runs at preHandler, keyed by the
      // verified user the auth hook attached (#37).
      api.addHook('preValidation', requireUser(resolver));
      api.addHook('preHandler', api.rateLimit());

      // --- service -----------------------------------------------------------

      /** The deployed build (short git sha); signed-in callers only (#42). */
      api.get('/version', () => ({ version: deps.version }));

      // --- profile ----------------------------------------------------------

      api.get('/me', (request) => profileView(currentUser(request)));

      api.patch('/me', async (request) => {
        const user = currentUser(request);
        const body = parse(profileBody, request.body, 'request');
        // Only the fields the client sent, so `exactOptionalPropertyTypes` holds.
        const patch: ProfilePatch = {
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.locale !== undefined && { locale: body.locale }),
          ...(body.tourDone !== undefined && { tourDone: body.tourDone }),
        };
        let updated = await repo.users.updateProfile(user.id, patch);
        if (!updated) throw new Error('user row missing after the auth hook resolved it');
        if (body.idToken !== undefined) {
          // SHARE-02: bind the verified address and convert its invitations.
          // The token must be the caller's own (same `sub`) and must attest
          // the address; a token for another account or without a verified
          // email binds nothing.
          let attested: { sub: string; email: string | null };
          try {
            attested = await deps.verifier.verifyIdToken(body.idToken);
          } catch {
            throw new AppError(400, 'bad_request', 'That token is not valid');
          }
          if (attested.sub !== user.sub) {
            throw new AppError(403, 'forbidden', 'That token belongs to another account');
          }
          if (attested.email === null) {
            throw new AppError(400, 'bad_request', 'That token carries no verified email');
          }
          let bound;
          try {
            bound = await repo.users.bindEmail(user.id, attested.email);
          } catch (error) {
            if (error instanceof EmailTakenError) {
              throw new AppError(409, 'conflict', 'That email belongs to another account');
            }
            throw error;
          }
          if (!bound) throw new Error('user row missing after the auth hook resolved it');
          if (bound.user.email?.toLowerCase() !== attested.email.toLowerCase()) {
            // The row already carries another address (review of #76): say so
            // rather than answer 200 with a profile the SPA would misread as bound.
            throw new AppError(
              409,
              'email_bound',
              'This account is already registered to a different email',
            );
          }
          if (bound.converted.length > 0) {
            request.log.info(
              { userId: user.id, documents: bound.converted.length },
              'invitations converted',
            );
          }
          updated = bound.user;
        }
        resolver.remember(updated);
        return profileView(toAuthUser(updated));
      });

      /**
       * Account erasure (#111, ADR-038; AUTH-09 partial: sign-out plus the
       * data). The database side is one transaction in the repository; then
       * the caller's sockets close everywhere, rooms of documents that went
       * to the trash close, the resolver forgets the row, and the Cognito
       * user is deleted when the deploy allows it. Idempotent: a second call
       * for a tombstone answers the same shape.
       */
      api.delete('/me', async (request) => {
        const user = currentUser(request);
        const outcome = await repo.users.erase(user.id);
        if (outcome === undefined)
          throw new Error('user row missing after the auth hook resolved it');
        resolver.forget(user.sub);
        rooms.closeUserEverywhere(user.id, CLOSE_FORBIDDEN, 'account deleted');
        if (outcome === null) {
          return {
            erased: true,
            identity: 'skipped',
            documentsTransferred: 0,
            documentsDeleted: 0,
          };
        }
        for (const documentId of outcome.deleted) {
          await rooms.close(documentId, { compact: true, closeCode: CLOSE_NOT_FOUND });
        }
        for (const { documentId, toUserId } of outcome.transferred) {
          // The new owner's sockets were admitted as an editor; they reconnect as the owner.
          rooms.closeUser(documentId, toUserId, 1001, 'permission changed');
        }
        request.log.info(
          {
            userId: user.id,
            transferred: outcome.transferred.length,
            deleted: outcome.deleted.length,
            sharesRemoved: outcome.sharesRemoved.length,
            invitesWithdrawn: outcome.invitesWithdrawn,
          },
          'account erased',
        );
        let identity: ErasureView['identity'] = 'skipped';
        if (deps.identity !== null) {
          try {
            await deps.identity.deleteUser(outcome.cognitoSub);
            identity = 'deleted';
          } catch (error) {
            // The data is gone and the tombstone refuses the identity; the
            // operator deletes the pool user by hand (runbook).
            identity = 'failed';
            count(
              request.log,
              'UserErasureIdentityFailures',
              'identity_delete_failed',
              { err: error, userId: user.id, ref: request.id },
              'cognito user not deleted after account erasure',
            );
          }
        }
        const body: ErasureView = {
          erased: true,
          identity,
          documentsTransferred: outcome.transferred.length,
          documentsDeleted: outcome.deleted.length,
        };
        return body;
      });

      // --- library ----------------------------------------------------------

      api.get('/documents', async (request) => {
        const user = currentUser(request);
        const { view: which } = parse(listQuery, request.query, 'query');
        const listings = await repo.documents.listForUser(user.id, which);
        return { documents: listings.map(viewListing) };
      });

      api.post('/documents', async (request, reply) => {
        const user = currentUser(request);
        const body = parse(createBody, request.body ?? {}, 'request');
        const title = body.title ?? 'Untitled';
        // DOC-03: the room's initial state is written here, as snapshot seq 1,
        // so a new document never opens empty and no client ever seeds one.
        // The S3 object goes first (the row must never point at a missing
        // snapshot); a failed insert leaves one orphan object, logged with its
        // key for the operator (README, Runbook).
        const id = randomUUID();
        const bytes = encodeSeededDocument({ title });
        const key = snapshotKey(deps.config.DOCS_PREFIX, id, INITIAL_SNAPSHOT_SEQ);
        await deps.s3.put(key, bytes);
        let doc: DocumentRecord;
        try {
          doc = await repo.documents.create({
            id,
            ownerId: user.id,
            title,
            snapshot: { seq: INITIAL_SNAPSHOT_SEQ, s3Key: key, sizeBytes: bytes.byteLength },
          });
        } catch (error) {
          request.log.error(
            { err: error, documentId: id, key, ref: request.id },
            'document insert failed after its seed snapshot was written; the object is orphaned',
          );
          throw error;
        }
        // The projection of a new document is one sheet; it makes the row searchable at once.
        projection.schedule(id, bytes);
        return reply.status(201).send({ document: view(doc, 'owner') });
      });

      // Static paths are declared before `/documents/:id` for clarity; the
      // router matches them first regardless of order.

      api.post('/documents/recover-all', async (request) => {
        const user = currentUser(request);
        // The audit rows are written inside the same transaction as the recovery.
        const recovered = await repo.documents.recoverAllDeleted(user.id, user.id);
        // The ids let the client offer Undo (LIB-D9): each goes back with DELETE.
        return { recovered: recovered.length, ids: recovered.map((doc) => doc.id) };
      });

      api.post('/documents/delete-all', async (request) => {
        const user = currentUser(request);
        // One bounded transaction per batch (#109): a large trash can never
        // run into the statement timeout as one delete.
        const purged: PurgedDocument[] = [];
        for (;;) {
          const batch = await repo.documents.purgeDeleted(user.id, user.id, DELETE_ALL_BATCH_SIZE);
          purged.push(...batch);
          if (batch.length < DELETE_ALL_BATCH_SIZE) break;
        }
        // Rooms for these documents cannot have sockets (a deleted document
        // refuses the upgrade) but one may still be idling; free it now.
        await Promise.all(
          purged.map((doc) => rooms.close(doc.id, { compact: false, closeCode: CLOSE_NOT_FOUND })),
        );
        // S3 is best-effort after the transaction has committed: a failure
        // here leaves orphaned objects under the prefix, never a half-purged
        // database. Each document is isolated; the log line carries its id
        // for the operator (see README, Runbook).
        await Promise.all(
          purged.map(async (doc) => {
            const prefix = documentPrefix(deps.config.DOCS_PREFIX, doc.id);
            try {
              const removed = await deps.s3.deletePrefix(prefix);
              request.log.info({ documentId: doc.id, objects: removed }, 'snapshot objects purged');
            } catch (error) {
              request.log.error(
                { err: error, documentId: doc.id, prefix, ref: request.id },
                'snapshot objects not purged; the database rows are gone',
              );
            }
          }),
        );
        return { deleted: purged.length };
      });

      // --- one document -----------------------------------------------------

      api.get('/documents/:id', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { permission } = await requirePermission(repo, user.id, id, 'view');
        const summary = await repo.documents.summarise(id, user.id);
        if (!summary) throw NOT_FOUND();
        return { document: summaryView(summary, permission) };
      });

      api.patch('/documents/:id', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const body = parse(patchBody, request.body, 'request');
        const { permission, document } = await requirePermission(repo, user.id, id, 'edit');
        if (document.deletedAt !== null) throw NOT_FOUND();
        // ONB-01: the sample is *named* `Q3 Delivery — Guided sample`; the tour's step 1 names it too.
        refuseSample(document, 'renamed');
        const renamed = await repo.documents.rename(id, body.title);
        if (!renamed) throw NOT_FOUND();
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.rename',
          target: body.title,
        });
        return { document: view(renamed, permission) };
      });

      api.delete('/documents/:id', async (request, reply) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        await requirePermission(repo, user.id, id, 'owner');
        // LIB-D1/D2/D10: a workscape someone was given access to is archived,
        // never deleted, so nobody loses a document they hold; the sample is
        // never deleted. The guard is evaluated in the repository, under the
        // document row lock, so an invitation accepted in the same instant
        // cannot slip past it. The SPA reads `everShared` for the toolbar
        // wording only.
        const outcome = await repo.documents.tryDelete(id, user.id);
        if (outcome.status === 'missing') throw NOT_FOUND();
        if (outcome.status === 'sample') refuseSample({ sample: true }, 'deleted');
        if (outcome.status === 'shared') {
          throw new AppError(
            409,
            'shared',
            'This workscape has been shared, so it can be archived but not deleted',
          );
        }
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.delete',
          target: null,
        });
        // Participants still connected are told the document is gone (4404);
        // the room's pending updates are flushed and compacted first so a
        // later Recover has everything.
        await rooms.close(id, { compact: true, closeCode: CLOSE_NOT_FOUND });
        return reply.status(204).send();
      });

      api.post('/documents/:id/recover', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { document } = await requirePermission(repo, user.id, id, 'owner');
        if (document.deletedAt === null) {
          throw new AppError(409, 'conflict', 'This workscape is not in Recently Deleted');
        }
        const recovered = await repo.documents.recover(id);
        if (!recovered) throw NOT_FOUND();
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.recover',
          target: null,
        });
        return { document: view(recovered, 'owner') };
      });

      // LIB-D3: archiving preserves every share and the link and closes no
      // socket; the document leaves the owner's Recents, Browse and Shared only.
      api.post('/documents/:id/archive', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { document } = await requirePermission(repo, user.id, id, 'owner');
        if (document.deletedAt !== null) throw NOT_FOUND();
        refuseSample(document, 'archived');
        if (document.archivedAt !== null) {
          throw new AppError(409, 'conflict', 'This workscape is already archived');
        }
        const archived = await repo.documents.archive(id);
        if (!archived) throw NOT_FOUND();
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.archive',
          target: null,
        });
        return { document: view(archived, 'owner') };
      });

      api.post('/documents/:id/unarchive', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { document } = await requirePermission(repo, user.id, id, 'owner');
        if (document.deletedAt !== null) throw NOT_FOUND();
        if (document.archivedAt === null) {
          throw new AppError(409, 'conflict', 'This workscape is not archived');
        }
        const restored = await repo.documents.unarchive(id);
        if (!restored) throw NOT_FOUND();
        await repo.audit.record({
          documentId: id,
          userId: user.id,
          action: 'document.unarchive',
          target: null,
        });
        return { document: view(restored, 'owner') };
      });

      api.get('/documents/:id/search', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { q } = parse(searchQuery, request.query, 'query');
        // Participants only: a stranger learns nothing, not even that the document exists (403).
        const { document } = await requirePermission(repo, user.id, id, 'view');
        // A deleted document's content is served to nobody, its owner included — the
        // same rule as the WebSocket upgrade. The owner still sees it listed in
        // Recently Deleted; its cells stay projected until the nightly purge, so
        // without this the projection would answer for a document the user was
        // told is gone (issue #42).
        if (document.deletedAt !== null) throw NOT_FOUND();
        const hits = await repo.projection.search(id, q, SEARCH_LIMIT);
        const results: SearchHitView[] = hits.map((hit) => ({
          sheetId: hit.sheetId,
          tableId: hit.tableId,
          rowId: hit.rowId,
          columnId: hit.columnId,
          snippet: snippetOf(hit.textPlain, q),
        }));
        return { results };
      });

      registerShareRoutes(api, { deps, rooms });

      done();
    },
    { prefix: '/api' },
  );
}
