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
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
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
  graphs,
  invites,
  mailEvents,
  mailSuppressions,
  rows as rowsTable,
  shares,
  sheets,
  snapshots,
  tables,
  users,
  type Db,
  type Permission,
  type ShareSource,
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
  type ErasureAuditAction,
  type InviteRecord,
  type LibrarySort,
  type LibraryView,
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

/** What an erased account's row is called wherever a name would show (#111). */
export const ERASED_DISPLAY_NAME = 'Deleted user';

/** The audit actions whose `target` carries an email address (what erasure scrubs, ADR-038). */
export const ADDRESS_BEARING_AUDIT_ACTIONS: readonly ShareAuditAction[] = [
  'share.invite',
  'share.invite_accept',
  'share.invite_withdraw',
  'share.invite_remove',
  'share.stop',
];

/** A literal for a case-insensitive `regexp_replace`: every metacharacter escaped. */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A PostgreSQL ARE that matches `email` as a whole address inside an audit
 * `target` (bare, `addr:…`, or quoted in JSON) and never as a substring of a
 * longer one. Group 1 is the character before it, kept by the replacement;
 * the lookahead refuses an address character after it. ARE has no
 * lookbehind, hence the group.
 */
export function addressPattern(email: string): string {
  return `(^|[^A-Za-z0-9._%+-])${escapeRegex(email)}(?![A-Za-z0-9._%+-])`;
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

/**
 * The user row plus its guided sample's id (ONB-01), as one scalar subquery
 * so every read and `RETURNING` of `users` answers "does this account have
 * its sample yet" without a second round trip. The partial unique index
 * (migration 0009) makes the subquery an index probe and guarantees `LIMIT 1`
 * is not hiding a second row.
 */
const userColumns = {
  ...getTableColumns(users),
  // Qualified by hand: in a `RETURNING` list Drizzle renders `${users.id}` as the bare
  // `"id"`, which inside the subquery would resolve to `d.id`.
  sampleDocumentId: sql<string | null>`(
    select d.id from documents d
    where d.owner_id = ${sql.identifier('users')}.${sql.identifier('id')} and d.sample
    limit 1
  )`.as('sample_document_id'),
};

type UserRow = typeof users.$inferSelect & { sampleDocumentId: string | null };

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    cognitoSub: row.cognitoSub,
    email: row.email,
    displayName: row.displayName,
    locale: row.locale,
    tourDoneAt: row.tourDoneAt,
    librarySort: toLibrarySort(row.librarySort),
    sampleDocumentId: row.sampleDocumentId,
    deletedAt: row.deletedAt,
  };
}

/** The CHECK (migration 0011) keeps the column to these; anything else reads as unset. */
function toLibrarySort(value: string | null): LibrarySort | null {
  return value === 'name' || value === 'date' ? value : null;
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
    mailSentAt: row.mailSentAt,
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
  /** How the inviter's own share came to be; a `link` inviter's invitations make `link` shares (#101). */
  inviterSource: ShareSource | null;
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
 * Pending, unexpired invitations on live documents (#112: nothing converts
 * on a document in the trash) with the inviter's standing: the owner
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
      inviterSource: inviterShare.source,
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
    .where(and(where, invitePending, isNull(documents.deletedAt)))
    .orderBy(asc(invites.createdAt), asc(invites.id));
}

/**
 * The `source` a share inherits (#101): a share given by someone who came in
 * through the share link is a link share — it goes when the link goes — and
 * so is anything they in turn give. The owner's, and an invited editor's,
 * shares are `invite` shares.
 */
