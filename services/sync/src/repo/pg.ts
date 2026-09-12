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
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { auditLog, docUpdates, documents, shares, snapshots, users, type Db } from '@gede/db';

import type { Logger } from '../logger.js';
import {
  RECENTLY_DELETED_DAYS,
  type DocumentListing,
  type DocumentPermission,
  type DocumentRecord,
  type DocumentSummary,
  type LibraryView,
  type Repo,
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

type DocumentRow = typeof documents.$inferSelect;

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    linkAccess: row.linkAccess,
    snapshotKey: row.snapshotKey,
    snapshotSeq: row.snapshotSeq,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
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

/** Aliases for the extra `users` joins in the library query and the shares-exist probe. */
const owner = alias(users, 'owner');
const inviter = alias(users, 'inviter');
const anyShare = alias(shares, 'any_share');

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
    switch (view) {
      case 'recents':
        return and(live, or(owned, sharedWithMe));
      case 'browse':
        return and(live, owned);
      case 'shared':
        return and(live, or(sharedWithMe, and(owned, hasShares())));
      case 'deleted':
        return and(owned, isNotNull(documents.deletedAt), withinRetention);
    }
  }

  return {
    async ping() {
      await db.execute(sql`SELECT 1`);
    },

    users: {
      async upsertFromToken(identity) {
        const now = new Date();
        const upsert = (email: string | null) =>
          db
            .insert(users)
            .values({ cognitoSub: identity.sub, email, lastSeenAt: now })
            .onConflictDoUpdate({
              target: users.cognitoSub,
              set: { lastSeenAt: now, email: sql`coalesce(${users.email}, excluded.email)` },
            })
            .returning();
        let rows: (typeof users.$inferSelect)[];
        try {
          rows = await upsert(identity.email);
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
          rows = await upsert(null);
        }
        const row = rows[0];
        if (!row) throw new Error('users upsert returned no row');
        return toUser(row);
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
        const [row] = await db
          .update(documents)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
          .returning();
        return row ? toDocument(row) : undefined;
      },

      async recover(id) {
        const [row] = await db
          .update(documents)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(and(eq(documents.id, id), isNotNull(documents.deletedAt)))
          .returning();
        return row ? toDocument(row) : undefined;
      },

      async recoverAllDeleted(ownerId) {
        const rows = await db
          .update(documents)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(
            and(eq(documents.ownerId, ownerId), isNotNull(documents.deletedAt), withinRetention),
          )
          .returning();
        return rows.map(toDocument);
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
          })
          .from(shares)
          .innerJoin(users, eq(users.id, shares.userId))
          .where(eq(shares.documentId, documentId))
          .orderBy(asc(shares.createdAt), asc(shares.userId));
        return {
          owner: { id: head.ownerId, name: head.ownerName, email: head.ownerEmail },
          participants: rows,
          linkAccess: head.linkAccess,
        };
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

      async commitSnapshot({ documentId, seq, s3Key, sizeBytes }) {
        await db.transaction(async (tx) => {
          await tx.insert(snapshots).values({ documentId, seq, s3Key, sizeBytes });
          await tx
            .update(documents)
            .set({ snapshotKey: s3Key, snapshotSeq: seq })
            .where(eq(documents.id, documentId));
          await tx
            .delete(docUpdates)
            .where(and(eq(docUpdates.documentId, documentId), sql`${docUpdates.seq} <= ${seq}`));
        });
      },
    },

    audit: {
      async record(entry) {
        await db.insert(auditLog).values(entry);
      },
    },
  };
}
