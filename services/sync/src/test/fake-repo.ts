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
 *   - sizeBytes  = size of the snapshot at `snapshotSeq` + bytes of updates after it
 *   - recover    = single and all: only within the retention window; recover-all
 *                  writes its `document.recover` audit rows itself (one transaction)
 *   - purge      = every owned soft-deleted document (retention or not), cascade
 *                  to updates/snapshots/shares, one `document.purge` audit row each;
 *                  audit rows for the document are kept (no cascade, migration 0003)
 */
import { randomUUID } from 'node:crypto';

import type { Permission } from '@gede/db';

import {
  RECENTLY_DELETED_DAYS,
  type DocumentListing,
  type DocumentRecord,
  type DocumentSummary,
  type LibraryView,
  type Repo,
  type StoredUpdate,
  type UserRecord,
} from '../repo/types.js';

interface MutableDocument extends DocumentRecord {
  title: string;
  snapshotKey: string | null;
  snapshotSeq: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface MutableUser extends UserRecord {
  email: string | null;
  displayName: string | null;
  locale: string | null;
}

export interface FakeShare {
  permission: Permission;
  invitedBy: string;
  createdAt: Date;
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
  readonly updatesByDoc = new Map<string, StoredUpdate[]>();
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
    };
    this.usersBySub.set(sub, user);
    return user;
  }

  userById(id: string): MutableUser | undefined {
    for (const user of this.usersBySub.values()) if (user.id === id) return user;
    return undefined;
  }

  seedDocument(
    ownerId: string,
    title = 'Untitled',
    at = new Date(),
    id: string = randomUUID(),
  ): DocumentRecord {
    const doc: MutableDocument = {
      id,
      ownerId,
      title,
      linkAccess: 'none',
      snapshotKey: null,
      snapshotSeq: 0,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.docs.set(doc.id, doc);
    return { ...doc };
  }

  /** Add a share; `invitedBy` defaults to the document's owner, as the share sheet does. */
  share(documentId: string, userId: string, permission: Permission, invitedBy?: string): void {
    const map = this.sharesByDoc.get(documentId) ?? new Map<string, FakeShare>();
    const owner = this.docs.get(documentId)?.ownerId;
    map.set(userId, {
      permission,
      invitedBy: invitedBy ?? owner ?? userId,
      createdAt: new Date(),
    });
    this.sharesByDoc.set(documentId, map);
  }

  private sizeBytes(doc: MutableDocument): number {
    const snapshot = this.snapshotsByDoc.get(doc.id)?.find((s) => s.seq === doc.snapshotSeq);
    const tail = (this.updatesByDoc.get(doc.id) ?? [])
      .filter((u) => u.seq > doc.snapshotSeq)
      .reduce((n, u) => n + u.update.byteLength, 0);
    return (snapshot?.sizeBytes ?? 0) + tail;
  }

  private personName(userId: string): string | null {
    const user = this.userById(userId);
    return user?.displayName ?? user?.email ?? null;
  }

  private summarise(doc: MutableDocument, userId: string): DocumentSummary {
    const share = doc.ownerId === userId ? undefined : this.sharesByDoc.get(doc.id)?.get(userId);
    return {
      ...doc,
      ownerName: this.personName(doc.ownerId),
      sizeBytes: this.sizeBytes(doc),
      sharedBy: share ? { id: share.invitedBy, name: this.personName(share.invitedBy) } : null,
      sharedWithOthers: (this.sharesByDoc.get(doc.id)?.size ?? 0) > 0,
    };
  }

  private withinRetention(doc: MutableDocument, now: number): boolean {
    return doc.deletedAt !== null && now - doc.deletedAt.getTime() < RETENTION_MS;
  }

  // --- Repo -------------------------------------------------------------------

  readonly users: Repo['users'] = {
    upsertFromToken: (identity) => {
      const existing = this.usersBySub.get(identity.sub);
      if (existing) {
        existing.email = existing.email ?? identity.email;
        return Promise.resolve({ ...existing });
      }
      return Promise.resolve(this.seedUser(identity.sub, identity.email));
    },
    updateProfile: (id, patch) => {
      const user = this.userById(id);
      if (!user) return Promise.resolve(undefined);
      if (patch.displayName !== undefined) assertText(patch.displayName);
      if (patch.displayName !== undefined) user.displayName = patch.displayName;
      if (patch.locale !== undefined) user.locale = patch.locale;
      return Promise.resolve({ ...user });
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
        const include =
          view === 'recents'
            ? live
            : view === 'browse'
              ? live && owned
              : view === 'shared'
                ? live && (!owned || (this.sharesByDoc.get(doc.id)?.size ?? 0) > 0)
                : owned && this.withinRetention(doc, now);
        if (include) out.push({ ...this.summarise(doc, userId), permission });
      }
      out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1));
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
      if (doc?.deletedAt !== null) return Promise.resolve(undefined);
      doc.deletedAt = new Date();
      doc.updatedAt = doc.deletedAt;
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
    purgeDeleted: (ownerId, actorId) => {
      if (this.failNextPurge) {
        this.failNextPurge = false;
        return Promise.reject(new Error('simulated purge failure'));
      }
      const purged: { id: string; title: string }[] = [];
      for (const doc of [...this.docs.values()]) {
        if (doc.ownerId !== ownerId || doc.deletedAt === null) continue;
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
          };
        });
      return Promise.resolve({
        owner: {
          id: doc.ownerId,
          name: owner?.displayName ?? null,
          email: owner?.email ?? null,
        },
        participants,
        linkAccess: doc.linkAccess,
      });
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
      updates.forEach((u, i) => log.push({ seq: base + i + 1, update: u.update }));
      this.updatesByDoc.set(documentId, log);
      doc.updatedAt = new Date();
      return { firstSeq: base + 1, lastSeq: base + updates.length };
    },
    commitSnapshot: ({ documentId, seq, s3Key, sizeBytes }) => {
      const doc = this.docs.get(documentId);
      if (!doc) return Promise.reject(new Error(`document ${documentId} does not exist`));
      const list = this.snapshotsByDoc.get(documentId) ?? [];
      list.push({ seq, s3Key, sizeBytes });
      this.snapshotsByDoc.set(documentId, list);
      doc.snapshotKey = s3Key;
      doc.snapshotSeq = seq;
      this.updatesByDoc.set(
        documentId,
        (this.updatesByDoc.get(documentId) ?? []).filter((u) => u.seq > seq),
      );
      return Promise.resolve();
    },
  };

  readonly audit: Repo['audit'] = {
    record: (entry) => {
      this.auditLog.push(entry);
      return Promise.resolve();
    },
  };
}
