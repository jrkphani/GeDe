/**
 * The repository boundary. `buildServer` receives an implementation of `Repo`
 * — Postgres via Drizzle in production (`pg.ts`), an in-memory fake in tests
 * (`src/test/fake-repo.ts`). Keeping the surface small keeps the fake honest:
 * it implements exactly the queries the service issues, nothing more.
 */
import type { LinkAccess, Permission } from '@gede/db';

export interface UserRecord {
  readonly id: string;
  readonly cognitoSub: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface DocumentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly linkAccess: LinkAccess;
  readonly snapshotKey: string | null;
  readonly snapshotSeq: number;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/** What a caller may do with a document. `owner` implies edit plus sharing and deletion. */
export type DocumentPermission = 'owner' | Permission;

export interface DocumentListing extends DocumentRecord {
  readonly permission: DocumentPermission;
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

export interface UsersRepo {
  /** Insert on first sight of a `sub`, otherwise refresh `last_seen_at` (and fill a missing email). */
  upsertFromToken(identity: TokenIdentity): Promise<UserRecord>;
}

export interface DocumentsRepo {
  listForUser(userId: string, view: 'active' | 'deleted'): Promise<DocumentListing[]>;
  get(id: string): Promise<DocumentRecord | undefined>;
  create(input: { ownerId: string; title: string }): Promise<DocumentRecord>;
  rename(id: string, title: string): Promise<DocumentRecord | undefined>;
  softDelete(id: string): Promise<DocumentRecord | undefined>;
  /** Explicit share permission for a user, if any. Ownership is checked separately. */
  sharePermission(documentId: string, userId: string): Promise<Permission | undefined>;
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
   * Record a compaction atomically: insert the snapshot row, point the
   * document at it, and prune the log up to and including `seq`.
   */
  commitSnapshot(input: {
    documentId: string;
    seq: number;
    s3Key: string;
    sizeBytes: number;
  }): Promise<void>;
}

export interface AuditRepo {
  record(entry: {
    documentId: string;
    userId: string | null;
    action: string;
    target: string | null;
  }): Promise<void>;
}

export interface Repo {
  /** `SELECT 1` — throws when the database is unreachable. */
  ping(): Promise<void>;
  readonly users: UsersRepo;
  readonly documents: DocumentsRepo;
  readonly updates: UpdatesRepo;
  readonly audit: AuditRepo;
}
