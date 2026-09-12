/**
 * The repository boundary. `buildServer` receives an implementation of `Repo`
 * — Postgres via Drizzle in production (`pg.ts`), an in-memory fake in tests
 * (`src/test/fake-repo.ts`). Keeping the surface small keeps the fake honest:
 * it implements exactly the queries the service issues, nothing more.
 */
import type { LinkAccess, Permission } from '@gede/db';

import type { Projection } from '../projection/project.js';

export interface UserRecord {
  readonly id: string;
  readonly cognitoSub: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** I18N-05: one of the supported BCP 47 tags, or null until chosen. */
  readonly locale: string | null;
}

export interface DocumentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly linkAccess: LinkAccess;
  readonly snapshotKey: string | null;
  readonly snapshotSeq: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/** What a caller may do with a document. `owner` implies edit plus sharing and deletion. */
export type DocumentPermission = 'owner' | Permission;

/** A person as the library shows them: display name, else email, else nothing. */
export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
}

/**
 * A document as one caller sees it in the library (LIB-01, LIB-02): the row
 * plus who owns it, who shared it with the caller, whether it is shared at
 * all, and its size. Everything here comes from one query per list.
 */
export interface DocumentSummary extends DocumentRecord {
  readonly ownerName: string | null;
  /** Latest snapshot `size_bytes` plus the bytes of every update logged since it. */
  readonly sizeBytes: number;
  /** Who shared it with the caller; null for the owner. */
  readonly sharedBy: PersonRef | null;
  /** True when at least one participant besides the owner has a share. */
  readonly sharedWithOthers: boolean;
}

export interface DocumentListing extends DocumentSummary {
  readonly permission: DocumentPermission;
}

/**
 * Library views (LIB-01). `recents` and `browse` and `shared` exclude deleted
 * documents; `deleted` is the owner's Recently Deleted for the last 30 days.
 */
export type LibraryView = 'recents' | 'browse' | 'shared' | 'deleted';

export const RECENTLY_DELETED_DAYS = 30;

export interface Participant {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly permission: Permission;
  readonly invitedBy: string;
}

