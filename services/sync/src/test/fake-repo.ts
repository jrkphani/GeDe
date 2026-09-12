/**
 * FAKE — an in-memory `Repo` for tests. It implements exactly the queries the
 * service issues, with the same semantics the Postgres implementation has
 * (sequence assignment, soft-delete visibility, snapshot commit pruning,
 * library views, retention window, size accounting, purge cascade). It is not
 * a database and is never used outside tests.
 *
 * Keeping it honest: when `Repo` grows a method, add it here with the
 * semantics `pg.ts` gives it and a test that exercises both sides of the
 * behaviour. The library views (`listForUser`), `sizeBytes` and `purgeDeleted`
 * below mirror the SQL in `pg.ts` line for line:
 *   - `recents`  = live, owned or shared with me, newest `updatedAt` first
 *   - `browse`   = live, owned
 *   - `shared`   = live, shared with me, plus my own documents that have a share
 *   - `deleted`  = owned, `deletedAt` within `RECENTLY_DELETED_DAYS`
 *   - `archived` = owned, live, `archivedAt` set (LIB-D6); the three views above
 *                  hide the owner's archived documents and nothing else (LIB-D3)
 *   - everShared = set whenever a share is inserted or the link switched on;
 *                  cleared when the last share goes and the link is off (LIB-D4)
 *   - sizeBytes  = size of the snapshot at `snapshotSeq` + bytes of updates after it
 *   - recover    = single and all: only within the retention window; recover-all
 *                  writes its `document.recover` audit rows itself (one transaction)
 *   - purge      = every owned soft-deleted document (retention or not), cascade
 *                  to updates/snapshots/shares, one `document.purge` audit row each;
 *                  audit rows for the document are kept (no cascade, migration 0003)
 */
import { randomUUID } from 'node:crypto';

import type { LinkAccess, Permission, ShareSource } from '@gede/db';

import type { Projection } from '../projection/project.js';
import {
  EmailTakenError,
  RECENTLY_DELETED_DAYS,
  type ConvertedInvite,
  type DocumentListing,
  type DocumentRecord,
  type DocumentSummary,
  type InviteRecord,
  type LibrarySort,
  type LibraryView,
  type Repo,
  type StoredUpdate,
  type UserRecord,
} from '../repo/types.js';

interface MutableDocument extends DocumentRecord {
  title: string;
  linkAccess: LinkAccess;
  linkToken: string | null;
  snapshotKey: string | null;
  snapshotSeq: number;
  updatedAt: Date;
  deletedAt: Date | null;
  archivedAt: Date | null;
  everShared: boolean;
  sample: boolean;
}

interface MutableInvite extends InviteRecord {
  acceptedAt: Date | null;
}

interface MutableUser extends Omit<UserRecord, 'sampleDocumentId'> {
  email: string | null;
  displayName: string | null;
  locale: string | null;
  tourDoneAt: Date | null;
  librarySort: LibrarySort | null;
  deletedAt: Date | null;
}

/** What an erased account's row is called, as `pg.ts` writes it (#111). */
const ERASED_DISPLAY_NAME = 'Deleted user';

