/**
 * Postgres implementation of `Repo` over Drizzle. Every multi-statement
 * operation runs in one transaction; sequence numbers are assigned under the
 * document row lock so two writers can never collide (ARCHITECTURE §1.7 step 1
 * — a second task — needs no change here).
 *
 * Every value that reaches SQL goes through Drizzle's parameter binding; the
 * `sql` fragments below reference columns and bind values, never interpolate
 * strings.
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { timingSafeEqual } from 'node:crypto';

import {
  auditLog,
  cells,
  columns,
  docUpdates,
  documents,
  invites,
  rows as rowsTable,
  shares,
  sheets,
  snapshots,
  tables,
  users,
  type Db,
  type Permission,
} from '@gede/db';

import type { Logger } from '../logger.js';
import {
  EmailTakenError,
  RECENTLY_DELETED_DAYS,
  type ConvertedInvite,
  type DocumentListing,
  type DocumentPermission,
  type DocumentRecord,
  type DocumentSummary,
  type InviteRecord,
  type LibraryView,
  type PurgedDocument,
  type Repo,
  type ShareAuditAction,
  type UserRecord,
} from './types.js';

const PG_UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors in `DrizzleQueryError` with the `pg` error as `cause`; check both. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (
    let e: unknown = error, depth = 0;
    typeof e === 'object' && e !== null && depth < 3;
    depth += 1
  ) {
    const candidate = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === PG_UNIQUE_VIOLATION && candidate.constraint === constraint) return true;
    e = candidate.cause;
  }
  return false;
}

/** Link tokens are compared without leaking their length or prefix through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

type DocumentRow = typeof documents.$inferSelect;

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    linkAccess: row.linkAccess,
    linkToken: row.linkToken,
    snapshotKey: row.snapshotKey,
    snapshotSeq: row.snapshotSeq,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    archivedAt: row.archivedAt,
    everShared: row.everShared,
    sample: row.sample,
  };
}

function toUser(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    cognitoSub: row.cognitoSub,
    email: row.email,
    displayName: row.displayName,
    locale: row.locale,
  };
}

function toInvite(row: typeof invites.$inferSelect): InviteRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    email: row.email,
    permission: row.permission,
    token: row.token,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

/** A transaction handle or the root: the conversion runs inside whichever binding path reached it. */
type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

/** Pending and unexpired, on the database's clock. */
const invitePending = and(isNull(invites.acceptedAt), gt(invites.expiresAt, sql`now()`));

/** A pending invitation with what its inviter holds now, as `pendingInvitesQuery` selects it. */
interface PendingRow {
  id: string;
  documentId: string;
  email: string;
  permission: Permission;
  invitedBy: string;
  ownerId: string;
  inviterPermission: Permission | null;
}

/** The inviter's own share, joined to see what they still hold. */
const inviterShare = alias(shares, 'inviter_share');
/** Any share on the current `documents` row (the shares-exist probe). */
const anyShare = alias(shares, 'any_share');

/**
 * Serialise every change to one document's sharing state, and its deletion,
 * on the document row. `FOR UPDATE` conflicts with the `FOR KEY SHARE` a
 * share insert takes through its foreign key, so whoever holds it sees every
 * committed share when it next reads `shares`, and no share can be inserted
 * under it. Every share transaction takes it as its first statement (before
 * it touches `shares` or `invites`, so lock order is always documents →
 * invites/shares); the guarded delete does too. Without it, a `remove` of the
 * last participant could evaluate "no share remains" while an acceptance was
 * inserting one, and commit `ever_shared = false` beside a live share.
 * `false` when the document does not exist.
 */
async function lockDocument(tx: Executor, documentId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('update');
  return rows.length > 0;
}

/**
 * LIB-D2/D4: a share now exists (or the link is on), so the document has been
 * shared and Delete is off the table until every share goes and the link is
 * off. Idempotent; runs inside the caller's transaction.
 */
async function markShared(tx: Executor, documentId: string): Promise<void> {
  await tx
    .update(documents)
    .set({ everShared: true })
    .where(and(eq(documents.id, documentId), eq(documents.everShared, false)));
}

/**
 * LIB-D4 ("revoking all access must restore deletability"): clear
 * `ever_shared` when no share remains and link access is `none`. Evaluated in
 * SQL against the rows the transaction sees; the caller holds the document
 * row (`lockDocument`), so a concurrent insert has either committed — and is
 * seen — or is waiting on that lock.
 */
async function clearSharedIfNone(tx: Executor, documentId: string): Promise<void> {
  await tx
    .update(documents)
    .set({ everShared: false })
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.everShared, true),
        eq(documents.linkAccess, 'none'),
        not(
          exists(
            tx
              .select({ one: sql`1` })
              .from(anyShare)
              .where(eq(anyShare.documentId, documents.id)),
          ),
        ),
      ),
    );
}

/**
 * Pending, unexpired invitations with the inviter's standing: the owner
 * (`invitedBy === ownerId`, which legacy rows with a null inviter coalesce
 * to) or the inviter's current share permission, null once they are gone.
 * `where` narrows by address or by id.
 */