export interface ParticipantList {
  readonly owner: {
    readonly id: string;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly participants: readonly Participant[];
  readonly linkAccess: LinkAccess;
}

/** What a permanent delete removed, so the caller can clean S3 up afterwards. */
export interface PurgedDocument {
  readonly id: string;
  readonly title: string;
}

export interface TokenIdentity {
  readonly sub: string;
  /** Email, when the token carried one. Access tokens usually do not. */
  readonly email: string | null;
}

export interface StoredUpdate {
  readonly seq: number;
  readonly update: Uint8Array;
}

/** Snapshot pointer plus the log tail, read in one consistent snapshot of the database. */
export interface DocumentState {
  readonly snapshotKey: string | null;
  readonly snapshotSeq: number;
  readonly updates: readonly StoredUpdate[];
}

export interface AppendedRange {
  readonly firstSeq: number;
  readonly lastSeq: number;
}

export interface ProfilePatch {
  readonly displayName?: string;
  readonly locale?: string;
}

export interface UsersRepo {
  /** Insert on first sight of a `sub`, otherwise refresh `last_seen_at` (and fill a missing email). */
  upsertFromToken(identity: TokenIdentity): Promise<UserRecord>;
  /** Set the fields present in `patch`; `undefined` when the user does not exist. */
  updateProfile(id: string, patch: ProfilePatch): Promise<UserRecord | undefined>;
}

export interface DocumentsRepo {
  /** One query, no per-row follow-ups: the library rows for a view, newest `updated_at` first. */
  listForUser(userId: string, view: LibraryView): Promise<DocumentListing[]>;
  get(id: string): Promise<DocumentRecord | undefined>;
  /** The library row for one document as `userId` sees it. Does not check access; callers do. */
  summarise(id: string, userId: string): Promise<DocumentSummary | undefined>;
  /**
   * Insert the row already pointing at its initial snapshot (DOC-03: the
   * seeded Y.Doc the caller has put in S3 as `snapshot.s3Key`), the
   * `snapshots` row and the `document.create` audit row, in one transaction.
   * The id is chosen by the caller because the S3 key needs it first.
   */
  create(input: {
    id: string;
    ownerId: string;
    title: string;
    snapshot: { seq: number; s3Key: string; sizeBytes: number };
  }): Promise<DocumentRecord>;
  rename(id: string, title: string): Promise<DocumentRecord | undefined>;
  softDelete(id: string): Promise<DocumentRecord | undefined>;
  /**
   * Clear `deleted_at`; `undefined` when the document is not soft-deleted or
   * its deletion is past the retention window (it is no longer in Recently
   * Deleted, so it cannot be recovered from there).
   */
  recover(id: string): Promise<DocumentRecord | undefined>;
  /**
   * Recover every owned document deleted within the retention window and
   * write one `document.recover` audit row per document, in one transaction.
   */
  recoverAllDeleted(ownerId: string, actorId: string): Promise<DocumentRecord[]>;
  /**
   * Permanently delete every owned soft-deleted document (including any past
   * the retention window) with its updates, snapshots, shares and invites,
   * and write one `document.purge` audit row per document, all in one
   * transaction. S3 objects are the caller's job once this has committed.
   */
  purgeDeleted(ownerId: string, actorId: string): Promise<PurgedDocument[]>;
  /**
   * The nightly job's half of LIB-08: permanently delete up to `limit`
   * documents, any owner, whose soft-deletion is older than the retention
   * window, with the same cascade and one `document.purge` audit row each
   * written by the system actor (`user_id` null). The rows are claimed
   * (locked) first, `removeObjects` runs for each while the claim is held,
   * and only the documents whose objects are gone are deleted when the
   * transaction commits — an S3 failure leaves that document's rows in
   * place for the next run, never an orphaned object (review finding 3).
   * `exclude` skips documents that already failed in this run. Call again
   * until `purged.length + failed.length < limit`.
   */
  purgeExpired(input: {
    limit: number;
    exclude: readonly string[];
    removeObjects: (doc: PurgedDocument) => Promise<boolean>;
  }): Promise<{ purged: PurgedDocument[]; failed: PurgedDocument[] }>;
  /** Explicit share permission for a user, if any. Ownership is checked separately. */
  sharePermission(documentId: string, userId: string): Promise<Permission | undefined>;
  /** Owner, every share with the inviter, and the link mode (LIB-07). */
  participants(documentId: string): Promise<ParticipantList | undefined>;
}

export interface UpdatesRepo {
  /** Snapshot pointer and every update with `seq > snapshot_seq`, consistently. */
  loadState(documentId: string): Promise<DocumentState>;
  /** Append updates with consecutive sequence numbers assigned inside a transaction. */
  append(
    documentId: string,
    updates: readonly { update: Uint8Array; authorId: string | null }[],
  ): Promise<AppendedRange>;
  /**
   * Record a compaction atomically and monotonically: under the document
   * row lock, insert the snapshot row, point the document at it and prune
   * the log up to and including `seq` — but only when `seq` is greater than
   * the `snapshot_seq` already committed. A stale commit (another task
   * compacted further, #39) changes nothing and resolves `false`; the log
   * above the committed seq is never pruned.
   */
  commitSnapshot(input: {
    documentId: string;
    seq: number;
    s3Key: string;
    sizeBytes: number;
  }): Promise<boolean>;
}

export interface AuditRepo {
  record(entry: {
    documentId: string;
    userId: string | null;
    action: string;
    target: string | null;
  }): Promise<void>;
}

/** One full-text hit in a document's projected cells (FIND-03). */
export interface SearchHit {
  readonly sheetId: string;
  readonly tableId: string;
  readonly rowId: string;
  readonly columnId: string;
  /** The cell's `text_plain`; the route trims it to a snippet. */
  readonly textPlain: string;
}

export interface ProjectionRepo {
  /**
   * Replace the document's whole projection (sheets, tables, columns, rows,
   * cells) in one transaction. The projection is rebuildable: deleting the
   * sheets cascades through the rest, then everything is inserted afresh.
   */
  replace(projection: Projection): Promise<void>;
  /**
   * Cells of one document matching every word of `query`
   * (`to_tsvector('simple', text_plain) @@ plainto_tsquery('simple', $q)`),
   * in sheet, table, row, column order, at most `limit`.
   */
  search(documentId: string, query: string, limit: number): Promise<SearchHit[]>;
  /** Ids of every live (not soft-deleted) document, for a full rebuild. */
  liveDocumentIds(): Promise<string[]>;
}

export interface Repo {
  /** `SELECT 1` — throws when the database is unreachable. */
  ping(): Promise<void>;
  readonly users: UsersRepo;
  readonly documents: DocumentsRepo;
  readonly updates: UpdatesRepo;
  readonly audit: AuditRepo;
  readonly projection: ProjectionRepo;
}