/** The whole-address match erasure scrubs with, as `addressPattern` in `pg.ts` builds it. */
function addressPattern(email: string): string {
  const literal = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|[^A-Za-z0-9._%+-])${literal}(?![A-Za-z0-9._%+-])`;
}

export interface FakeShare {
  permission: Permission;
  invitedBy: string;
  createdAt: Date;
  source: ShareSource;
}

export interface AuditEntry {
  documentId: string;
  userId: string | null;
  action: string;
  target: string | null;
}

const RETENTION_MS = RECENTLY_DELETED_DAYS * 24 * 60 * 60 * 1000;

/** Postgres `text` refuses NUL; the fake must fail the same way so a route cannot pass here and 500 in production. */
function assertText(value: string): void {
  if (value.includes('\u0000')) {
    throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
  }
}

export class FakeRepo implements Repo {
  readonly usersBySub = new Map<string, MutableUser>();
  readonly docs = new Map<string, MutableDocument>();
  readonly sharesByDoc = new Map<string, Map<string, FakeShare>>();
  readonly invitesById = new Map<string, MutableInvite>();
  /** The log, with the author each row was appended under (what `doc_updates.author_id` holds). */
  readonly updatesByDoc = new Map<string, (StoredUpdate & { authorId: string | null })[]>();
  readonly snapshotsByDoc = new Map<string, { seq: number; s3Key: string; sizeBytes: number }[]>();
  readonly auditLog: AuditEntry[] = [];
  /** Set to make `ping` fail. */
  down = false;
  /** Set to make `append` fail once (to exercise retry). */
  failNextAppend = false;
  appendCalls = 0;
  private appendGate: Promise<void> | null = null;

  /**
   * Hold the next `append` (after it has been counted in `appendCalls`) until
   * the returned function is called — a slow database, for tests that need
   * something to happen while a flush is in flight.
   */
  gateNextAppend(): () => void {
    let release: () => void = () => undefined;
    this.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  /** Set to make `purgeDeleted` fail before anything changes. */
  failNextPurge = false;
  /** Set to make the next `create` fail as a rolled-back transaction would (nothing written). */
  failNextCreate = false;

  ping(): Promise<void> {
    return this.down ? Promise.reject(new Error('connection refused')) : Promise.resolve();
  }

  // --- test helpers ---------------------------------------------------------

  seedUser(
    sub: string,
    email: string | null = null,
    displayName: string | null = null,
  ): UserRecord {
    const user: MutableUser = {
      id: randomUUID(),
      cognitoSub: sub,
      email,
      displayName,
      locale: null,
      tourDoneAt: null,
      librarySort: null,
      deletedAt: null,
    };
    this.usersBySub.set(sub, user);
    return this.userRecord(user);
  }

  userById(id: string): MutableUser | undefined {
    for (const user of this.usersBySub.values()) if (user.id === id) return user;
    return undefined;
  }

  /** The owner's guided sample, if seeded (ONB-01) — what pg.ts reads with its scalar subquery. */
  sampleOf(ownerId: string): string | null {
    for (const doc of this.docs.values()) if (doc.ownerId === ownerId && doc.sample) return doc.id;
    return null;
  }

  private userRecord(user: MutableUser): UserRecord {
    return { ...user, sampleDocumentId: this.sampleOf(user.id) };
  }

  seedDocument(
    ownerId: string,
    title = 'Untitled',
    at = new Date(),
    id: string = randomUUID(),
    flags: { sample?: boolean } = {},
  ): DocumentRecord {
    const doc: MutableDocument = {
      id,
      ownerId,
      title,
      linkAccess: 'none',
      linkToken: null,
      snapshotKey: null,
      snapshotSeq: 0,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      archivedAt: null,
      everShared: false,
      sample: flags.sample ?? false,
    };
    this.docs.set(doc.id, doc);
    return { ...doc };
  }

  /** As `markShared` in `pg.ts`: a share exists (or the link is on), so Delete is off (LIB-D2). */
  private markShared(documentId: string): void {
    const doc = this.docs.get(documentId);
    if (doc) doc.everShared = true;
  }

  /** As `clearSharedIfNone` in `pg.ts`: no share left and the link off restores deletability (LIB-D4). */
  private clearSharedIfNone(documentId: string): void {
    const doc = this.docs.get(documentId);
    if (doc?.linkAccess !== 'none') return;
    if ((this.sharesByDoc.get(documentId)?.size ?? 0) === 0) doc.everShared = false;
  }

  /** Pending (unaccepted, unexpired) invitations, oldest first, as `pg.ts` orders them. */
  private pendingInvites(filter: (invite: MutableInvite) => boolean): MutableInvite[] {
    const now = Date.now();
    return [...this.invitesById.values()]
      .filter((i) => i.acceptedAt === null && i.expiresAt.getTime() > now && filter(i))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  /** `invites` cascade from `documents`. */
  private dropInvites(documentId: string): void {
    for (const [id, invite] of this.invitesById) {
      if (invite.documentId === documentId) this.invitesById.delete(id);
    }
  }

  private sameEmail(a: string | null, b: string): boolean {
    return a !== null && a.toLowerCase() === b.toLowerCase();
  }

  /** As `inheritedSource` in `pg.ts` (#101): a link-sourced inviter hands out link shares. */
  private inheritedSource(documentId: string, inviterId: string): ShareSource {
    return this.sharesByDoc.get(documentId)?.get(inviterId)?.source === 'link' ? 'link' : 'invite';
  }

  /** SHARE-02 conversion, as `convertInvites` in `pg.ts`: pending invitations for the address on live documents become shares. */
  private convertInvites(userId: string, email: string): ConvertedInvite[] {
    const converted: ConvertedInvite[] = [];
    for (const invite of this.pendingInvites((i) => this.sameEmail(i.email, email))) {
      const doc = this.docs.get(invite.documentId);
      // #112: nothing converts on a document in the trash.
      if (doc?.deletedAt !== null) continue;
      if (!this.inviterStillMay(invite, doc)) {
        this.withdrawStale(invite, doc, null);
        continue;
      }
      if (doc.ownerId !== userId) {
        const map = this.sharesByDoc.get(doc.id) ?? new Map<string, FakeShare>();
        if (!map.has(userId)) {
          map.set(userId, {
            permission: invite.permission,
            invitedBy: invite.invitedBy ?? doc.ownerId,
            createdAt: new Date(),
            source: this.inheritedSource(doc.id, invite.invitedBy ?? doc.ownerId),
          });
          this.sharesByDoc.set(doc.id, map);
        }
        this.markShared(doc.id);
      }
      invite.acceptedAt = new Date();
      this.auditLog.push({
        documentId: doc.id,
        userId,
        action: 'share.invite_accept',
        target: invite.email,
      });
      converted.push({ documentId: doc.id, permission: invite.permission });
    }
    return converted;
  }

  /** Add a share; `invitedBy` defaults to the document's owner, as the share sheet does. */
  share(documentId: string, userId: string, permission: Permission, invitedBy?: string): void {
    const map = this.sharesByDoc.get(documentId) ?? new Map<string, FakeShare>();
    const owner = this.docs.get(documentId)?.ownerId;
    map.set(userId, {
      permission,
      invitedBy: invitedBy ?? owner ?? userId,
      createdAt: new Date(),
      source: 'invite',
    });
    this.sharesByDoc.set(documentId, map);
    this.markShared(documentId);
  }

  /** As `inviterStillMay` in `pg.ts`: the owner always; an editor while they hold ≥ the invited permission. */
  private inviterStillMay(invite: MutableInvite, doc: MutableDocument): boolean {
    const inviter = invite.invitedBy ?? doc.ownerId;
    if (inviter === doc.ownerId) return true;
    const held = this.sharesByDoc.get(doc.id)?.get(inviter)?.permission;
    if (held === undefined) return false;
    return invite.permission === 'view' || held === 'edit';
  }

  private withdrawStale(invite: MutableInvite, doc: MutableDocument, actorId: string | null): void {
    this.invitesById.delete(invite.id);
    this.auditLog.push({
      documentId: doc.id,
      userId: actorId,
      action: 'share.invite_withdraw',
      target: `${invite.email}:${invite.invitedBy ?? doc.ownerId}`,
    });
  }

  private sizeBytes(doc: MutableDocument): number {
    const snapshot = this.snapshotsByDoc.get(doc.id)?.find((s) => s.seq === doc.snapshotSeq);
    const tail = (this.updatesByDoc.get(doc.id) ?? [])
      .filter((u) => u.seq > doc.snapshotSeq)
      .reduce((n, u) => n + u.update.byteLength, 0);
    return (snapshot?.sizeBytes ?? 0) + tail;
  }

  /** As `sharedWithOthers` in `pg.ts` (#139): a share or the link on; a pending invitation is not a participant. */
  private sharedWithOthers(doc: MutableDocument): boolean {
    return (this.sharesByDoc.get(doc.id)?.size ?? 0) > 0 || doc.linkAccess !== 'none';
  }

  private summarise(doc: MutableDocument, userId: string): DocumentSummary {
    const share = doc.ownerId === userId ? undefined : this.sharesByDoc.get(doc.id)?.get(userId);
    const owner = this.userById(doc.ownerId);
    const inviter = share ? this.userById(share.invitedBy) : undefined;
    // Names and addresses apart (#102), as `summaryQuery` selects them.
    return {
      ...doc,
      ownerName: owner?.displayName ?? null,
      ownerEmail: owner?.email ?? null,
      sizeBytes: this.sizeBytes(doc),
      sharedBy: share
        ? {
            id: share.invitedBy,
            name: inviter?.displayName ?? null,
            email: inviter?.email ?? null,
          }
        : null,
      sharedWithOthers: this.sharedWithOthers(doc),
    };
  }

  private withinRetention(doc: MutableDocument, now: number): boolean {
    return doc.deletedAt !== null && now - doc.deletedAt.getTime() < RETENTION_MS;
  }

  // --- Repo -------------------------------------------------------------------

  readonly users: Repo['users'] = {
    upsertFromToken: (identity) => {
      // `users_email_key`: an address held by another sub is not bound (pg.ts logs and stores null).
      const taken = (email: string | null) =>
        email !== null &&
        [...this.usersBySub.values()].some(
          (u) => u.cognitoSub !== identity.sub && this.sameEmail(u.email, email),
        );
      const email = taken(identity.email) ? null : identity.email;
      let user = this.usersBySub.get(identity.sub);
      if (user?.deletedAt !== null && user !== undefined) {
        // A tombstone (#111) is left as it is; the resolver refuses it.
        return Promise.resolve(this.userRecord(user));
      }
      if (user) {
        user.email = user.email ?? email;
      } else {
        this.seedUser(identity.sub, email);
        user = this.usersBySub.get(identity.sub);
        if (!user) throw new Error('unreachable: user was just seeded');
      }
      if (user.email !== null && identity.email !== null) {
        this.convertInvites(user.id, user.email);
      }
      return Promise.resolve(this.userRecord(user));
    },
    bindEmail: (id, email) => {
      const user = this.userById(id);
      if (!user) return Promise.resolve(undefined);
      if (user.deletedAt !== null)
        return Promise.resolve({ user: this.userRecord(user), converted: [] });
      if (user.email === null) {
        for (const other of this.usersBySub.values()) {
          if (other.id !== id && this.sameEmail(other.email, email)) {
            return Promise.reject(new EmailTakenError());
          }
        }
        user.email = email;
      }
      if (!this.sameEmail(user.email, email)) {
        return Promise.resolve({ user: this.userRecord(user), converted: [] });
      }
      return Promise.resolve({
        user: this.userRecord(user),
        converted: this.convertInvites(id, email),
      });
    },
    findByEmail: (email) => {
      for (const user of this.usersBySub.values()) {
        if (this.sameEmail(user.email, email)) return Promise.resolve(this.userRecord(user));
      }
      return Promise.resolve(undefined);
    },
    updateProfile: (id, patch) => {
      const user = this.userById(id);
      if (!user) return Promise.resolve(undefined);
      if (patch.displayName !== undefined) assertText(patch.displayName);
      if (patch.displayName !== undefined) user.displayName = patch.displayName;
      if (patch.locale !== undefined) user.locale = patch.locale;
      if (patch.tourDone !== undefined) user.tourDoneAt = patch.tourDone ? new Date() : null;
      if (patch.librarySort !== undefined) user.librarySort = patch.librarySort;
      return Promise.resolve(this.userRecord(user));
    },
    erase: (id) => {
      // As `pg.ts` in one transaction (#111): shares held go, sent invitations
      // are withdrawn, invitations to the address are deleted, owned live
      // documents transfer to the earliest editor or are soft-deleted (shares
      // removed, sample flag cleared), authors and audit targets scrubbed,
      // the row becomes a tombstone that keeps its sub.
      const user = this.userById(id);
      if (!user) return Promise.resolve(undefined);
      if (user.deletedAt !== null) return Promise.resolve(null);
      const now = new Date();
      const sharesRemoved: string[] = [];
      for (const [documentId, map] of this.sharesByDoc) {
        if (!map.delete(id)) continue;
        this.clearSharedIfNone(documentId);
        this.auditLog.push({ documentId, userId: id, action: 'share.remove', target: id });
        sharesRemoved.push(documentId);
      }
      let invitesWithdrawn = 0;
      for (const invite of this.pendingInvites((i) => i.invitedBy === id)) {
        const doc = this.docs.get(invite.documentId);
        if (doc?.deletedAt !== null) continue;
        this.withdrawStale(invite, doc, id);
        invitesWithdrawn += 1;
      }
      if (user.email !== null) {
        for (const [inviteId, invite] of this.invitesById) {
          if (this.sameEmail(invite.email, user.email)) this.invitesById.delete(inviteId);
        }
      }
      const transferred: { documentId: string; toUserId: string }[] = [];
      const deleted: string[] = [];
      const owned = [...this.docs.values()]
        .filter((d) => d.ownerId === id && d.deletedAt === null)
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      for (const doc of owned) {
        const map = this.sharesByDoc.get(doc.id) ?? new Map<string, FakeShare>();
        const editor = doc.sample
          ? undefined
          : [...map]
              .filter(([, share]) => share.permission === 'edit')
              .sort(
                ([idA, a], [idB, b]) =>
                  a.createdAt.getTime() - b.createdAt.getTime() ||
                  (idA < idB ? -1 : idA > idB ? 1 : 0),
              )[0]?.[0];
        if (editor !== undefined) {
          map.delete(editor);
          for (const share of map.values()) if (share.invitedBy === id) share.invitedBy = editor;
          for (const invite of this.invitesById.values()) {
            if (invite.documentId === doc.id && invite.invitedBy === id) {
              (invite as { invitedBy: string | null }).invitedBy = editor;
            }
          }
          (doc as { ownerId: string }).ownerId = editor;
          doc.updatedAt = now;
          this.clearSharedIfNone(doc.id);
          this.auditLog.push({
            documentId: doc.id,
            userId: id,
            action: 'document.transfer',
            target: editor,
          });
          transferred.push({ documentId: doc.id, toUserId: editor });
          continue;
        }
        const gone = [...map.keys()];
        const withdrawn: string[] = [];
        for (const [inviteId, invite] of this.invitesById) {
          if (invite.documentId === doc.id && invite.acceptedAt === null) {
            this.invitesById.delete(inviteId);
            withdrawn.push(invite.email);
          }
        }
        this.sharesByDoc.delete(doc.id);
        if (gone.length > 0 || withdrawn.length > 0) {
          this.auditLog.push({
            documentId: doc.id,
            userId: id,
            action: 'share.stop',
            target: JSON.stringify({ users: gone, invites: withdrawn }),
          });
        }
        doc.sample = false;
        doc.linkAccess = 'none';
        doc.linkToken = null;
        doc.everShared = false;
        doc.archivedAt = null;
        doc.deletedAt = now;
        doc.updatedAt = now;
        this.auditLog.push({
          documentId: doc.id,
          userId: id,
          action: 'document.delete',
          target: null,
        });
        deleted.push(doc.id);
      }
      for (const log of this.updatesByDoc.values()) {
        for (const entry of log) if (entry.authorId === id) entry.authorId = null;
      }
      if (user.email !== null) {
        // Mirrors `addressPattern` in pg.ts: the whole address, never a substring.
        const pattern = new RegExp(addressPattern(user.email), 'gi');
        for (const entry of this.auditLog) {
          if (entry.target !== null) entry.target = entry.target.replace(pattern, '$1[erased]');
        }
      }
      const cognitoSub = user.cognitoSub;
      user.email = null;
      user.displayName = ERASED_DISPLAY_NAME;
      user.locale = null;
      user.tourDoneAt = null;
      user.librarySort = null;
      user.deletedAt = now;
      return Promise.resolve({
        cognitoSub,
        transferred,
        deleted,
        sharesRemoved,
        invitesWithdrawn,
      });
    },
  };

  readonly documents: Repo['documents'] = {
    listForUser: (userId, view: LibraryView) => {
      const now = Date.now();
      const out: DocumentListing[] = [];
      for (const doc of this.docs.values()) {
        const share = this.sharesByDoc.get(doc.id)?.get(userId);
        const owned = doc.ownerId === userId;
        const permission = owned ? 'owner' : share?.permission;
        if (permission === undefined) continue;
        const live = doc.deletedAt === null;
        // LIB-D3: the owner's archived documents leave the owner's views only.
        const shown = !owned || doc.archivedAt === null;
        const include =
          view === 'recents'
            ? live && shown
            : view === 'browse'
              ? live && owned && shown
              : view === 'shared'
                ? live && shown && (!owned || this.sharedWithOthers(doc))
                : view === 'archived'
                  ? live && owned && doc.archivedAt !== null
                  : owned && this.withinRetention(doc, now);
        if (include) out.push({ ...this.summarise(doc, userId), permission });
      }
      // ONB-01: the caller's own guided sample is pinned first, as pg.ts orders it.
      const own = (d: DocumentListing): number => Number(d.sample && d.ownerId === userId);
      out.sort(
        (a, b) =>
          own(b) - own(a) ||
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          (a.id < b.id ? 1 : -1),
      );
      return Promise.resolve(out);
    },
    get: (id) => {
      const doc = this.docs.get(id);
      return Promise.resolve(doc ? { ...doc } : undefined);
    },
    summarise: (id, userId) => {
      const doc = this.docs.get(id);
      return Promise.resolve(doc ? this.summarise(doc, userId) : undefined);
    },
    create: ({ id, ownerId, title, snapshot }) => {
      assertText(title);
      if (this.failNextCreate) {
        this.failNextCreate = false;
        return Promise.reject(new Error('simulated insert failure'));
      }
      if (this.docs.has(id))
        return Promise.reject(new Error('duplicate key value (documents_pkey)'));
      const doc = this.seedDocument(ownerId, title, new Date(), id);
      // Same transaction as pg.ts: the row points at its seed snapshot and the create is audited.
      const stored = this.docs.get(doc.id);
      if (stored) {
        stored.snapshotKey = snapshot.s3Key;
        stored.snapshotSeq = snapshot.seq;
      }
      this.snapshotsByDoc.set(doc.id, [
        { seq: snapshot.seq, s3Key: snapshot.s3Key, sizeBytes: snapshot.sizeBytes },
      ]);
      this.auditLog.push({
        documentId: doc.id,
        userId: ownerId,
        action: 'document.create',
        target: null,
      });
      return Promise.resolve({ ...doc, snapshotKey: snapshot.s3Key, snapshotSeq: snapshot.seq });
    },
    createSample: async ({ id, ownerId, title, snapshot, writeSnapshot }) => {
      // As pg.ts under its per-owner lock: an existing sample is adopted and the
      // object is not written; otherwise the object goes first (a failure leaves no row).
      const existing = this.sampleOf(ownerId);
      if (existing !== null) {
        const doc = this.docs.get(existing);
        if (!doc) throw new Error('unreachable: sample id without a row');
        return { document: { ...doc }, created: false };
      }
      if (this.docs.has(id)) throw new Error('duplicate key value (documents_pkey)');
      await writeSnapshot();
      const doc = this.seedDocument(ownerId, title, new Date(), id, { sample: true });
      const stored = this.docs.get(doc.id);
      if (stored) {
        stored.snapshotKey = snapshot.s3Key;
        stored.snapshotSeq = snapshot.seq;
      }
      this.snapshotsByDoc.set(doc.id, [
        { seq: snapshot.seq, s3Key: snapshot.s3Key, sizeBytes: snapshot.sizeBytes },
      ]);
      this.auditLog.push({
        documentId: doc.id,
        userId: ownerId,
        action: 'document.create',
        target: 'sample',
      });
      return {
        document: { ...doc, snapshotKey: snapshot.s3Key, snapshotSeq: snapshot.seq },
        created: true,
      };
    },
    rename: (id, title) => {
      assertText(title);
      const doc = this.docs.get(id);
      if (doc?.deletedAt !== null) return Promise.resolve(undefined);
      doc.title = title;
      doc.updatedAt = new Date(doc.updatedAt.getTime() + 1);
      return Promise.resolve({ ...doc });
    },
    softDelete: (id) => {
      const doc = this.docs.get(id);
      // #114: never a sample (the CHECK forbids it).
      if (doc?.deletedAt !== null || doc.sample) return Promise.resolve(undefined);
      doc.deletedAt = new Date();
      doc.archivedAt = null;
      doc.updatedAt = doc.deletedAt;
      return Promise.resolve({ ...doc });
    },
    tryDelete: async (id, actorId) => {
      // As `pg.ts`: the guard and the delete are one step (the fake has no
      // concurrency to serialise); `sample` wins over `shared`.
      const doc = this.docs.get(id);
      if (doc?.deletedAt !== null) return { status: 'missing' };
      if (doc.sample) return { status: 'sample' };
      if (doc.everShared || doc.linkAccess !== 'none') return { status: 'shared' };
      const deleted = await this.documents.softDelete(id);
      if (!deleted) return { status: 'missing' };
      // #112: pending invitations go with the delete, each audited.
      const withdrawn: string[] = [];
      for (const [inviteId, invite] of this.invitesById) {
        if (invite.documentId === id && invite.acceptedAt === null) {
          this.invitesById.delete(inviteId);
          withdrawn.push(invite.email);
          this.auditLog.push({
            documentId: id,
            userId: actorId,
            action: 'share.invite_withdraw',
            target: `${invite.email}:${invite.invitedBy ?? doc.ownerId}`,
          });
        }
      }
      return { status: 'deleted', document: deleted, withdrawn };
    },
    archive: (id) => {
      const doc = this.docs.get(id);
      if (doc?.deletedAt !== null || doc.archivedAt !== null) {
        return Promise.resolve(undefined);
      }
      doc.archivedAt = new Date();
      return Promise.resolve({ ...doc });
    },
    unarchive: (id) => {
      const doc = this.docs.get(id);
      if (doc?.archivedAt === null || doc === undefined) return Promise.resolve(undefined);
      doc.archivedAt = null;
      return Promise.resolve({ ...doc });
    },
    recover: (id) => {
      const doc = this.docs.get(id);
      if (!doc || !this.withinRetention(doc, Date.now())) return Promise.resolve(undefined);
      doc.deletedAt = null;
      doc.updatedAt = new Date();
      return Promise.resolve({ ...doc });
    },
    recoverAllDeleted: (ownerId, actorId) => {
      const now = Date.now();
      const recovered: DocumentRecord[] = [];
      for (const doc of this.docs.values()) {
        if (doc.ownerId !== ownerId || !this.withinRetention(doc, now)) continue;
        doc.deletedAt = null;
        doc.updatedAt = new Date(now);
        recovered.push({ ...doc });
        this.auditLog.push({
          documentId: doc.id,
          userId: actorId,
          action: 'document.recover',
          target: null,
        });
      }
      return Promise.resolve(recovered);
    },
    purgeDeleted: (ownerId, actorId, limit) => {
      if (this.failNextPurge) {
        this.failNextPurge = false;
        return Promise.reject(new Error('simulated purge failure'));
      }
      const purged: { id: string; title: string }[] = [];
      const doomed = [...this.docs.values()]
        .filter((doc) => doc.ownerId === ownerId && doc.deletedAt !== null && !doc.sample)
        .sort(
          (a, b) =>
            (a.deletedAt?.getTime() ?? 0) - (b.deletedAt?.getTime() ?? 0) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, limit);
      for (const doc of doomed) {
        this.auditLog.push({
          documentId: doc.id,
          userId: actorId,
          action: 'document.purge',
          target: doc.title,
        });
        this.docs.delete(doc.id);
        this.updatesByDoc.delete(doc.id);
        this.snapshotsByDoc.delete(doc.id);
        this.sharesByDoc.delete(doc.id);
        this.dropInvites(doc.id);
        purged.push({ id: doc.id, title: doc.title });
      }
      return Promise.resolve(purged);
    },
    expiredForPurge: ({ limit, exclude }) => {
      if (this.failNextPurge) {
        this.failNextPurge = false;
        return Promise.reject(new Error('simulated purge failure'));
      }
      const now = Date.now();
      // Oldest deletion first, then id, as the SQL orders; at most `limit` per call; never a sample.
      return Promise.resolve(
        [...this.docs.values()]
          .filter(
            (doc) =>
              doc.deletedAt !== null &&
              !this.withinRetention(doc, now) &&
              !doc.sample &&
              !exclude.includes(doc.id),
          )
          .sort(
            (a, b) =>
              (a.deletedAt?.getTime() ?? 0) - (b.deletedAt?.getTime() ?? 0) ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .slice(0, limit)
          .map((doc) => ({ id: doc.id, title: doc.title })),
      );
    },
    purge: (ids) => {
      if (this.failNextPurge) {
        this.failNextPurge = false;
        return Promise.reject(new Error('simulated purge failure'));
      }
      const now = Date.now();
      const purged: { id: string; title: string }[] = [];
      for (const id of ids) {
        const doc = this.docs.get(id);
        // Re-checked as the SQL does: still expired, still not a sample.
        if (doc === undefined) continue;
        if (doc.deletedAt === null || this.withinRetention(doc, now) || doc.sample) continue;
        this.auditLog.push({
          documentId: doc.id,
          userId: null,
          action: 'document.purge',
          target: doc.title,
        });
        this.docs.delete(doc.id);
        this.updatesByDoc.delete(doc.id);
        this.snapshotsByDoc.delete(doc.id);
        this.sharesByDoc.delete(doc.id);
        this.dropInvites(doc.id);
        purged.push({ id: doc.id, title: doc.title });
      }
      return Promise.resolve(purged);
    },
    sharePermission: (documentId, userId) =>
      Promise.resolve(this.sharesByDoc.get(documentId)?.get(userId)?.permission),
    participants: (documentId) => {
      const doc = this.docs.get(documentId);
      if (!doc) return Promise.resolve(undefined);
      const owner = this.userById(doc.ownerId);
      const participants = [...(this.sharesByDoc.get(documentId) ?? [])]
        .sort(
          ([idA, a], [idB, b]) =>
            a.createdAt.getTime() - b.createdAt.getTime() || (idA < idB ? -1 : idA > idB ? 1 : 0),
        )
        .map(([userId, share]) => {
          const user = this.userById(userId);
          return {
            userId,
            name: user?.displayName ?? null,
            email: user?.email ?? null,
            permission: share.permission,
            invitedBy: share.invitedBy,
            source: share.source,
          };
        });
      const pending = this.pendingInvites((i) => i.documentId === documentId).map((i) => ({
        id: i.id,
        email: i.email,
        permission: i.permission,
        invitedBy: i.invitedBy,
        expiresAt: i.expiresAt,
      }));
      return Promise.resolve({
        owner: {
          id: doc.ownerId,
          name: owner?.displayName ?? null,
          email: owner?.email ?? null,
        },
        participants,
        invites: pending,
        linkAccess: doc.linkAccess,
        linkToken: doc.linkToken,
      });
    },
  };

  readonly shares: Repo['shares'] = {
    add: ({ documentId, userId, permission, invitedBy, actorId }) => {
      const map = this.sharesByDoc.get(documentId) ?? new Map<string, FakeShare>();
      if (map.has(userId)) return Promise.resolve(false);
      map.set(userId, {
        permission,
        invitedBy,
        createdAt: new Date(),
        source: this.inheritedSource(documentId, invitedBy),
      });
      this.sharesByDoc.set(documentId, map);
      this.markShared(documentId);
      this.auditLog.push({ documentId, userId: actorId, action: 'share.add', target: userId });
      return Promise.resolve(true);
    },
    setPermission: ({ documentId, userId, permission, actorId }) => {
      const share = this.sharesByDoc.get(documentId)?.get(userId);
      if (!share) return Promise.resolve(false);
      share.permission = permission;
      this.auditLog.push({
        documentId,
        userId: actorId,
        action: 'share.permission',
        target: `${userId}:${permission}`,
      });
      return Promise.resolve(true);
    },
    remove: ({ documentId, userId, actorId }) => {
      const removed = this.sharesByDoc.get(documentId)?.delete(userId) ?? false;
      if (!removed) return Promise.resolve(false);
      this.clearSharedIfNone(documentId);
      this.auditLog.push({ documentId, userId: actorId, action: 'share.remove', target: userId });
      return Promise.resolve(true);
    },
    stop: ({ documentId, actorId }) => {
      const gone = [...(this.sharesByDoc.get(documentId)?.keys() ?? [])];
      this.sharesByDoc.delete(documentId);
      const withdrawn: string[] = [];
      for (const [id, invite] of this.invitesById) {
        if (invite.documentId === documentId && invite.acceptedAt === null) {
          this.invitesById.delete(id);
          withdrawn.push(invite.email);
        }
      }
      const doc = this.docs.get(documentId);
      if (doc) {
        doc.linkAccess = 'none';
        doc.everShared = false;
      }
      this.auditLog.push({
        documentId,
        userId: actorId,
        action: 'share.stop',
        target: JSON.stringify({ users: gone, invites: withdrawn }),
      });
      return Promise.resolve(gone);
    },
    setLinkAccess: ({ documentId, access, actorId, mintToken }) => {
      const doc = this.docs.get(documentId);
      if (doc?.deletedAt !== null) return Promise.resolve(undefined);
      const remint = access !== 'none' && access !== doc.linkAccess;
      const turningOff = access === 'none' && doc.linkAccess !== 'none';
      if (remint) doc.linkToken = mintToken();
      doc.linkAccess = access;
      if (access !== 'none') doc.everShared = true;
      this.auditLog.push({ documentId, userId: actorId, action: 'share.link', target: access });
      const revoked: string[] = [];
      if (remint || turningOff) {
        const map = this.sharesByDoc.get(documentId);
        for (const [userId, share] of map ?? []) {
          if (share.source === 'link') {
            map?.delete(userId);
            revoked.push(userId);
          }
        }
        if (revoked.length > 0) {
          this.auditLog.push({
            documentId,
            userId: actorId,
            action: 'share.link_revoke',
            target: revoked.join(','),
          });
        }
      }
      if (turningOff) this.clearSharedIfNone(documentId);
      return Promise.resolve({ document: { ...doc }, revoked });
    },
    redeemLink: ({ documentId, userId, token }) => {
      const doc = this.docs.get(documentId);
      if (doc?.deletedAt !== null || doc.linkAccess === 'none' || doc.linkToken !== token) {
        return Promise.resolve(undefined);
      }
      const granted = doc.linkAccess;
      if (doc.ownerId === userId) return Promise.resolve(granted);
      const map = this.sharesByDoc.get(documentId) ?? new Map<string, FakeShare>();
      const existing = map.get(userId);
      if (existing) return Promise.resolve(existing.permission);
      map.set(userId, {
        permission: granted,
        invitedBy: doc.ownerId,
        createdAt: new Date(),
        source: 'link',
      });
      this.sharesByDoc.set(documentId, map);
      this.markShared(documentId);
      this.auditLog.push({ documentId, userId, action: 'share.link_redeem', target: granted });
      return Promise.resolve(granted);
    },
  };

  readonly invites: Repo['invites'] = {
    create: ({ documentId, email, permission, token, expiresAt, invitedBy }) => {
      assertText(email);
      const standing = this.pendingInvites(
        (i) => i.documentId === documentId && this.sameEmail(i.email, email),
      )[0];
      if (standing) return Promise.resolve({ invite: { ...standing }, created: false });
      // An expired unaccepted row for the pair goes (invites_pending_key).
      for (const [id, i] of this.invitesById) {
        if (
          i.documentId === documentId &&
          this.sameEmail(i.email, email) &&
          i.acceptedAt === null
        ) {
          this.invitesById.delete(id);
        }
      }
      const invite: MutableInvite = {
        id: randomUUID(),
        documentId,
        email,
        permission,
        token,
        invitedBy,
        expiresAt,
        acceptedAt: null,
        createdAt: new Date(),
      };
      this.invitesById.set(invite.id, invite);
      this.auditLog.push({ documentId, userId: invitedBy, action: 'share.invite', target: email });
      return Promise.resolve({ invite: { ...invite }, created: true });
    },
    remove: ({ documentId, inviteId, actorId }) => {
      const invite = this.pendingInvites(
        (i) => i.id === inviteId && i.documentId === documentId,
      )[0];
      if (!invite) return Promise.resolve(false);
      this.invitesById.delete(invite.id);
      this.auditLog.push({
        documentId,
        userId: actorId,
        action: 'share.invite_remove',
        target: invite.email,
      });
      return Promise.resolve(true);
    },
    byToken: (token) => {
      for (const invite of this.invitesById.values()) {
        if (invite.token === token) return Promise.resolve({ ...invite });
      }
      return Promise.resolve(undefined);
    },
    pending: ({ documentId, inviteId }) => {
      const invite = this.pendingInvites(
        (i) => i.id === inviteId && i.documentId === documentId,
      )[0];
      return Promise.resolve(invite ? { ...invite } : undefined);
    },
    accept: ({ inviteId, userId }) => {
      const invite = this.pendingInvites((i) => i.id === inviteId)[0];
      const user = this.userById(userId);
      if (!invite || !user || !this.sameEmail(user.email, invite.email)) {
        return Promise.resolve(undefined);
      }
      const doc = this.docs.get(invite.documentId);
      if (doc?.deletedAt !== null) return Promise.resolve(undefined);
      if (!this.inviterStillMay(invite, doc)) {
        this.withdrawStale(invite, doc, userId);
        return Promise.resolve(undefined);
      }
      if (doc.ownerId !== userId) {
        const map = this.sharesByDoc.get(doc.id) ?? new Map<string, FakeShare>();
        if (!map.has(userId)) {
          map.set(userId, {
            permission: invite.permission,
            invitedBy: invite.invitedBy ?? doc.ownerId,
            createdAt: new Date(),
            source: this.inheritedSource(doc.id, invite.invitedBy ?? doc.ownerId),
          });
          this.sharesByDoc.set(doc.id, map);
        }
        this.markShared(doc.id);
      }
      invite.acceptedAt = new Date();
      this.auditLog.push({
        documentId: doc.id,
        userId,
        action: 'share.invite_accept',
        target: invite.email,
      });
      return Promise.resolve(invite.permission);
    },
  };

  readonly updates: Repo['updates'] = {
    loadState: (documentId) => {
      const doc = this.docs.get(documentId);
      if (!doc) return Promise.reject(new Error(`document ${documentId} does not exist`));
      const updates = (this.updatesByDoc.get(documentId) ?? []).filter(
        (u) => u.seq > doc.snapshotSeq,
      );
      return Promise.resolve({
        snapshotKey: doc.snapshotKey,
        snapshotSeq: doc.snapshotSeq,
        updates,
      });
    },
    append: async (documentId, updates) => {
      this.appendCalls += 1;
      if (this.failNextAppend) {
        this.failNextAppend = false;
        throw new Error('simulated append failure');
      }
      if (this.appendGate) {
        const gate = this.appendGate;
        this.appendGate = null;
        await gate;
      }
      const doc = this.docs.get(documentId);
      if (!doc) throw new Error(`document ${documentId} does not exist`);
      const log = this.updatesByDoc.get(documentId) ?? [];
      const base = Math.max(doc.snapshotSeq, log.at(-1)?.seq ?? 0);
      updates.forEach((u, i) =>
        log.push({ seq: base + i + 1, update: u.update, authorId: u.authorId }),
      );
      this.updatesByDoc.set(documentId, log);
      doc.updatedAt = new Date();
      return { firstSeq: base + 1, lastSeq: base + updates.length };
    },
    commitSnapshot: ({ documentId, seq, s3Key, sizeBytes, coversFrom, appended }) => {
      const doc = this.docs.get(documentId);
      if (!doc) return Promise.reject(new Error(`document ${documentId} does not exist`));
      // Monotonic, as pg.ts under the row lock (#39): a stale commit changes nothing.
      if (seq <= doc.snapshotSeq) return Promise.resolve(false);
      // …and the snapshot must contain everything it would supersede (#39 residual).
      if (doc.snapshotSeq > coversFrom) return Promise.resolve(false);
      const loggedRows = (this.updatesByDoc.get(documentId) ?? []).filter(
        (u) => u.seq > coversFrom && u.seq <= seq,
      ).length;
      if (loggedRows !== appended) return Promise.resolve(false);
      const list = this.snapshotsByDoc.get(documentId) ?? [];
      list.push({ seq, s3Key, sizeBytes });
      this.snapshotsByDoc.set(documentId, list);
      doc.snapshotKey = s3Key;
      doc.snapshotSeq = seq;
      this.updatesByDoc.set(
        documentId,
        (this.updatesByDoc.get(documentId) ?? []).filter((u) => u.seq > seq),
      );
      return Promise.resolve(true);
    },
  };

  readonly audit: Repo['audit'] = {
    record: (entry) => {
      this.auditLog.push(entry);
      return Promise.resolve();
    },
  };

  /** The last projection written per document — what the tables would hold. */
  readonly projections = new Map<string, Projection>();
  /** Set to make the next `replace` fail (a rolled-back transaction leaves the previous projection). */
  failNextProjection = false;
  projectionWrites = 0;

  readonly projection: Repo['projection'] = {
    replace: (projection) => {
      this.projectionWrites += 1;
      if (this.failNextProjection) {
        this.failNextProjection = false;
        return Promise.reject(new Error('simulated projection failure'));
      }
      this.projections.set(projection.documentId, projection);
      return Promise.resolve();
    },
    search: (documentId, query, limit) => {
      const projection = this.projections.get(documentId);
      if (!projection) return Promise.resolve([]);
      // Approximates `to_tsvector('simple', text_plain) @@ plainto_tsquery('simple', q)`:
      // the simple dictionary lowercases and splits on non-word characters, and
      // plainto_tsquery ANDs every word (no prefix matching, no stemming).
      const wanted = tokens(query);
      if (wanted.length === 0) return Promise.resolve([]);
      const sheetOrdinal = new Map(projection.sheets.map((s) => [s.id, s.ordinal]));
      const tableOf = new Map(projection.rows.map((r) => [r.id, r.tableId]));
      const rowOrdinal = new Map(projection.rows.map((r) => [r.id, r.ordinal]));
      const columnOrdinal = new Map(projection.columns.map((c) => [c.id, c.ordinal]));
      const sheetOf = new Map(projection.tables.map((t) => [t.id, t.sheetId]));
      const hits = projection.cells
        .filter((cell) => {
          const have = new Set(tokens(cell.textPlain));
          return wanted.every((w) => have.has(w));
        })
        .map((cell) => {
          const tableId = tableOf.get(cell.rowId) ?? '';
          return {
            sheetId: sheetOf.get(tableId) ?? '',
            tableId,
            rowId: cell.rowId,
            columnId: cell.columnId,
            textPlain: cell.textPlain,
          };
        })
        .sort(
          (a, b) =>
            (sheetOrdinal.get(a.sheetId) ?? 0) - (sheetOrdinal.get(b.sheetId) ?? 0) ||
            (a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0) ||
            (rowOrdinal.get(a.rowId) ?? 0) - (rowOrdinal.get(b.rowId) ?? 0) ||
            (columnOrdinal.get(a.columnId) ?? 0) - (columnOrdinal.get(b.columnId) ?? 0),
        );
      return Promise.resolve(hits.slice(0, limit));
    },
    liveDocumentIds: () =>
      Promise.resolve(
        [...this.docs.values()]
          .filter((d) => d.deletedAt === null)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .map((d) => d.id),
      ),
  };
}

/** The `simple` text-search parser, near enough: lowercase words of letters and digits. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== '');
}