function pendingInvitesQuery(tx: Executor, where: SQL) {
  return tx
    .select({
      id: invites.id,
      documentId: invites.documentId,
      email: invites.email,
      permission: invites.permission,
      invitedBy: sql<string>`coalesce(${invites.invitedBy}, ${documents.ownerId})`,
      ownerId: documents.ownerId,
      inviterPermission: inviterShare.permission,
    })
    .from(invites)
    .innerJoin(documents, eq(documents.id, invites.documentId))
    .leftJoin(
      inviterShare,
      and(
        eq(inviterShare.documentId, invites.documentId),
        eq(inviterShare.userId, sql`coalesce(${invites.invitedBy}, ${documents.ownerId})`),
      ),
    )
    .where(and(where, invitePending))
    .orderBy(asc(invites.createdAt), asc(invites.id));
}

/**
 * Review of #76: an invitation is only as good as its inviter. It converts
 * while the inviter is the owner or still holds at least what it grants
 * (`edit` for an edit invitation, any share for a view one); a removed or
 * demoted editor's invitations must not outlive their standing.
 */
export function inviterStillMay(
  row: Pick<PendingRow, 'invitedBy' | 'ownerId' | 'permission' | 'inviterPermission'>,
): boolean {
  if (row.invitedBy === row.ownerId) return true;
  if (row.inviterPermission === null) return false;
  return row.permission === 'view' || row.inviterPermission === 'edit';
}

/** Withdraw an invitation whose inviter no longer holds what it grants, with its audit row. */
async function withdrawStale(tx: Executor, row: PendingRow, actorId: string | null): Promise<void> {
  await tx.delete(invites).where(eq(invites.id, row.id));
  await tx.insert(auditLog).values({
    documentId: row.documentId,
    userId: actorId,
    action: 'share.invite_withdraw' satisfies ShareAuditAction,
    target: `${row.email}:${row.invitedBy}`,
  });
}

/**
 * SHARE-02, the conversion: every pending, unexpired invitation for `email`
 * whose inviter still stands (`inviterStillMay`) becomes a share for
 * `userId` — with the invitation's inviter, else the document's owner —
 * unless a share exists already, and is marked accepted either way; one
 * `share.invite_accept` audit row each. A stale one is withdrawn instead
 * (`share.invite_withdraw`, system actor). Idempotent: a second run finds
 * nothing pending.
 */
async function convertInvites(
  tx: Executor,
  userId: string,
  email: string,
): Promise<ConvertedInvite[]> {
  const pending = await pendingInvitesQuery(tx, eq(invites.email, email));
  const converted: ConvertedInvite[] = [];
  for (const invite of pending) {
    if (!inviterStillMay(invite)) {
      await withdrawStale(tx, invite, null);
      continue;
    }
    if (invite.ownerId !== userId) {
      await lockDocument(tx, invite.documentId);
      await tx
        .insert(shares)
        .values({
          documentId: invite.documentId,
          userId,
          permission: invite.permission,
          invitedBy: invite.invitedBy,
          source: 'invite',
        })
        .onConflictDoNothing();
      await markShared(tx, invite.documentId);
    }
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
    await tx.insert(auditLog).values({
      documentId: invite.documentId,
      userId,
      action: 'share.invite_accept' satisfies ShareAuditAction,
      target: email,
    });
    converted.push({ documentId: invite.documentId, permission: invite.permission });
  }
  return converted;
}

/** Aliases for the extra `users` joins in the library query and the shares-exist probe. */
const owner = alias(users, 'owner');
const inviter = alias(users, 'inviter');

/** Deleted within the retention window (LIB-08), evaluated on the database's clock. */
const withinRetention = sql`${documents.deletedAt} > now() - (${RECENTLY_DELETED_DAYS}::int * interval '1 day')`;

