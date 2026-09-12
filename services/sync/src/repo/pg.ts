/**
 * Postgres implementation of `Repo` over Drizzle. Every multi-statement
 * operation runs in one transaction; sequence numbers are assigned under the
 * document row lock so two writers can never collide (ARCHITECTURE §1.7 step 1
 * — a second task — needs no change here).
 */
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { auditLog, docUpdates, documents, shares, snapshots, users, type Db } from '@gede/db';

import type { Logger } from '../logger.js';
import type {
  DocumentListing,
  DocumentPermission,
  DocumentRecord,
  Repo,
  UserRecord,
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
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toUser(row: typeof users.$inferSelect): UserRecord {
  return { id: row.id, cognitoSub: row.cognitoSub, email: row.email, displayName: row.displayName };
}

export function createPgRepo(db: Db, logger: Logger): Repo {
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
    },

    documents: {
      async listForUser(userId, view) {
        const ownedOrShared = or(eq(documents.ownerId, userId), isNotNull(shares.userId));
        const scope =
          view === 'active'
            ? and(isNull(documents.deletedAt), ownedOrShared)
            : and(isNotNull(documents.deletedAt), eq(documents.ownerId, userId));
        const rows = await db
          .select({ doc: documents, shared: shares.permission })
          .from(documents)
          .leftJoin(shares, and(eq(shares.documentId, documents.id), eq(shares.userId, userId)))
          .where(scope)
          .orderBy(desc(documents.updatedAt));
        const listings: DocumentListing[] = [];
        for (const { doc, shared } of rows) {
          const permission: DocumentPermission | null =
            doc.ownerId === userId ? 'owner' : (shared ?? null);
          if (permission === null) continue; // cannot happen given the WHERE, but never invent access
          listings.push({ ...toDocument(doc), permission });
        }
        return listings;
      },

      async get(id) {
        const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
        return row ? toDocument(row) : undefined;
      },

      async create({ ownerId, title }) {
        const [row] = await db.insert(documents).values({ ownerId, title }).returning();
        if (!row) throw new Error('documents insert returned no row');
        return toDocument(row);
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

      async sharePermission(documentId, userId) {
        const [row] = await db
          .select({ permission: shares.permission })
          .from(shares)
          .where(and(eq(shares.documentId, documentId), eq(shares.userId, userId)))
          .limit(1);
        return row?.permission;
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
