/**
 * FAKE — an in-memory `Repo` for tests. It implements exactly the queries the
 * service issues, with the same semantics the Postgres implementation has
 * (sequence assignment, soft-delete visibility, snapshot commit pruning). It
 * is not a database and is never used outside tests.
 */
import { randomUUID } from 'node:crypto';

import type { Permission } from '@gede/db';

import type {
  DocumentListing,
  DocumentRecord,
  Repo,
  StoredUpdate,
  UserRecord,
} from '../repo/types.js';

interface MutableDocument extends DocumentRecord {
  title: string;
  snapshotKey: string | null;
  snapshotSeq: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AuditEntry {
  documentId: string;
  userId: string | null;
  action: string;
  target: string | null;
}

export class FakeRepo implements Repo {
  readonly usersBySub = new Map<string, UserRecord>();
  readonly docs = new Map<string, MutableDocument>();
  readonly sharesByDoc = new Map<string, Map<string, Permission>>();
  readonly updatesByDoc = new Map<string, StoredUpdate[]>();
  readonly snapshotsByDoc = new Map<string, { seq: number; s3Key: string; sizeBytes: number }[]>();
  readonly auditLog: AuditEntry[] = [];
  /** Set to make `ping` fail. */
  down = false;
  /** Set to make `append` fail once (to exercise retry). */
  failNextAppend = false;
  appendCalls = 0;

  ping(): Promise<void> {
    return this.down ? Promise.reject(new Error('connection refused')) : Promise.resolve();
  }

  // --- test helpers ---------------------------------------------------------

  seedUser(sub: string, email: string | null = null): UserRecord {
    const user: UserRecord = { id: randomUUID(), cognitoSub: sub, email, displayName: null };
    this.usersBySub.set(sub, user);
    return user;
  }

  seedDocument(ownerId: string, title = 'Untitled'): DocumentRecord {
    const now = new Date();
    const doc: MutableDocument = {
      id: randomUUID(),
      ownerId,
      title,
      linkAccess: 'none',
      snapshotKey: null,
      snapshotSeq: 0,
      updatedAt: now,
      deletedAt: null,
    };
    this.docs.set(doc.id, doc);
    return { ...doc };
  }

  share(documentId: string, userId: string, permission: Permission): void {
    const map = this.sharesByDoc.get(documentId) ?? new Map<string, Permission>();
    map.set(userId, permission);
    this.sharesByDoc.set(documentId, map);
  }

  // --- Repo -------------------------------------------------------------------

  readonly users: Repo['users'] = {
    upsertFromToken: (identity) => {
      const existing = this.usersBySub.get(identity.sub);
      if (existing) {
        const merged: UserRecord = { ...existing, email: existing.email ?? identity.email };
        this.usersBySub.set(identity.sub, merged);
        return Promise.resolve(merged);
      }
      return Promise.resolve(this.seedUser(identity.sub, identity.email));
    },
  };

  readonly documents: Repo['documents'] = {
    listForUser: (userId, view) => {
      const out: DocumentListing[] = [];
      for (const doc of this.docs.values()) {
        const shared = this.sharesByDoc.get(doc.id)?.get(userId);
        if (view === 'deleted') {
          if (doc.deletedAt !== null && doc.ownerId === userId)
            out.push({ ...doc, permission: 'owner' });
          continue;
        }
        if (doc.deletedAt !== null) continue;
        if (doc.ownerId === userId) out.push({ ...doc, permission: 'owner' });
        else if (shared) out.push({ ...doc, permission: shared });
      }
      out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return Promise.resolve(out);
    },
    get: (id) => {
      const doc = this.docs.get(id);
      return Promise.resolve(doc ? { ...doc } : undefined);
    },
    create: ({ ownerId, title }) => Promise.resolve(this.seedDocument(ownerId, title)),
    rename: (id, title) => {
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
      return Promise.resolve({ ...doc });
    },
    sharePermission: (documentId, userId) =>
      Promise.resolve(this.sharesByDoc.get(documentId)?.get(userId)),
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
    append: (documentId, updates) => {
      this.appendCalls += 1;
      if (this.failNextAppend) {
        this.failNextAppend = false;
        return Promise.reject(new Error('simulated append failure'));
      }
      const doc = this.docs.get(documentId);
      if (!doc) return Promise.reject(new Error(`document ${documentId} does not exist`));
      const log = this.updatesByDoc.get(documentId) ?? [];
      const base = Math.max(doc.snapshotSeq, log.at(-1)?.seq ?? 0);
      updates.forEach((u, i) => log.push({ seq: base + i + 1, update: u.update }));
      this.updatesByDoc.set(documentId, log);
      doc.updatedAt = new Date();
      return Promise.resolve({ firstSeq: base + 1, lastSeq: base + updates.length });
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
