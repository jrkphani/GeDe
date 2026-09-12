/**
 * The repository boundary. `buildServer` receives an implementation of `Repo`
 * — Postgres via Drizzle in production (`pg.ts`), an in-memory fake in tests
 * (`src/test/fake-repo.ts`). Keeping the surface small keeps the fake honest:
 * it implements exactly the queries the service issues, nothing more.
 */
import type { LinkAccess, Permission, ShareSource } from '@gede/db';

import type { Projection } from '../projection/project.js';

export interface UserRecord {
  readonly id: string;
  readonly cognitoSub: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** I18N-05: one of the supported BCP 47 tags, or null until chosen. */
  readonly locale: string | null;
  /** ONB-03: when the account completed or skipped the guided tour; null until then, and after Replay. */
  readonly tourDoneAt: Date | null;
  /** LIB-05 (#133): the Browse / Shared sort the account chose, or null until chosen. */
  readonly librarySort: LibrarySort | null;
  /**
   * ONB-01: the account's guided sample workscape, or null while none exists
   * yet (the resolver seeds it on first sight, `SampleSeeder`).
   */
  readonly sampleDocumentId: string | null;
  /**
   * Set by account erasure (#111, ADR-038). The row is a tombstone from then
   * on: the auth hook refuses it, nothing personal remains on it.
   */
  readonly deletedAt: Date | null;
}

/** LIB-05: the two library sorts; Recents ignores it. */
export type LibrarySort = 'name' | 'date';

export interface DocumentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly linkAccess: LinkAccess;
  /**
   * The secret that "anyone with the link" presents (SHARE-01). Minted
   * whenever link access goes from `none` to `view`/`edit` — a link the
   * owner switched off stays dead if they switch link access on again —
   * kept across a view/edit change, and only ever handed to people who may
   * share (the owner and editors).
   */
  readonly linkToken: string | null;
  readonly snapshotKey: string | null;
  readonly snapshotSeq: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  /** LIB-D6: archived by the owner, no expiry. Never set together with `deletedAt`. */
  readonly archivedAt: Date | null;
  /**
   * LIB-D2/D4 (ADR): true while the document has a participant, or its link is
   * on once it had one. Set inside the share transactions — an accepted
   * invitation, a redeemed link, a person with an account named in the sheet,
   * the link switched on — never by sending an invitation; cleared when the
   * last share goes and link access is `none`. Delete is refused while true.
   */
  readonly everShared: boolean;
  /** LIB-D10: the guided sample workscape; exempt from Delete and Archive. */
  readonly sample: boolean;
}

/** What a caller may do with a document. `owner` implies edit plus sharing and deletion. */
export type DocumentPermission = 'owner' | Permission;

/**
 * A person as the library shows them: the display name, and the address for
 * callers who may see it — the route applies the share-sheet rule (#102: the
 * owner and editors see addresses, a viewer sees names only).
 */
export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * A document as one caller sees it in the library (LIB-01, LIB-02): the row
 * plus who owns it, who shared it with the caller, whether it is shared at
 * all, and its size. Everything here comes from one query per list.
 */
export interface DocumentSummary extends DocumentRecord {
  /** The owner's display name; null until they set one. Never the address (#102). */
  readonly ownerName: string | null;
  /** The owner's address, for the route to show the owner and editors only (#102). */
  readonly ownerEmail: string | null;
  /** Latest snapshot `size_bytes` plus the bytes of every update logged since it. */
  readonly sizeBytes: number;
  /** Who shared it with the caller; null for the owner. */
  readonly sharedBy: PersonRef | null;
  /**
   * The one definition of "shared" (#139): a participant exists (a share row)
   * or the link is on — the live form of `everShared` (LIB-D1/D4), so the
   * title pill (SHARE-05), the library row (LIB-02), the Shared view (LIB-01)
   * and the delete/archive slot agree. A pending invitation is not a
   * participant and does not count.
   */
  readonly sharedWithOthers: boolean;
}

export interface DocumentListing extends DocumentSummary {
  readonly permission: DocumentPermission;
}

/**
 * Library views (LIB-01, LIB-D3, LIB-D6). `recents`, `browse` and `shared`
 * exclude deleted documents and, for the owner, archived ones — a participant
 * still sees an archived document they were given (LIB-D3); `deleted` is the
 * owner's Recently Deleted for the last 30 days; `archived` is the owner's
 * archived documents, without expiry.
 */
