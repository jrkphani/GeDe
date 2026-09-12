/**
 * REST under `/api` (ARCHITECTURE §1.3 "Documents & Sharing API"). Every route
 * here runs behind the auth hook; `request.user` is always set.
 *
 * Library (LIB-01, LIB-02, LIB-07, LIB-08), profile (AUTH-09, I18N-05) and
 * the single-document routes. Share and invite *writes* (SHARE-01, SHARE-02)
 * are Wave 3; only the participant read model exists here. Link access is
 * not granted yet — see the TODO in `permissions.ts`.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { encodeSeededDocument } from '@gede/core';

import { currentUser, requireUser, toAuthUser, type AuthUser, type UserResolver } from '../auth.js';
import type { Deps } from '../deps.js';
import { AppError } from '../errors.js';
import { canEdit, requirePermission } from '../permissions.js';
import type {
  DocumentListing,
  DocumentPermission,
  DocumentRecord,
  DocumentSummary,
  ParticipantList,
  ProfilePatch,
} from '../repo/types.js';
import { documentPrefix, snapshotKey } from '../s3.js';
import type { RoomManager } from '../ws/room-manager.js';
import { CLOSE_NOT_FOUND } from '../ws/route.js';

/** I18N-05: the locales the product ships (root CLAUDE.md "Numbers, dates, collation go through Intl"). */
export const SUPPORTED_LOCALES = ['en-US', 'en-GB', 'en-IN', 'ta-IN', 'hi-IN', 'te-IN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LIBRARY_VIEWS = ['recents', 'browse', 'shared', 'deleted'] as const;

const documentId = z.string().uuid();
/**
 * A one-line human label. Control characters are refused up front: Postgres
 * `text` cannot hold NUL (the insert fails and would surface as a 500), and a
 * title or name has no use for the rest of `\p{Cc}` either.
 */
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^\P{Cc}*$/u, 'Control characters are not allowed');
const titleSchema = oneLine(200);
const createBody = z.object({ title: titleSchema.optional() }).strict().default({});
const patchBody = z.object({ title: titleSchema }).strict();
const listQuery = z.object({ view: z.enum(LIBRARY_VIEWS).default('recents') });
const profileBody = z
  .object({
    displayName: oneLine(80).optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
  })
  .strict()
  .refine((b) => b.displayName !== undefined || b.locale !== undefined, {
    message: 'Nothing to change',
  });

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      'bad_request',
      `That ${what} is not valid`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function parseId(params: unknown): string {
  const result = z.object({ id: documentId }).safeParse(params);
  if (!result.success) throw new AppError(400, 'bad_request', 'That link is not a workscape');
  return result.data.id;
}

const NOT_FOUND = () => new AppError(404, 'not_found', 'Nothing at this address');

/** The seed snapshot's sequence number; the first client update is seq 2. */
export const INITIAL_SNAPSHOT_SEQ = 1;

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
}

/**
 * The participants sheet (LIB-07). `email` fields are populated for the owner
 * and for `edit` participants; a `view` participant receives `null` in every
 * email field and names only.
 */
export interface ParticipantsView {
  owner: { id: string; name: string | null; email: string | null };
  participants: {
    userId: string;
    name: string | null;
    email: string | null;
    permission: 'view' | 'edit';
    invitedBy: string;
  }[];
  linkAccess: DocumentRecord['linkAccess'];
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
  };
}

function summaryView(doc: DocumentSummary, permission: DocumentPermission): DocumentSummaryView {
  const out: DocumentSummaryView = {
    ...view(doc, permission),
    sizeBytes: doc.sizeBytes,
    ownerName: doc.ownerName,
    sharedWithOthers: doc.sharedWithOthers,
  };
  if (doc.sharedBy !== null) out.sharedBy = { id: doc.sharedBy.id, name: doc.sharedBy.name };
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
  };
}

function participantsView(
  list: ParticipantList,
  { revealEmails }: { revealEmails: boolean },
): ParticipantsView {
  const email = (value: string | null) => (revealEmails ? value : null);
  return {
    owner: { id: list.owner.id, name: list.owner.name, email: email(list.owner.email) },
    participants: list.participants.map((p) => ({
      userId: p.userId,
      name: p.name,
      email: email(p.email),
      permission: p.permission,
      invitedBy: p.invitedBy,
    })),
    linkAccess: list.linkAccess,
  };
}

export function registerApi(
  app: FastifyInstance,
  deps: Deps,
  resolver: UserResolver,
  rooms: RoomManager,
): void {
  const repo = deps.db;

  app.register(
    (api, _opts, done) => {
      api.addHook('onRequest', requireUser(resolver));

      // --- profile ----------------------------------------------------------

      api.get('/me', (request) => profileView(currentUser(request)));

      api.patch('/me', async (request) => {
        const user = currentUser(request);
        const body = parse(profileBody, request.body, 'request');
        // Only the fields the client sent, so `exactOptionalPropertyTypes` holds.
        const patch: ProfilePatch = {
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.locale !== undefined && { locale: body.locale }),
        };
        const updated = await repo.users.updateProfile(user.id, patch);
        if (!updated) throw new Error('user row missing after the auth hook resolved it');
        resolver.remember(updated);
        return profileView(toAuthUser(updated));
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
        return reply.status(201).send({ document: view(doc, 'owner') });
      });

      // Static paths are declared before `/documents/:id` for clarity; the
      // router matches them first regardless of order.

      api.post('/documents/recover-all', async (request) => {
        const user = currentUser(request);
        // The audit rows are written inside the same transaction as the recovery.
        const recovered = await repo.documents.recoverAllDeleted(user.id, user.id);
        return { recovered: recovered.length };
      });

      api.post('/documents/delete-all', async (request) => {
        const user = currentUser(request);
        const purged = await repo.documents.purgeDeleted(user.id, user.id);
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
        const deleted = await repo.documents.softDelete(id);
        if (!deleted) throw NOT_FOUND();
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

      api.get('/documents/:id/shares', async (request) => {
        const user = currentUser(request);
        const id = parseId(request.params);
        const { permission } = await requirePermission(repo, user.id, id, 'view');
        const list = await repo.documents.participants(id);
        if (!list) throw NOT_FOUND();
        // Emails are for people who can manage or act on the sheet — the owner
        // and editors. A view-only participant sees names only.
        return participantsView(list, { revealEmails: canEdit(permission) });
      });

      done();
    },
    { prefix: '/api' },
  );
}