export function inheritedSource(inviterSource: ShareSource | null | undefined): ShareSource {
  return inviterSource === 'link' ? 'link' : 'invite';
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

/**
 * Withdraw an invitation whose inviter no longer holds what it grants, with
 * its audit row. Only a row that is still pending goes, and the audit row is
 * written only when one did: called under the document lock on a row read
 * `FOR UPDATE`, this is belt and braces; called on a stale read it is what
 * keeps a just-accepted invitation from being "withdrawn" after the fact.
 */
async function withdrawStale(
  tx: Executor,
  row: PendingRow,
  actorId: string | null,
): Promise<boolean> {
  const gone = await tx
    .delete(invites)
    .where(and(eq(invites.id, row.id), isNull(invites.acceptedAt)))
    .returning({ id: invites.id });
  if (gone.length === 0) return false;
  await tx.insert(auditLog).values({
    documentId: row.documentId,
    userId: actorId,
    action: 'share.invite_withdraw' satisfies ShareAuditAction,
    target: `${row.email}:${row.invitedBy}`,
  });
  return true;
}

/**
 * Convert one pending invitation for `userId`, under the document row lock
 * (#100, the #88 pattern): the row is read again `FOR UPDATE` after the lock
 * — with `extra` narrowing it further (`accept` requires the caller to hold
 * the address) — so an invitation withdrawn, a share stopped or a document
 * deleted while the caller was on its way is seen, and the inviter's
 * standing (`inviterStillMay`) is judged on the row as it is now. A stale
 * one is withdrawn (`share.invite_withdraw` by `actorId`, or the system);
 * a converted one becomes a share with the invitation's inviter and the
 * inheritable source (#101), is marked accepted and audited
 * `share.invite_accept`. `undefined` when nothing pending remained.
 */
async function convertOne(
  tx: Executor,
  inviteId: string,
  userId: string,
  actorId: string | null,
  extra?: SQL,
): Promise<ConvertedInvite | undefined> {
  const [target] = await tx
    .select({ documentId: invites.documentId })
    .from(invites)
    .where(eq(invites.id, inviteId))
    .limit(1);
  if (!target || !(await lockDocument(tx, target.documentId))) return undefined;
  const byId = eq(invites.id, inviteId);
  const [match] = await pendingInvitesQuery(
    tx,
    extra === undefined ? byId : sql`${byId} and ${extra}`,
  ).for('update', { of: invites });
  if (!match) return undefined;
  if (!inviterStillMay(match)) {
    await withdrawStale(tx, match, actorId);
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
        source: inheritedSource(match.inviterSource),
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
  return { documentId: match.documentId, permission: match.permission };
}

/**
 * SHARE-02, the conversion: every pending, unexpired invitation for `email`
 * becomes a share for `userId` through `convertOne` — each under its
 * document's lock, re-read there, so a withdrawal or a stop that lands
 * between the listing and the lock wins (#100). Idempotent: a second run
 * finds nothing pending.
 */
async function convertInvites(
  tx: Executor,
  userId: string,
  email: string,
): Promise<ConvertedInvite[]> {
  // Document id order, the one every multi-document transaction uses (an
  // erasure locks its documents sorted the same way), so two of them cannot
  // each hold a row the other waits for. Which invitation converts first
  // changes nothing but the order of the audit rows.
  const candidates = await tx
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.email, email), invitePending))
    .orderBy(asc(invites.documentId), asc(invites.createdAt), asc(invites.id));
  const converted: ConvertedInvite[] = [];
  for (const { id } of candidates) {
    const outcome = await convertOne(tx, id, userId, null);
    if (outcome) converted.push(outcome);
  }
  return converted;
}

/** Aliases for the extra `users` joins in the library query and the shares-exist probe. */
const owner = alias(users, 'owner');
const inviter = alias(users, 'inviter');

/** Deleted within the retention window (LIB-08), evaluated on the database's clock. */
const withinRetention = sql`${documents.deletedAt} > now() - (${RECENTLY_DELETED_DAYS}::int * interval '1 day')`;