export type LibraryView = 'recents' | 'browse' | 'shared' | 'deleted' | 'archived';

export const RECENTLY_DELETED_DAYS = 30;

/** What `DocumentsRepo.tryDelete` did, or why it did nothing. */
export type DeleteOutcome =
  | {
      readonly status: 'deleted';
      readonly document: DocumentRecord;
      /** Pending invitations withdrawn with the delete (#112), by address. */
      readonly withdrawn: readonly string[];
    }
  | { readonly status: 'missing' | 'shared' | 'sample' };

export interface Participant {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly permission: Permission;
  readonly invitedBy: string;
  /** `link` when they arrived through "anyone with the link"; such shares go with the link. */
  readonly source: ShareSource;
}

/** An invitation not yet accepted and not yet expired (SHARE-02), as the share sheet lists it. */
export interface PendingInvite {
  readonly id: string;
  readonly email: string;
  readonly permission: Permission;
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
}

export interface ParticipantList {
  readonly owner: {
    readonly id: string;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly participants: readonly Participant[];
  readonly invites: readonly PendingInvite[];
  readonly linkAccess: LinkAccess;
  readonly linkToken: string | null;
}

/** How long an invitation stays valid (SHARE-02). */
export const INVITE_VALID_DAYS = 14;

export interface InviteRecord {
  readonly id: string;
  readonly documentId: string;
  readonly email: string;
  readonly permission: Permission;
  readonly token: string;
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

/** A share an invitation converted into (SHARE-02), for the caller's log line. */
export interface ConvertedInvite {
  readonly documentId: string;
  readonly permission: Permission;
}

export interface EmailBinding {
  readonly user: UserRecord;
  readonly converted: readonly ConvertedInvite[];
}

/** What a permanent delete removed, so the caller can clean S3 up afterwards. */
export interface PurgedDocument {
  readonly id: string;
  readonly title: string;
}

/**
 * What account erasure did (#111, ADR-038), so the route can close sockets,
 * free rooms and delete the Cognito identity afterwards.
 */
export interface ErasureOutcome {
  /** The Cognito `sub` the identity store deletes; kept on the tombstone row. */
  readonly cognitoSub: string;
  /** Owned documents handed to their earliest editor. */
  readonly transferred: readonly { documentId: string; toUserId: string }[];
  /** Owned documents soft-deleted (no editor to take them, or the sample). */
  readonly deleted: readonly string[];
  /** Documents the user held a share on; the share is gone. */
  readonly sharesRemoved: readonly string[];
  /** Pending invitations the user had sent, withdrawn. */
  readonly invitesWithdrawn: number;
}

export interface TokenIdentity {
  readonly sub: string;
  /** Email, when the token carried one. Access tokens usually do not. */
  readonly email: string | null;
  /** The token's `exp` as ms epoch, or null when the verifier does not report one (#104). */
  readonly expiresAt: number | null;
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
  /** ONB-03: `true` stamps `tour_done_at` now; `false` clears it (Replay, ONB-08). */
  readonly tourDone?: boolean;
  /** LIB-05 (#133): the library sort, per account. */
  readonly librarySort?: LibrarySort;
}

export interface UsersRepo {
  /**
   * Insert on first sight of a `sub`, otherwise refresh `last_seen_at` (and
   * fill a missing email). When the token carried an address, pending
   * invitations for it convert to shares in the same transaction (SHARE-02).
   */
  upsertFromToken(identity: Pick<TokenIdentity, 'sub' | 'email'>): Promise<UserRecord>;
  /** Set the fields present in `patch`; `undefined` when the user does not exist. */
  updateProfile(id: string, patch: ProfilePatch): Promise<UserRecord | undefined>;
  /**
   * Bind a verified address to a user whose row has none yet, and convert
   * every pending, unexpired invitation for that address into a share, all
   * in one transaction (SHARE-02: "converts to a share on first sign-in").
   * An invitation converts only while its inviter is the owner or still
   * holds at least the invited permission; otherwise it is withdrawn with a
   * `share.invite_withdraw` row (a removed editor's invitations must not
   * outlive them). A row that already carries the same address is a no-op
   * that still converts (a retry, or an invitation sent after the binding);
   * one that carries a different address is left as it is — the caller
   * compares `user.email` and answers. Throws `EmailTakenError` when another
   * account holds the address; `undefined` when the user does not exist.
   */
  bindEmail(id: string, email: string): Promise<EmailBinding | undefined>;
  /** The user registered under `email` (case-insensitive), if any. */
  findByEmail(email: string): Promise<UserRecord | undefined>;
  /**
   * Erase an account (#111, ADR-038, AUTH-09 partial), in one transaction:
   * every share the user holds goes (`share.remove`), every pending
   * invitation they sent is withdrawn (`share.invite_withdraw`), every
   * invitation row addressed to them is deleted, each owned live document is
   * handed to its earliest editor (`document.transfer`) or — with no editor,
   * or the guided sample — has its shares removed and is soft-deleted
   * (`document.delete`; the sample flag is cleared so the CHECK allows it),
   * `doc_updates.author_id` is nulled, their address is scrubbed from
   * `audit_log.target`, and the `users` row becomes a tombstone: email,
   * display name (`Deleted user`), locale, tour and last-seen cleared,
   * `deleted_at` set, `cognito_sub` kept so the identity cannot return.
   * Audit rows keep `user_id`. `undefined` when there is no such user;
   * `null` when the row was already a tombstone (idempotent).
   */
  erase(id: string): Promise<ErasureOutcome | null | undefined>;
}

/** `users.email` is unique; the address already belongs to another Cognito identity. */
export class EmailTakenError extends Error {
  constructor() {
    super('email already registered to another account');
    this.name = 'EmailTakenError';
  }
}

/**
 * Audit actions the sharing routes write (ARCHITECTURE §1.5 `audit_log`:
 * "share changes"). `share.link_revoke` (the link switched off or re-minted
 * took its shares with it) and `share.invite_withdraw` (an invitation whose
 * inviter no longer holds what it grants) are written by the system: their
 * `user_id` is the actor whose change caused them, or null at conversion.
 */
export type ShareAuditAction =
  | 'share.add'
  | 'share.permission'
  | 'share.remove'
  | 'share.stop'
  | 'share.link'
  | 'share.link_redeem'
  | 'share.link_revoke'
  | 'share.invite'
  | 'share.invite_remove'
  | 'share.invite_withdraw'
  | 'share.invite_accept';

/** Document-level audit actions the erasure writes (#111). */
export type ErasureAuditAction = 'document.transfer' | 'document.delete';

/** What `setLinkAccess` did, so the route can close the sockets of anyone whose link share went. */
export interface LinkChange {
  readonly document: DocumentRecord;
  /** Participants whose `link` share was revoked (link switched off or token re-minted). */
  readonly revoked: readonly string[];
}

/**
 * `documents.ever_shared` (LIB-D2, LIB-D4) is maintained here and in
 * `InvitesRepo`, inside the same transaction as the share change it follows:
 * every path that inserts a share (`add`, `redeemLink`, `accept`, the
 * conversion on sign-in) and switching the link on set it; `remove`, `stop`
 * and `setLinkAccess` clear it once no share remains and the link is off.
 * Sending an invitation never sets it. Nothing outside the repository writes it.
 */
export interface SharesRepo {
  /**
   * Give `userId` `permission` on the document, recording `invitedBy`; a
   * second call for the same person changes nothing and resolves `false`
   * (the caller answers 409). One `share.add` audit row by `actorId`.
   */
  add(input: {
    documentId: string;
    userId: string;
    permission: Permission;
    invitedBy: string;
    actorId: string;
  }): Promise<boolean>;
  /** Change a participant's permission; `false` when there is no such share. Audit `share.permission`. */
  setPermission(input: {
    documentId: string;
    userId: string;
    permission: Permission;
    actorId: string;
  }): Promise<boolean>;
  /** Remove a participant; `false` when there was no share. Audit `share.remove`. */
  remove(input: { documentId: string; userId: string; actorId: string }): Promise<boolean>;
  /**
   * Stop sharing (SHARE-01): every share and every pending invitation go,
   * link access returns to `none`, one `share.stop` audit row whose target
   * names who lost access (user ids and withdrawn addresses). Resolves the
   * ids of the participants removed so their sockets can be closed.
   */
  stop(input: { documentId: string; actorId: string }): Promise<string[]>;
  /**
   * Set the link mode. Any change to `view` or `edit` — from `none` or from
   * the other level — mints a fresh `link_token` (`mintToken` supplies it):
   * a link handed out at one level never becomes another. Switching off or
   * re-minting revokes every `link` share (their holders no longer have the
   * link that admitted them) with one `share.link_revoke` row naming them;
   * `invite` shares are untouched. Audit `share.link` with the mode.
   * `undefined` when the document does not exist.
   */
  setLinkAccess(input: {
    documentId: string;
    access: LinkAccess;
    actorId: string;
    mintToken: () => string;
  }): Promise<LinkChange | undefined>;
  /**
   * "Anyone with the link" (SHARE-01): when `token` is the document's live
   * link token and link access is on, give `userId` the link's permission
   * as a `link` share unless they already hold a share — an explicit share
   * is never lowered by a link — and resolve the permission they now hold.
   * `undefined` when the token does not match or link access is off. Audit
   * `share.link_redeem` only when a share was created.
   */
  redeemLink(input: {
    documentId: string;
    userId: string;
    token: string;
  }): Promise<Permission | undefined>;
}

export interface InvitesRepo {
  /**
   * Invite an address without an account (SHARE-02), idempotently: when a
   * pending, unexpired invitation for the same document and address exists
   * it is returned with `created: false` and nothing is written — a retried
   * or repeated POST never makes a second row or a second mail. Otherwise an
   * expired unaccepted row for the pair is dropped, the new one is inserted
   * with its token and expiry (`invites_pending_key` decides a race), and
   * one `share.invite` audit row (target = the address) is written — one
   * transaction.
   */
  create(input: {
    documentId: string;
    email: string;
    permission: Permission;
    token: string;
    expiresAt: Date;
    invitedBy: string;
  }): Promise<{ invite: InviteRecord; created: boolean }>;
  /** Withdraw a pending invitation; `false` when it does not exist on this document. Audit `share.invite_remove`. */
  remove(input: { documentId: string; inviteId: string; actorId: string }): Promise<boolean>;
  /**
   * A pending, unexpired invitation of this document by id (#121: Resend
   * builds the mail from its token); `undefined` when there is none.
   */
  pending(input: { documentId: string; inviteId: string }): Promise<InviteRecord | undefined>;
  /** The invitation carrying `token`, accepted or not, expired or not; the caller decides. */
  byToken(token: string): Promise<InviteRecord | undefined>;
  /**
   * Accept one invitation for `userId`, whose bound address must equal the
   * invitation's (checked in SQL, case-insensitively): insert the share with
   * the invitation's inviter, mark it accepted, audit `share.invite_accept`.
   * Resolves the permission granted, or `undefined` when the invitation is
   * gone, expired, already accepted, or for another address. An invitation
   * whose inviter no longer holds what it grants (removed, or demoted below
   * the invited permission) is withdrawn instead — `share.invite_withdraw`,
   * `undefined` — exactly as the conversion on sign-in treats it.
   */
  accept(input: { inviteId: string; userId: string }): Promise<Permission | undefined>;
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
  /**
   * The guided sample (ONB-01), like `create` but `sample = true` and at most
   * one per owner. The transaction takes a per-owner advisory lock, reads
   * the owner's sample, and only when there is none calls `writeSnapshot`
   * (the caller's S3 put of the seed object) before inserting the row, its
   * `snapshots` row and the audit row — so racing seeders across tasks
   * write exactly one object and the losers adopt the winner's row
   * (`created: false`). A `writeSnapshot` failure rolls the transaction
   * back and rethrows: no row ever points at a missing object. The partial
   * unique index `documents_owner_sample_key` (migration 0009) stays as the
   * invariant the lock protects.
   */
  createSample(input: {
    id: string;
    ownerId: string;
    title: string;
    snapshot: { seq: number; s3Key: string; sizeBytes: number };
    writeSnapshot: () => Promise<void>;
  }): Promise<{ document: DocumentRecord; created: boolean }>;
  rename(id: string, title: string): Promise<DocumentRecord | undefined>;
  /**
   * Move to Recently Deleted (LIB-D5): set `deleted_at` and clear
   * `archived_at` (a document is archived or deleted, never both).
   * `undefined` when the document does not exist, is already deleted, or is
   * the guided sample (#114: the CHECK forbids a sample in the trash, so this
   * refuses it before the database would). Used by tests; the owner's Delete
   * goes through `tryDelete`.
   */
  softDelete(id: string): Promise<DocumentRecord | undefined>;
  /**
   * The owner's Delete (LIB-D1, LIB-D2, LIB-D10): in one transaction, holding
   * the document row against a share being inserted, soft-delete it only
   * while `ever_shared` is false, the link is off and it is not the sample,
   * and withdraw every pending invitation with a `share.invite_withdraw` row
   * by `actorId` (#112: an invitation must not outlive the delete and convert
   * on a document in the trash). `shared` and `sample` name the refusal (the
   * route answers 409); `missing` covers a row that does not exist or is
   * deleted already.
   */
  tryDelete(id: string, actorId: string): Promise<DeleteOutcome>;
  /**
   * Clear `deleted_at`; `undefined` when the document is not soft-deleted or
   * its deletion is past the retention window (it is no longer in Recently
   * Deleted, so it cannot be recovered from there).
   */
  recover(id: string): Promise<DocumentRecord | undefined>;
  /**
   * Set `archived_at` (LIB-D3, LIB-D6): the document leaves the owner's
   * Recents, Browse and Shared views and nothing else changes — every share,
   * the link and the room stay. `undefined` when the document does not exist,
   * is deleted, or is archived already. The route refuses the sample.
   */
  archive(id: string): Promise<DocumentRecord | undefined>;
  /** Clear `archived_at`; `undefined` when the document is not archived. */
  unarchive(id: string): Promise<DocumentRecord | undefined>;
  /**
   * Recover every owned document deleted within the retention window and
   * write one `document.recover` audit row per document, in one transaction.
   */
  recoverAllDeleted(ownerId: string, actorId: string): Promise<DocumentRecord[]>;
  /**
   * Permanently delete up to `limit` owned soft-deleted documents (including
   * any past the retention window; never a sample, #114) with their updates,
   * snapshots, shares and invites, and write one `document.purge` audit row
   * per document, all in one transaction bounded by the batch (#109). S3
   * objects are the caller's job once this has committed. Call again while
   * a full batch came back.
   */
  purgeDeleted(ownerId: string, actorId: string, limit: number): Promise<PurgedDocument[]>;
  /**
   * The nightly job's first half of LIB-08 (#109): up to `limit` documents,
   * any owner, whose soft-deletion is older than the retention window and
   * which are not in `exclude`, oldest deletion first. A read, not a claim:
   * the job removes their objects outside any transaction, then calls
   * `purge` for the ones that went. A document past the window can no
   * longer be recovered (`recover` requires it within), so nothing read here
   * comes back to life in between.
   */
  expiredForPurge(input: { limit: number; exclude: readonly string[] }): Promise<PurgedDocument[]>;
  /**
   * The second half: delete the rows of the documents in `ids` that are
   * still soft-deleted past the window (and not a sample), cascading, with
   * one `document.purge` audit row each by the system actor (`user_id`
   * null), in one transaction. Resolves what was deleted; an id whose row
   * is already gone (a retried run) is simply not in the answer.
   */
  purge(ids: readonly string[]): Promise<PurgedDocument[]>;
  /** Explicit share permission for a user, if any. Ownership is checked separately. */
  sharePermission(documentId: string, userId: string): Promise<Permission | undefined>;
  /**
   * Owner, every share with the inviter, every pending unexpired invitation,
   * the link mode and the link token (LIB-07, SHARE-01). The route decides
   * who sees emails, invitations and the token.
   */
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
   *
   * `coversFrom` / `appended` say what the snapshot contains: everything up
   * to `coversFrom` (the state the writer loaded, or its last commit) plus
   * the `appended` updates it wrote since. When another task has committed a
   * snapshot past `coversFrom`, or the log holds a different number of rows
   * in `(coversFrom, seq]`, that task wrote to this document without the
   * writer seeing it (no cross-task fan-out yet): the commit is refused and
   * nothing is pruned — the snapshot would not contain those rows (#39
   * residual, review of #66). The writer's room then reloads from storage.
   */
  commitSnapshot(input: {
    documentId: string;
    seq: number;
    s3Key: string;
    sizeBytes: number;
    coversFrom: number;
    appended: number;
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
  readonly shares: SharesRepo;
  readonly invites: InvitesRepo;
  readonly updates: UpdatesRepo;
  readonly audit: AuditRepo;
  readonly projection: ProjectionRepo;
}