export function createPgRepo(db: Db, logger: Logger): Repo {
  /** `EXISTS (SELECT 1 FROM shares WHERE document_id = documents.id)` for the current row. */
  const hasShares = () =>
    exists(
      db
        .select({ one: sql`1` })
        .from(anyShare)
        .where(eq(anyShare.documentId, documents.id)),
    );

  /**
   * The library projection of `documents` for one caller: the row, the owner's
   * name, the caller's share (permission and who invited them), whether any
   * share exists, and the size. Correlated subqueries keep it one statement
   * however many rows come back (no N+1).
   */
  function summaryQuery(userId: string) {
    return db
      .select({
        doc: documents,
        ownerName: sql<string | null>`coalesce(${owner.displayName}, ${owner.email})`,
        sharePermission: shares.permission,
        invitedBy: shares.invitedBy,
        inviterName: sql<string | null>`coalesce(${inviter.displayName}, ${inviter.email})`,
        sharedWithOthers: hasShares(),
        // bigint aggregates arrive from pg as strings; converted below.
        sizeBytes: sql<string | number>`
          coalesce(${snapshots.sizeBytes}, 0)::bigint
          + coalesce((
              select sum(octet_length(${docUpdates.update}))
              from ${docUpdates}
              where ${docUpdates.documentId} = ${documents.id}
                and ${docUpdates.seq} > ${documents.snapshotSeq}
            ), 0)::bigint`,
      })
      .from(documents)
      .innerJoin(owner, eq(owner.id, documents.ownerId))
      .leftJoin(shares, and(eq(shares.documentId, documents.id), eq(shares.userId, userId)))
      .leftJoin(inviter, eq(inviter.id, shares.invitedBy))
      .leftJoin(
        snapshots,
        and(eq(snapshots.documentId, documents.id), eq(snapshots.seq, documents.snapshotSeq)),
      );
  }

  type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>['execute']>>[number];

  function toSummary(row: SummaryRow, userId: string): DocumentSummary {
    const doc = toDocument(row.doc);
    const sharedBy =
      doc.ownerId !== userId && row.invitedBy !== null
        ? { id: row.invitedBy, name: row.inviterName }
        : null;
    return {
      ...doc,
      ownerName: row.ownerName,
      sizeBytes: Number(row.sizeBytes),
      sharedBy,
      sharedWithOthers: Boolean(row.sharedWithOthers),
    };
  }

  function scopeFor(userId: string, view: LibraryView) {
    const owned = eq(documents.ownerId, userId);
    const sharedWithMe = isNotNull(shares.userId);
    const live = isNull(documents.deletedAt);
    // LIB-D3: archiving hides a document from the owner's views only; a
    // participant still sees what they were given.
    const ownedAndShown = and(owned, isNull(documents.archivedAt));
    switch (view) {
      case 'recents':
        return and(live, or(ownedAndShown, sharedWithMe));
      case 'browse':
        return and(live, ownedAndShown);
      case 'shared':
        return and(live, or(sharedWithMe, and(ownedAndShown, hasShares())));
      case 'deleted':
        return and(owned, isNotNull(documents.deletedAt), withinRetention);
      case 'archived':
        return and(live, owned, isNotNull(documents.archivedAt));
    }
  }

  return {
    async ping() {
      await db.execute(sql`SELECT 1`);
    },

    users: {
      upsertFromToken(identity) {
        return db.transaction(async (tx) => {
          const now = new Date();
          const upsert = (exec: Executor, email: string | null) =>
            exec
              .insert(users)
              .values({ cognitoSub: identity.sub, email, lastSeenAt: now })
              .onConflictDoUpdate({
                target: users.cognitoSub,
                set: { lastSeenAt: now, email: sql`coalesce(${users.email}, excluded.email)` },
              })
              .returning();
          let rows: (typeof users.$inferSelect)[];
          try {
            // A savepoint: the unique violation below must not poison the transaction.
            rows = await tx.transaction((inner) => upsert(inner, identity.email));
          } catch (error) {
            // The same email already belongs to another Cognito identity (for
            // example an Apple ID and an email-code account that Cognito has
            // not linked). Keep the identity, leave the email for a later
            // reconciliation, and say so in the log.
            if (!isUniqueViolation(error, 'users_email_key')) throw error;
            logger.warn(
              { sub: identity.sub },
              'email already registered to another sub; storing without email',
            );
            rows = await upsert(tx, null);
          }
          const row = rows[0];
          if (!row) throw new Error('users upsert returned no row');
          // SHARE-02: a token that carries a verified address is one of the two
          // binding paths (`bindEmail` is the other); pending invitations for
          // the address convert here so first sign-in is enough.
          if (row.email !== null && identity.email !== null) {
            const converted = await convertInvites(tx, row.id, row.email);
            if (converted.length > 0) {
              logger.info({ userId: row.id, documents: converted.length }, 'invitations converted');
            }
          }
          return toUser(row);
        });
      },

      bindEmail(id, email) {
        return db.transaction(async (tx) => {
          let row: typeof users.$inferSelect | undefined;
          try {
            [row] = await tx.transaction((inner) =>
              inner
                .update(users)
                .set({ email: sql`coalesce(${users.email}, ${email})` })
                .where(eq(users.id, id))
                .returning(),
            );
          } catch (error) {
            if (isUniqueViolation(error, 'users_email_key')) throw new EmailTakenError();
            throw error;
          }
          if (!row) return undefined;
          // A row that already had a different address keeps it; the caller
          // compares and answers. Only the bound address converts invitations.
          if (row.email?.toLowerCase() !== email.toLowerCase()) {
            return { user: toUser(row), converted: [] };
          }
          const converted = await convertInvites(tx, row.id, row.email);
          return { user: toUser(row), converted };
        });
      },

      async findByEmail(email) {
        const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        return row ? toUser(row) : undefined;
      },

      async updateProfile(id, patch) {
        const set: Partial<typeof users.$inferInsert> = {};
        if (patch.displayName !== undefined) set.displayName = patch.displayName;
        if (patch.locale !== undefined) set.locale = patch.locale;
        if (Object.keys(set).length === 0) {
          const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
          return row ? toUser(row) : undefined;
        }
        const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
        return row ? toUser(row) : undefined;
      },
    },

    documents: {
      async listForUser(userId, view) {
        const rows = await summaryQuery(userId)
          .where(scopeFor(userId, view))
          .orderBy(desc(documents.updatedAt), desc(documents.id));
        const listings: DocumentListing[] = [];
        for (const row of rows) {
          const permission: DocumentPermission | null =
            row.doc.ownerId === userId ? 'owner' : (row.sharePermission ?? null);
          if (permission === null) continue; // cannot happen given the WHERE, but never invent access
          listings.push({ ...toSummary(row, userId), permission });
        }
        return listings;
      },

      async get(id) {
        const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
        return row ? toDocument(row) : undefined;
      },

      async summarise(id, userId) {
        const [row] = await summaryQuery(userId).where(eq(documents.id, id)).limit(1);
        return row ? toSummary(row, userId) : undefined;
      },

      create({ id, ownerId, title, snapshot }) {
        return db.transaction(async (tx) => {
          const [row] = await tx
            .insert(documents)
            .values({ id, ownerId, title, snapshotKey: snapshot.s3Key, snapshotSeq: snapshot.seq })
            .returning();
          if (!row) throw new Error('documents insert returned no row');
          await tx.insert(snapshots).values({
            documentId: id,
            seq: snapshot.seq,
            s3Key: snapshot.s3Key,
            sizeBytes: snapshot.sizeBytes,
          });
          await tx.insert(auditLog).values({
            documentId: id,
            userId: ownerId,
            action: 'document.create',
            target: null,
          });
          return toDocument(row);
        });
      },

      async rename(id, title) {
        const [row] = await db
          .update(documents)
          .set({ title, updatedAt: new Date() })
          .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
          .returning();
        return row ? toDocument(row) : undefined;
      },

      async softDelete(id) {
        const now = new Date();
        // Archived or deleted, never both (migration 0008 CHECK): a document
        // deleted from anywhere leaves the archive as it enters the trash.
        const [row] = await db
          .update(documents)
          .set({ deletedAt: now, archivedAt: null, updatedAt: now })
          .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
          .returning();
        return row ? toDocument(row) : undefined;
      },

      tryDelete(id) {
        return db.transaction(async (tx) => {
          // Hold the row so an acceptance in flight commits its share — and
          // `ever_shared` — before the guard reads them, or waits until after.
          if (!(await lockDocument(tx, id))) return { status: 'missing' };
          const now = new Date();
          const [row] = await tx
            .update(documents)
            .set({ deletedAt: now, archivedAt: null, updatedAt: now })
            .where(
              and(
                eq(documents.id, id),
                isNull(documents.deletedAt),
                eq(documents.everShared, false),
                eq(documents.linkAccess, 'none'),
                eq(documents.sample, false),
              ),
            )
            .returning();
          if (row) return { status: 'deleted', document: toDocument(row) };
          const [current] = await tx
            .select({
              deletedAt: documents.deletedAt,
              sample: documents.sample,
            })
            .from(documents)
            .where(eq(documents.id, id))
            .limit(1);
          if (current?.deletedAt !== null) return { status: 'missing' };
          return { status: current.sample ? 'sample' : 'shared' };
        });
      },

      async archive(id) {
        // `updated_at` is untouched: nothing about the document changed for
        // its participants (LIB-D3), and Recents orders by it.
        const [row] = await db
          .update(documents)
          .set({ archivedAt: new Date() })
          .where(
            and(eq(documents.id, id), isNull(documents.deletedAt), isNull(documents.archivedAt)),
          )
          .returning();
        return row ? toDocument(row) : undefined;
      },

      async unarchive(id) {
        const [row] = await db
          .update(documents)
          .set({ archivedAt: null })
          .where(and(eq(documents.id, id), isNotNull(documents.archivedAt)))
          .returning();
        return row ? toDocument(row) : undefined;
      },

      async recover(id) {
        // Only from Recently Deleted (LIB-08): past the window the row waits for the purge.
        const [row] = await db
          .update(documents)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(and(eq(documents.id, id), isNotNull(documents.deletedAt), withinRetention))
          .returning();
        return row ? toDocument(row) : undefined;
      },

      recoverAllDeleted(ownerId, actorId) {
        return db.transaction(async (tx) => {
          const rows = await tx
            .update(documents)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(
              and(eq(documents.ownerId, ownerId), isNotNull(documents.deletedAt), withinRetention),
            )
            .returning();
          if (rows.length > 0) {
            await tx.insert(auditLog).values(
              rows.map((row) => ({
                documentId: row.id,
                userId: actorId,
                action: 'document.recover',
                target: null,
              })),
            );
          }
          return rows.map(toDocument);
        });
      },

      purgeDeleted(ownerId, actorId) {
        return db.transaction(async (tx) => {
          const doomed = await tx
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(and(eq(documents.ownerId, ownerId), isNotNull(documents.deletedAt)))
            .for('update');
          if (doomed.length === 0) return [];
          const ids = doomed.map((d) => d.id);
          await tx.insert(auditLog).values(
            doomed.map((d) => ({
              documentId: d.id,
              userId: actorId,
              action: 'document.purge',
              target: d.title,
            })),
          );
          // shares, invites, doc_updates and snapshots cascade from documents.
          await tx.delete(documents).where(inArray(documents.id, ids));
          return doomed;
        });
      },

      purgeExpired({ limit, exclude, removeObjects }) {
        return db.transaction(async (tx) => {
          const candidates = await tx
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(
              and(
                isNotNull(documents.deletedAt),
                not(withinRetention),
                ...(exclude.length === 0 ? [] : [notInArray(documents.id, [...exclude])]),
              ),
            )
            .orderBy(asc(documents.deletedAt), asc(documents.id))
            .limit(limit)
            .for('update', { skipLocked: true });
          const purged: PurgedDocument[] = [];
          const failed: PurgedDocument[] = [];
          // Objects first, rows after, under the claim: a document whose objects
          // could not be removed keeps its rows and is retried next run.
          for (const doc of candidates) {
            if (await removeObjects(doc)) purged.push(doc);
            else failed.push(doc);
          }
          if (purged.length > 0) {
            // `user_id` null is the system actor: nobody pressed Delete All.
            await tx.insert(auditLog).values(
              purged.map((d) => ({
                documentId: d.id,
                userId: null,
                action: 'document.purge',
                target: d.title,
              })),
            );
            await tx.delete(documents).where(
              inArray(
                documents.id,
                purged.map((d) => d.id),
              ),
            );
          }
          return { purged, failed };
        });
      },

      async sharePermission(documentId, userId) {
        const [row] = await db
          .select({ permission: shares.permission })
          .from(shares)
          .where(and(eq(shares.documentId, documentId), eq(shares.userId, userId)))
          .limit(1);
        return row?.permission;
      },

      async participants(documentId) {
        const [head] = await db
          .select({
            ownerId: documents.ownerId,
            ownerName: users.displayName,
            ownerEmail: users.email,
            linkAccess: documents.linkAccess,
            linkToken: documents.linkToken,
          })
          .from(documents)
          .innerJoin(users, eq(users.id, documents.ownerId))
          .where(eq(documents.id, documentId))
          .limit(1);
        if (!head) return undefined;
        const rows = await db
          .select({
            userId: shares.userId,
            name: users.displayName,
            email: users.email,
            permission: shares.permission,
            invitedBy: shares.invitedBy,
            source: shares.source,
          })
          .from(shares)
          .innerJoin(users, eq(users.id, shares.userId))
          .where(eq(shares.documentId, documentId))
          .orderBy(asc(shares.createdAt), asc(shares.userId));
        const pending = await db
          .select({
            id: invites.id,
            email: invites.email,
            permission: invites.permission,
            invitedBy: invites.invitedBy,
            expiresAt: invites.expiresAt,
          })
          .from(invites)
          .where(and(eq(invites.documentId, documentId), invitePending))
          .orderBy(asc(invites.createdAt), asc(invites.id));
        return {
          owner: { id: head.ownerId, name: head.ownerName, email: head.ownerEmail },
          participants: rows,
          invites: pending,
          linkAccess: head.linkAccess,
          linkToken: head.linkToken,
        };
      },
    },

    shares: {
      add({ documentId, userId, permission, invitedBy, actorId }) {
        return db.transaction(async (tx) => {
          if (!(await lockDocument(tx, documentId))) return false;
          const inserted = await tx
            .insert(shares)
            .values({ documentId, userId, permission, invitedBy, source: 'invite' })
            .onConflictDoNothing()
            .returning({ userId: shares.userId });
          if (inserted.length === 0) return false;
          // A person with an account is given access on the spot: that is an
          // accepted share, not a sent invitation (LIB-D4).
          await markShared(tx, documentId);
          await tx.insert(auditLog).values({
            documentId,
            userId: actorId,
            action: 'share.add' satisfies ShareAuditAction,
            target: userId,
          });
          return true;
        });
      },

      setPermission({ documentId, userId, permission, actorId }) {
        return db.transaction(async (tx) => {
          const changed = await tx
            .update(shares)
            .set({ permission })
            .where(and(eq(shares.documentId, documentId), eq(shares.userId, userId)))
            .returning({ userId: shares.userId });
          if (changed.length === 0) return false;
          await tx.insert(auditLog).values({
            documentId,
            userId: actorId,
            action: 'share.permission' satisfies ShareAuditAction,
            target: `${userId}:${permission}`,
          });
          return true;
        });
      },

      remove({ documentId, userId, actorId }) {
        return db.transaction(async (tx) => {
          if (!(await lockDocument(tx, documentId))) return false;
          const gone = await tx
            .delete(shares)
            .where(and(eq(shares.documentId, documentId), eq(shares.userId, userId)))
            .returning({ userId: shares.userId });
          if (gone.length === 0) return false;
          await clearSharedIfNone(tx, documentId);
          await tx.insert(auditLog).values({
            documentId,
            userId: actorId,
            action: 'share.remove' satisfies ShareAuditAction,
            target: userId,
          });
          return true;
        });
      },

      stop({ documentId, actorId }) {
        return db.transaction(async (tx) => {
          if (!(await lockDocument(tx, documentId))) return [];
          const gone = await tx
            .delete(shares)
            .where(eq(shares.documentId, documentId))
            .returning({ userId: shares.userId });
          const withdrawn = await tx
            .delete(invites)
            .where(and(eq(invites.documentId, documentId), isNull(invites.acceptedAt)))
            .returning({ email: invites.email });
          // Nobody holds access any more: link off, and deletable again (LIB-D4).
          await tx
            .update(documents)
            .set({ linkAccess: 'none', everShared: false })
            .where(eq(documents.id, documentId));
          // The one row records who lost access: user ids, then withdrawn addresses.
          await tx.insert(auditLog).values({
            documentId,
            userId: actorId,
            action: 'share.stop' satisfies ShareAuditAction,
            target: JSON.stringify({
              users: gone.map((g) => g.userId),
              invites: withdrawn.map((w) => w.email),
            }),
          });
          return gone.map((g) => g.userId);
        });
      },

      setLinkAccess({ documentId, access, actorId, mintToken }) {
        return db.transaction(async (tx) => {
          const [current] = await tx
            .select({ linkAccess: documents.linkAccess, linkToken: documents.linkToken })
            .from(documents)
            .where(eq(documents.id, documentId))
            .for('update');
          if (!current) return undefined;
          // A fresh token for any level the link is switched to: a link handed
          // out as "view" never becomes "edit", and one switched off stays dead.
          const remint = access !== 'none' && access !== current.linkAccess;
          const turningOff = access === 'none' && current.linkAccess !== 'none';
          // A link that is on is access anyone holding the URL may use (LIB-D1):
          // switching it on marks the document shared.
          const [updated] = await tx
            .update(documents)
            .set({
              linkAccess: access,
              ...(remint && { linkToken: mintToken() }),
              ...(access !== 'none' && { everShared: true }),
            })
            .where(eq(documents.id, documentId))
            .returning();
          if (!updated) return undefined;
          await tx.insert(auditLog).values({
            documentId,
            userId: actorId,
            action: 'share.link' satisfies ShareAuditAction,
            target: access,
          });
          // The link that admitted `link` shares is gone with the token: so are they.
          let revoked: string[] = [];
          if (remint || turningOff) {
            const gone = await tx
              .delete(shares)
              .where(and(eq(shares.documentId, documentId), eq(shares.source, 'link')))
              .returning({ userId: shares.userId });
            revoked = gone.map((g) => g.userId);
            if (revoked.length > 0) {
              await tx.insert(auditLog).values({
                documentId,
                userId: actorId,
                action: 'share.link_revoke' satisfies ShareAuditAction,
                target: revoked.join(','),
              });
            }
          }
          // Off, and the last participant may have gone with it: deletable again (LIB-D4).
          if (turningOff) await clearSharedIfNone(tx, documentId);
          const [row] = await tx
            .select()
            .from(documents)
            .where(eq(documents.id, documentId))
            .limit(1);
          if (!row) return undefined;
          return { document: toDocument(row), revoked };
        });
      },

      redeemLink({ documentId, userId, token }) {
        return db.transaction(async (tx) => {
          const [doc] = await tx
            .select({
              ownerId: documents.ownerId,
              linkAccess: documents.linkAccess,
              linkToken: documents.linkToken,
            })
            .from(documents)
            .where(eq(documents.id, documentId))
            .for('update');
          if (!doc || doc.linkAccess === 'none' || doc.linkToken === null) return undefined;
          // Compared in JS on the fetched row so the query plan never depends on the secret.
          if (!constantTimeEqual(doc.linkToken, token)) return undefined;
          const granted = doc.linkAccess;
          if (doc.ownerId === userId) return granted;
          const inserted = await tx
            .insert(shares)
            .values({
              documentId,
              userId,
              permission: granted,
              invitedBy: doc.ownerId,
              source: 'link',
            })
            .onConflictDoNothing()
            .returning({ permission: shares.permission });
          if (inserted.length === 0) {
            const [existing] = await tx
              .select({ permission: shares.permission })
              .from(shares)
              .where(and(eq(shares.documentId, documentId), eq(shares.userId, userId)))
              .limit(1);
            return existing?.permission ?? granted;
          }
          await markShared(tx, documentId);
          await tx.insert(auditLog).values({
            documentId,
            userId,
            action: 'share.link_redeem' satisfies ShareAuditAction,
            target: granted,
          });
          return granted;
        });
      },
    },

    invites: {
      create({ documentId, email, permission, token, expiresAt, invitedBy }) {
        return db.transaction(async (tx) => {
          const pair = and(eq(invites.documentId, documentId), eq(invites.email, email));
          // Idempotent per (document, address): a pending, unexpired invitation
          // stands; a retried or repeated POST gets it back and writes nothing.
          const [pending] = await tx
            .select()
            .from(invites)
            .where(and(pair, invitePending))
            .for('update');
          if (pending) return { invite: toInvite(pending), created: false };
          // An expired one for the pair would collide with `invites_pending_key`;
          // it is dead, so it goes before the fresh row.
          await tx.delete(invites).where(and(pair, isNull(invites.acceptedAt)));
          const inserted = await tx
            .insert(invites)
            .values({ documentId, email, permission, token, expiresAt, invitedBy })
            .onConflictDoNothing({
              target: [invites.documentId, invites.email],
              where: isNull(invites.acceptedAt),
            })
            .returning();
          const row = inserted[0];
          if (!row) {
            // Lost a race with a concurrent invite for the same pair: theirs stands.
            const [raced] = await tx
              .select()
              .from(invites)
              .where(and(pair, invitePending))
              .limit(1);
            if (!raced) throw new Error('invites insert returned no row and none is pending');
            return { invite: toInvite(raced), created: false };
          }
          await tx.insert(auditLog).values({
            documentId,
            userId: invitedBy,
            action: 'share.invite' satisfies ShareAuditAction,
            target: email,
          });
          return { invite: toInvite(row), created: true };
        });
      },

      remove({ documentId, inviteId, actorId }) {
        return db.transaction(async (tx) => {
          const gone = await tx
            .delete(invites)
            .where(and(eq(invites.id, inviteId), eq(invites.documentId, documentId), invitePending))
            .returning({ email: invites.email });
          const first = gone[0];
          if (!first) return false;
          await tx.insert(auditLog).values({
            documentId,
            userId: actorId,
            action: 'share.invite_remove' satisfies ShareAuditAction,
            target: first.email,
          });
          return true;
        });
      },

      async byToken(token) {
        const [row] = await db.select().from(invites).where(eq(invites.token, token)).limit(1);
        return row ? toInvite(row) : undefined;
      },

      accept({ inviteId, userId }) {
        return db.transaction(async (tx) => {
          // The document row first, then the invitation row: the same order as
          // `stop`, which holds the document while it withdraws invitations.
          const [target] = await tx
            .select({ documentId: invites.documentId })
            .from(invites)
            .where(eq(invites.id, inviteId))
            .limit(1);
          if (!target || !(await lockDocument(tx, target.documentId))) return undefined;
          // The address check is in SQL: the invitation converts only for the
          // account that holds its (citext-equal) email.
          const holdsAddress = exists(
            tx
              .select({ one: sql`1` })
              .from(users)
              .where(and(eq(users.id, userId), eq(users.email, invites.email))),
          );
          const [match] = await pendingInvitesQuery(
            tx,
            sql`${invites.id} = ${inviteId} and ${holdsAddress}`,
          ).for('update', { of: invites });
          if (!match) return undefined;
          if (!inviterStillMay(match)) {
            await withdrawStale(tx, match, userId);
            return undefined;
          }
          if (match.ownerId !== userId) {
            await tx
              .insert(shares)
              .values({
                documentId: match.documentId,
                userId,
                permission: match.permission,
                invitedBy: match.invitedBy,
                source: 'invite',
              })
              .onConflictDoNothing();
            await markShared(tx, match.documentId);
          }
          await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, match.id));
          await tx.insert(auditLog).values({
            documentId: match.documentId,
            userId,
            action: 'share.invite_accept' satisfies ShareAuditAction,
            target: match.email,
          });
          return match.permission;
        });
      },
    },

    updates: {
      loadState(documentId) {
        // REPEATABLE READ so the snapshot pointer and the log tail come from
        // one database snapshot; a concurrent compaction cannot open a gap.
        return db.transaction(
          async (tx) => {
            const [doc] = await tx
              .select({ snapshotKey: documents.snapshotKey, snapshotSeq: documents.snapshotSeq })
              .from(documents)
              .where(eq(documents.id, documentId))
              .limit(1);
            if (!doc) throw new Error(`document ${documentId} does not exist`);
            const rows = await tx
              .select({ seq: docUpdates.seq, update: docUpdates.update })
              .from(docUpdates)
              .where(
                and(eq(docUpdates.documentId, documentId), gt(docUpdates.seq, doc.snapshotSeq)),
              )
              .orderBy(asc(docUpdates.seq));
            return { snapshotKey: doc.snapshotKey, snapshotSeq: doc.snapshotSeq, updates: rows };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
      },

      append(documentId, updates) {
        if (updates.length === 0) {
          throw new Error('append called with no updates');
        }
        return db.transaction(async (tx) => {
          const [doc] = await tx
            .select({ snapshotSeq: documents.snapshotSeq })
            .from(documents)
            .where(eq(documents.id, documentId))
            .for('update');
          if (!doc) throw new Error(`document ${documentId} does not exist`);
          const [tail] = await tx
            // pg returns bigint aggregates as strings; the column type below says so.
            .select({ max: sql<string | number>`coalesce(max(${docUpdates.seq}), 0)::bigint` })
            .from(docUpdates)
            .where(eq(docUpdates.documentId, documentId));
          const base = Math.max(doc.snapshotSeq, Number(tail?.max ?? 0));
          await tx.insert(docUpdates).values(
            updates.map((u, i) => ({
              documentId,
              seq: base + i + 1,
              update: u.update,
              authorId: u.authorId,
            })),
          );
          await tx
            .update(documents)
            .set({ updatedAt: new Date() })
            .where(eq(documents.id, documentId));
          return { firstSeq: base + 1, lastSeq: base + updates.length };
        });
      },

      commitSnapshot({ documentId, seq, s3Key, sizeBytes, coversFrom, appended }) {
        return db.transaction(async (tx) => {
          // The same row lock `append` takes: no sequence number is assigned
          // while the pointer moves, and two compactions serialise here.
          const [doc] = await tx
            .select({ snapshotSeq: documents.snapshotSeq })
            .from(documents)
            .where(eq(documents.id, documentId))
            .for('update');
          if (!doc) throw new Error(`document ${documentId} does not exist`);
          // Monotonic (#39): a task whose in-memory state is behind another
          // task's snapshot must never move the pointer back or prune what
          // its snapshot does not contain.
          if (seq <= doc.snapshotSeq) {
            logger.warn(
              { documentId, seq, committedSeq: doc.snapshotSeq },
              'stale snapshot commit ignored',
            );
            return false;
          }
          // The snapshot must contain everything it would supersede. Another
          // task's commit since this writer loaded (or last committed) may have
          // pruned rows this snapshot never saw; and rows in (coversFrom, seq]
          // the writer did not append belong to another task. Either refuses.
          if (doc.snapshotSeq > coversFrom) {
            logger.warn(
              { documentId, seq, coversFrom, committedSeq: doc.snapshotSeq },
              'another task compacted this document since it was loaded; not committed',
            );
            return false;
          }
          const [logged] = await tx
            .select({ n: sql<string | number>`count(*)::int` })
            .from(docUpdates)
            .where(
              and(
                eq(docUpdates.documentId, documentId),
                gt(docUpdates.seq, coversFrom),
                sql`${docUpdates.seq} <= ${seq}`,
              ),
            );
          const loggedRows = Number(logged?.n ?? 0);
          if (loggedRows !== appended) {
            logger.warn(
              { documentId, seq, coversFrom, appended, loggedRows },
              'snapshot does not cover every logged update; not committed',
            );
            return false;
          }
          await tx.insert(snapshots).values({ documentId, seq, s3Key, sizeBytes });
          const moved = await tx
            .update(documents)
            .set({ snapshotKey: s3Key, snapshotSeq: seq })
            .where(and(eq(documents.id, documentId), sql`${documents.snapshotSeq} < ${seq}`))
            .returning({ id: documents.id });
          if (moved.length === 0) throw new Error('snapshot pointer did not advance under lock');
          await tx
            .delete(docUpdates)
            .where(and(eq(docUpdates.documentId, documentId), sql`${docUpdates.seq} <= ${seq}`));
          return true;
        });
      },
    },

    audit: {
      async record(entry) {
        await db.insert(auditLog).values(entry);
      },
    },

    projection: {
      replace(projection) {
        return db.transaction(async (tx) => {
          // sheets → tables → columns/rows → cells all cascade on delete.
          await tx.delete(sheets).where(eq(sheets.documentId, projection.documentId));
          for (const batch of chunk(projection.sheets, INSERT_CHUNK)) {
            await tx.insert(sheets).values(batch.map((s) => ({ ...s })));
          }
          for (const batch of chunk(projection.tables, INSERT_CHUNK)) {
            await tx.insert(tables).values(batch.map((t) => ({ ...t })));
          }
          for (const batch of chunk(projection.columns, INSERT_CHUNK)) {
            await tx.insert(columns).values(batch.map((c) => ({ ...c })));
          }
          for (const batch of chunk(projection.rows, INSERT_CHUNK)) {
            await tx.insert(rowsTable).values(batch.map((r) => ({ ...r })));
          }
          for (const batch of chunk(projection.cells, INSERT_CHUNK)) {
            await tx.insert(cells).values(
              batch.map((c) => ({
                rowId: c.rowId,
                columnId: c.columnId,
                textPlain: c.textPlain,
                rich: c.rich,
                formula: c.formula,
              })),
            );
          }
        });
      },

      async search(documentId, query, limit) {
        return db
          .select({
            sheetId: sheets.id,
            tableId: tables.id,
            rowId: rowsTable.id,
            columnId: columns.id,
            textPlain: cells.textPlain,
          })
          .from(cells)
          .innerJoin(rowsTable, eq(rowsTable.id, cells.rowId))
          .innerJoin(columns, eq(columns.id, cells.columnId))
          .innerJoin(tables, eq(tables.id, rowsTable.tableId))
          .innerJoin(sheets, eq(sheets.id, tables.sheetId))
          .where(
            and(
              eq(sheets.documentId, documentId),
              // The expression matches the GIN index in migration 0000 exactly.
              sql`to_tsvector('simple', ${cells.textPlain}) @@ plainto_tsquery('simple', ${query})`,
            ),
          )
          .orderBy(
            asc(sheets.ordinal),
            asc(tables.id),
            asc(rowsTable.ordinal),
            asc(columns.ordinal),
          )
          .limit(limit);
      },

      async liveDocumentIds() {
        const found = await db
          .select({ id: documents.id })
          .from(documents)
          .where(isNull(documents.deletedAt))
          .orderBy(asc(documents.createdAt), asc(documents.id));
        return found.map((d) => d.id);
      },
    },
  };
}

/** Rows per multi-row insert: well under Postgres's 65 535 bound parameters at ≤ 8 columns. */
const INSERT_CHUNK = 2000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