export function createPgRepo(db: Db, logger: Logger): Repo {
  /**
   * One definition of "shared" for the current `documents` row (#139, SHARE-05,
   * LIB-01/02): a participant exists (a share row) or the link is on — the
   * same facts that make the workscape non-deletable (`ever_shared`, LIB-D1/D4),
   * so the title pill, the library row, the Shared view and the delete/archive
   * slot never disagree. A pending invitation is not a participant (SHARE-01
   * lists it apart; LIB-D4: sent is not accepted) and leaves the workscape
   * deletable, so it does not count — the sheet still lists it, with Resend.
   */
  const sharedWithOthers = (): SQL<boolean> => {
    const anyShareExists = exists(
      db
        .select({ one: sql`1` })
        .from(anyShare)
        .where(eq(anyShare.documentId, documents.id)),
    );
    return sql<boolean>`(${anyShareExists} or ${ne(documents.linkAccess, 'none')})`;
  };

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
        // Names and addresses apart (#102): the route decides who sees an address.
        ownerName: owner.displayName,
        ownerEmail: owner.email,
        sharePermission: shares.permission,
        invitedBy: shares.invitedBy,
        inviterName: inviter.displayName,
        inviterEmail: inviter.email,
        sharedWithOthers: sharedWithOthers(),
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
        ? { id: row.invitedBy, name: row.inviterName, email: row.inviterEmail }
        : null;
    return {
      ...doc,
      ownerName: row.ownerName,
      ownerEmail: row.ownerEmail,
      sizeBytes: Number(row.sizeBytes),
      sharedBy,
      sharedWithOthers: row.sharedWithOthers,
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
        return and(live, or(sharedWithMe, and(ownedAndShown, sharedWithOthers())));
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
                // A tombstone (#111) is left exactly as it is: no address
                // re-bound from the token, no last-seen; the resolver refuses it.
                set: {
                  lastSeenAt: sql`case when ${users.deletedAt} is null then ${now} else ${users.lastSeenAt} end`,
                  email: sql`case when ${users.deletedAt} is null then coalesce(${users.email}, excluded.email) else ${users.email} end`,
                },
              })
              .returning(userColumns);
          let rows: UserRow[];
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
          if (row.deletedAt === null && row.email !== null && identity.email !== null) {
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
          let row: UserRow | undefined;
          try {
            [row] = await tx.transaction((inner) =>
              inner
                .update(users)
                .set({
                  email: sql`case when ${users.deletedAt} is null then coalesce(${users.email}, ${email}) else ${users.email} end`,
                })
                .where(eq(users.id, id))
                .returning(userColumns),
            );
          } catch (error) {
            if (isUniqueViolation(error, 'users_email_key')) throw new EmailTakenError();
            throw error;
          }
          if (!row) return undefined;
          if (row.deletedAt !== null) return { user: toUser(row), converted: [] };
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
        const [row] = await db
          .select(userColumns)
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        return row ? toUser(row) : undefined;
      },

      async updateProfile(id, patch) {
        const set: Partial<typeof users.$inferInsert> = {};
        if (patch.displayName !== undefined) set.displayName = patch.displayName;
        if (patch.locale !== undefined) set.locale = patch.locale;
        // ONB-03: the flag is a timestamp so support can see when; `false` is Replay (ONB-08).
        if (patch.tourDone !== undefined) set.tourDoneAt = patch.tourDone ? new Date() : null;
        if (patch.librarySort !== undefined) set.librarySort = patch.librarySort;
        if (Object.keys(set).length === 0) {
          const [row] = await db.select(userColumns).from(users).where(eq(users.id, id)).limit(1);
          return row ? toUser(row) : undefined;
        }
        const [row] = await db
          .update(users)
          .set(set)
          .where(eq(users.id, id))
          .returning(userColumns);
        return row ? toUser(row) : undefined;
      },

      erase(id) {
        return db.transaction(async (tx) => {
          // NO KEY UPDATE, not UPDATE: the row's key is not changing, and a
          // plain FOR UPDATE would conflict with the FOR KEY SHARE every
          // share or invitation insert takes on it through its foreign key —
          // an acceptance in flight (which holds a document lock this
          // transaction is about to wait for) would deadlock with it.
          const [row] = await tx.select().from(users).where(eq(users.id, id)).for('no key update');
          if (!row) return undefined;
          if (row.deletedAt !== null) return null;
          const now = new Date();

          // Every document this touches is locked up front, in one statement,
          // in id order — never one at a time in three differently ordered
          // groups. Two erasures whose owners share documents, or an erasure
          // beside a sign-in conversion (which locks in the same id order),
          // would otherwise each hold one row the other waits for (40P01).
          // The lists are read again under the locks: what committed while
          // this waited (a transfer that made this account an owner, a share
          // it was given) is seen, and a row that went is not acted on.
          const heldDocs = (q: Executor) =>
            q
              .select({ documentId: shares.documentId })
              .from(shares)
              .where(eq(shares.userId, id))
              .orderBy(asc(shares.documentId));
          const sentInvites = (q: Executor) =>
            q
              .select({ id: invites.id, documentId: invites.documentId })
              .from(invites)
              .where(and(eq(invites.invitedBy, id), invitePending))
              .orderBy(asc(invites.documentId), asc(invites.id));
          const ownedDocs = (q: Executor) =>
            q
              .select({ id: documents.id, sample: documents.sample })
              .from(documents)
              .where(and(eq(documents.ownerId, id), isNull(documents.deletedAt)))
              .orderBy(asc(documents.createdAt), asc(documents.id));
          const touched = new Set<string>([
            ...(await heldDocs(tx)).map((s) => s.documentId),
            ...(await sentInvites(tx)).map((i) => i.documentId),
            ...(await ownedDocs(tx)).map((d) => d.id),
          ]);
          if (touched.size > 0) {
            await tx
              .select({ id: documents.id })
              .from(documents)
              .where(inArray(documents.id, [...touched]))
              .orderBy(asc(documents.id))
              .for('update');
          }

          // Shares the user holds on other people's documents: gone, each
          // under its document's lock, so `ever_shared` is right (LIB-D4).
          const held = await heldDocs(tx);
          const sharesRemoved: string[] = [];
          for (const { documentId } of held) {
            await lockDocument(tx, documentId);
            const gone = await tx
              .delete(shares)
              .where(and(eq(shares.documentId, documentId), eq(shares.userId, id)))
              .returning({ userId: shares.userId });
            if (gone.length === 0) continue;
            await clearSharedIfNone(tx, documentId);
            await tx.insert(auditLog).values({
              documentId,
              userId: id,
              action: 'share.remove' satisfies ShareAuditAction,
              target: id,
            });
            sharesRemoved.push(documentId);
          }

          // Pending invitations the user sent are only as good as their
          // sender. Each is withdrawn under its document's lock after a
          // `FOR UPDATE` re-read (the #100 pattern): an acceptance in flight
          // either committed first — and the row is no longer pending — or
          // waits behind the lock and finds it gone.
          const sent = await sentInvites(tx);
          let invitesWithdrawn = 0;
          for (const { id: inviteId, documentId } of sent) {
            if (!(await lockDocument(tx, documentId))) continue;
            const [fresh] = await pendingInvitesQuery(tx, eq(invites.id, inviteId)).for('update', {
              of: invites,
            });
            if (fresh && (await withdrawStale(tx, fresh, id))) invitesWithdrawn += 1;
          }

          // Every invitation row addressed to them carries their address.
          if (row.email !== null) {
            await tx.delete(invites).where(eq(invites.email, row.email));
          }

          // Owned live documents: to the earliest editor, else into the trash.
          const owned = await ownedDocs(tx);
          const transferred: { documentId: string; toUserId: string }[] = [];
          const deleted: string[] = [];
          for (const doc of owned) {
            await lockDocument(tx, doc.id);
            // An editor whose own erasure has committed is a tombstone and
            // cannot become an owner. One whose erasure is in flight either
            // already holds this document (then this waits, and finds the
            // share gone and the row a tombstone) or is waiting for it (then
            // it re-reads its owned list under the lock and finds the
            // document it was just given).
            const [editor] = doc.sample
              ? []
              : await tx
                  .select({ userId: shares.userId })
                  .from(shares)
                  .innerJoin(users, eq(users.id, shares.userId))
                  .where(
                    and(
                      eq(shares.documentId, doc.id),
                      eq(shares.permission, 'edit'),
                      isNull(users.deletedAt),
                    ),
                  )
                  .orderBy(asc(shares.createdAt), asc(shares.userId))
                  .limit(1);
            if (editor) {
              // The new owner is implicit edit: their share goes; whoever the
              // old owner invited is now theirs to manage.
              await tx
                .delete(shares)
                .where(and(eq(shares.documentId, doc.id), eq(shares.userId, editor.userId)));
              await tx
                .update(shares)
                .set({ invitedBy: editor.userId })
                .where(and(eq(shares.documentId, doc.id), eq(shares.invitedBy, id)));
              await tx
                .update(invites)
                .set({ invitedBy: editor.userId })
                .where(and(eq(invites.documentId, doc.id), eq(invites.invitedBy, id)));
              await tx
                .update(documents)
                .set({ ownerId: editor.userId, updatedAt: now })
                .where(eq(documents.id, doc.id));
              await clearSharedIfNone(tx, doc.id);
              await tx.insert(auditLog).values({
                documentId: doc.id,
                userId: id,
                action: 'document.transfer' satisfies ErasureAuditAction,
                target: editor.userId,
              });
              transferred.push({ documentId: doc.id, toUserId: editor.userId });
              continue;
            }
            const gone = await tx
              .delete(shares)
              .where(eq(shares.documentId, doc.id))
              .returning({ userId: shares.userId });
            const withdrawn = await tx
              .delete(invites)
              .where(and(eq(invites.documentId, doc.id), isNull(invites.acceptedAt)))
              .returning({ email: invites.email });
            if (gone.length > 0 || withdrawn.length > 0) {
              await tx.insert(auditLog).values({
                documentId: doc.id,
                userId: id,
                action: 'share.stop' satisfies ShareAuditAction,
                target: JSON.stringify({
                  users: gone.map((g) => g.userId),
                  invites: withdrawn.map((w) => w.email),
                }),
              });
            }
            // The sample flag is cleared first: the CHECK forbids a sample in
            // the trash, and an erased account's sample is not a sample any more.
            await tx
              .update(documents)
              .set({
                sample: false,
                linkAccess: 'none',
                linkToken: null,
                everShared: false,
                archivedAt: null,
                deletedAt: now,
                updatedAt: now,
              })
              .where(eq(documents.id, doc.id));
            await tx.insert(auditLog).values({
              documentId: doc.id,
              userId: id,
              action: 'document.delete' satisfies ErasureAuditAction,
              target: null,
            });
            deleted.push(doc.id);
          }

          // Edits stop being attributable; audit rows keep the actor id (ADR-038)
          // but not the address.
          await tx.update(docUpdates).set({ authorId: null }).where(eq(docUpdates.authorId, id));
          if (row.email !== null) {
            // Only the share actions carry an address in `target`; the scan
            // is bounded to them. The match is the whole address, never a
            // substring: `bob@x.com` must leave `bob@x.com.au` and
            // `malice@x.com` (an `alice@x.com`) as they are.
            const pattern = addressPattern(row.email);
            await tx
              .update(auditLog)
              .set({
                target: sql`regexp_replace(${auditLog.target}, ${pattern}, '\\1[erased]', 'gi')`,
              })
              .where(
                and(
                  inArray(auditLog.action, [...ADDRESS_BEARING_AUDIT_ACTIONS]),
                  sql`${auditLog.target} ~* ${pattern}`,
                ),
              );
          }

          await tx
            .update(users)
            .set({
              email: null,
              displayName: ERASED_DISPLAY_NAME,
              locale: null,
              tourDoneAt: null,
              librarySort: null,
              lastSeenAt: null,
              deletedAt: now,
            })
            .where(eq(users.id, id));
          return {
            cognitoSub: row.cognitoSub,
            transferred,
            deleted,
            sharesRemoved,
            invitesWithdrawn,
          };
        });
      },
    },

    documents: {
      async listForUser(userId, view) {
        // ONB-01: the caller's own guided sample is pinned above every other
        // row in every view it appears in. Someone else's sample, shared with
        // the caller (the tour's last step invites a person to it), is an
        // ordinary shared row and sorts with the rest.
        const rows = await summaryQuery(userId)
          .where(scopeFor(userId, view))
          .orderBy(
            desc(sql`(${documents.sample} and ${documents.ownerId} = ${userId})`),
            desc(documents.updatedAt),
            desc(documents.id),
          );
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

      createSample({ id, ownerId, title, snapshot, writeSnapshot }) {
        return db.transaction(async (tx) => {
          // ONB-01: one seeder per owner across every task. The lock is
          // transaction-scoped and keyed on a namespaced string, so it can never
          // be the migration runner's (`hashtext('gede_migrations')`). Whoever
          // holds it first reads no sample, writes the object, inserts; the
          // others wait, read the committed row and adopt it — one S3 put,
          // nothing orphaned. The partial unique index remains the invariant.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`gede_sample:${ownerId}`}))`,
          );
          const [existing] = await tx
            .select()
            .from(documents)
            .where(and(eq(documents.ownerId, ownerId), eq(documents.sample, true)))
            .limit(1);
          if (existing) return { document: toDocument(existing), created: false };
          // The object first, inside the lock: a failure here rolls back with no row written.
          await writeSnapshot();
          const [row] = await tx
            .insert(documents)
            .values({
              id,
              ownerId,
              title,
              sample: true,
              snapshotKey: snapshot.s3Key,
              snapshotSeq: snapshot.seq,
            })
            .returning();
          if (!row) throw new Error('sample insert returned no row');
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
            target: 'sample',
          });
          return { document: toDocument(row), created: true };
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
          .where(
            and(eq(documents.id, id), isNull(documents.deletedAt), eq(documents.sample, false)),
          )
          .returning();
        return row ? toDocument(row) : undefined;
      },

      tryDelete(id, actorId) {
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
          if (row) {
            // #112: a pending invitation must not outlive the delete and
            // convert on a document in the trash (or hold the token alive).
            const withdrawn = await tx
              .delete(invites)
              .where(and(eq(invites.documentId, id), isNull(invites.acceptedAt)))
              .returning({ email: invites.email, invitedBy: invites.invitedBy });
            if (withdrawn.length > 0) {
              await tx.insert(auditLog).values(
                withdrawn.map((w) => ({
                  documentId: id,
                  userId: actorId,
                  action: 'share.invite_withdraw' satisfies ShareAuditAction,
                  target: `${w.email}:${w.invitedBy ?? row.ownerId}`,
                })),
              );
            }
            return {
              status: 'deleted',
              document: toDocument(row),
              withdrawn: withdrawn.map((w) => w.email),
            };
          }
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

      purgeDeleted(ownerId, actorId, limit) {
        return db.transaction(async (tx) => {
          const doomed = await tx
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(
              and(
                eq(documents.ownerId, ownerId),
                isNotNull(documents.deletedAt),
                // Belt and braces (#114): the CHECK forbids a sample in the trash.
                eq(documents.sample, false),
              ),
            )
            .orderBy(asc(documents.deletedAt), asc(documents.id))
            .limit(limit)
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

      async expiredForPurge({ limit, exclude }) {
        return db
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(
            and(
              isNotNull(documents.deletedAt),
              not(withinRetention),
              eq(documents.sample, false),
              ...(exclude.length === 0 ? [] : [notInArray(documents.id, [...exclude])]),
            ),
          )
          .orderBy(asc(documents.deletedAt), asc(documents.id))
          .limit(limit);
      },

      purge(ids) {
        if (ids.length === 0) return Promise.resolve([]);
        return db.transaction(async (tx) => {
          // Re-checked under the lock: still in the trash, still past the
          // window, still not a sample. A row recovered or purged by another
          // run since `expiredForPurge` is simply not here.
          const doomed = await tx
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(
              and(
                inArray(documents.id, [...ids]),
                isNotNull(documents.deletedAt),
                not(withinRetention),
                eq(documents.sample, false),
              ),
            )
            .orderBy(asc(documents.deletedAt), asc(documents.id))
            .for('update', { skipLocked: true });
          if (doomed.length === 0) return [];
          // `user_id` null is the system actor: nobody pressed Delete All.
          await tx.insert(auditLog).values(
            doomed.map((d) => ({
              documentId: d.id,
              userId: null,
              action: 'document.purge',
              target: d.title,
            })),
          );
          // shares, invites, doc_updates and snapshots cascade from documents.
          await tx.delete(documents).where(
            inArray(
              documents.id,
              doomed.map((d) => d.id),
            ),
          );
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
            mailSentAt: invites.mailSentAt,
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
          // #101: a share given by a link-sourced editor goes with the link.
          const [inviterRow] = await tx
            .select({ source: shares.source })
            .from(shares)
            .where(and(eq(shares.documentId, documentId), eq(shares.userId, invitedBy)))
            .limit(1);
          const inserted = await tx
            .insert(shares)
            .values({
              documentId,
              userId,
              permission,
              invitedBy,
              source: inheritedSource(inviterRow?.source),
            })
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
            // #112: the link of a document in the trash cannot be switched on.
            .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
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
            .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
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
          // Lock order documents → invites, as every share transaction (#100):
          // a conversion in flight either sees this withdrawal or commits first.
          if (!(await lockDocument(tx, documentId))) return false;
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

      async markMailSent({ inviteId }) {
        const rows = await db
          .update(invites)
          .set({ mailSentAt: new Date() })
          .where(eq(invites.id, inviteId))
          .returning({ id: invites.id });
        return rows.length > 0;
      },

      async pending({ documentId, inviteId }) {
        const [row] = await db
          .select()
          .from(invites)
          .where(and(eq(invites.id, inviteId), eq(invites.documentId, documentId), invitePending))
          .limit(1);
        return row ? toInvite(row) : undefined;
      },

      accept({ inviteId, userId }) {
        return db.transaction(async (tx) => {
          // The address check is in SQL: the invitation converts only for the
          // account that holds its (citext-equal) email.
          const holdsAddress = exists(
            tx
              .select({ one: sql`1` })
              .from(users)
              .where(and(eq(users.id, userId), eq(users.email, invites.email))),
          );
          const converted = await convertOne(tx, inviteId, userId, userId, holdsAddress);
          return converted?.permission;
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
          // GRAPH-01..11: one row per half; sheets → graphs cascade on delete.
          for (const batch of chunk(projection.graphs, INSERT_CHUNK)) {
            await tx.insert(graphs).values(
              batch.map((g) => ({
                id: g.id,
                sheetId: g.sheetId,
                pairId: g.pairId,
                kind: g.kind,
                tableId: g.tableId,
                dimensionColumns: [...g.dimensionColumns],
                gridCol: g.gridCol,
                gridRow: g.gridRow,
                widthUnits: g.widthUnits,
                heightUnits: g.heightUnits,
                slice: g.slice,
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

    mail: {
      recordEvent({ messageId, email, kind, at, source, since }) {
        return db.transaction(async (tx) => {
          // The primary key decides idempotency: a redelivered SQS message (a
          // crash after the verdict, a visibility timeout) inserts nothing.
          const inserted = await tx
            .insert(mailEvents)
            .values({ messageId, email, kind, at, source })
            .onConflictDoNothing({ target: [mailEvents.messageId, mailEvents.email] })
            .returning({ messageId: mailEvents.messageId });
          const [counted] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(mailEvents)
            .where(
              and(
                eq(mailEvents.email, email),
                eq(mailEvents.kind, 'bounce_transient'),
                gt(mailEvents.at, since),
              ),
            );
          return { recorded: inserted.length > 0, transientBounces: counted?.n ?? 0 };
        });
      },

      suppress({ email, reason, at, source }) {
        return db.transaction(async (tx) => {
          const inserted = await tx
            .insert(mailSuppressions)
            .values({ email, reason, firstSeenAt: at, lastEventAt: at, source })
            .onConflictDoUpdate({
              target: mailSuppressions.email,
              // A repeat keeps the first sighting and the first reason; what
              // moves is when SES last said so, and what it said.
              set: { lastEventAt: at, source },
            })
            // `xmax = 0` on the returned row: inserted now; otherwise updated.
            .returning({ created: sql<boolean>`(${mailSuppressions}.xmax = 0)` });
          const created = inserted[0]?.created === true;
          // Pending invitations to the address go, each under its document's
          // lock (documents → invites, #100) so a conversion in flight either
          // sees the withdrawal or commits first; document id order, as every
          // multi-document transaction locks.
          const pending = await tx
            .select({ id: invites.id, documentId: invites.documentId })
            .from(invites)
            .where(and(eq(invites.email, email), invitePending))
            .orderBy(asc(invites.documentId), asc(invites.createdAt), asc(invites.id));
          const withdrawn: string[] = [];
          for (const { id, documentId } of pending) {
            if (!(await lockDocument(tx, documentId))) continue;
            const gone = await tx
              .delete(invites)
              .where(and(eq(invites.id, id), isNull(invites.acceptedAt)))
              .returning({ email: invites.email });
            if (gone.length === 0) continue;
            await tx.insert(auditLog).values({
              documentId,
              userId: null,
              action: 'share.invite_withdraw' satisfies ShareAuditAction,
              target: `${email}:${reason}`,
            });
            withdrawn.push(documentId);
          }
          return { created, withdrawn };
        });
      },

      async suppression(email) {
        const [row] = await db
          .select({
            email: mailSuppressions.email,
            reason: mailSuppressions.reason,
            firstSeenAt: mailSuppressions.firstSeenAt,
            lastEventAt: mailSuppressions.lastEventAt,
          })
          .from(mailSuppressions)
          .where(eq(mailSuppressions.email, email))
          .limit(1);
        return row;
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
