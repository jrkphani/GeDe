/**
 * Library (LIB-01, LIB-02, LIB-07, LIB-08), profile (AUTH-09, I18N-05) and
 * the non-participant rule (SHARE-03: the title is never revealed) over the
 * fake repo. Every route is exercised for its happy path, 401, 403 and 400.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { documentMeta, listSheets, openDocument, tablesOnSheet } from '@gede/core';
import * as Y from 'yjs';

import { json, startServer, type TestServer } from '../test/fakes.js';
import type { DocumentSummaryView, DocumentView, ProfileView } from './api.js';
import type { SharesView as ParticipantsView } from './share.js';

interface ErrorBody {
  error: { code: string; message: string; ref: string; details?: unknown };
}

const DAY = 24 * 60 * 60 * 1000;
const SECRET_TITLE = 'Q3 acquisition targets';

let server: TestServer;
let alice: string;
let bob: string;
let carol: string;
let aliceId: string;
let bobId: string;
let carolId: string;

async function me(token: string): Promise<ProfileView> {
  const res = await json<ProfileView>(server, 'GET', '/api/me', { token });
  return res.body;
}

/** The raw listing, guided sample included (ONB-01 pins it first in every view it is in). */
function listAll(token: string, view?: string) {
  const path = view === undefined ? '/api/documents' : `/api/documents?view=${view}`;
  return json<{ documents: DocumentSummaryView[] }>(server, 'GET', path, { token });
}

/**
 * The listing without the guided sample every account owns from its first
 * request (ONB-01), so the library tests below can reason about the rows
 * they seeded. The sample itself is covered under "guided sample (ONB-01)".
 */
async function list(token: string, view?: string) {
  const res = await listAll(token, view);
  return { ...res, body: { documents: res.body.documents.filter((d) => !d.sample) } };
}

beforeEach(async () => {
  server = await startServer();
  alice = server.verifier.issue('tok-alice', 'sub-alice', 'alice@example.com');
  bob = server.verifier.issue('tok-bob', 'sub-bob', 'bob@example.com');
  carol = server.verifier.issue('tok-carol', 'sub-carol');
  aliceId = (await me(alice)).id;
  bobId = (await me(bob)).id;
  carolId = (await me(carol)).id;
});

afterEach(async () => {
  await server.close();
});

describe('GET /api/documents views (LIB-01)', () => {
  test('LIB-01 recents lists owned and shared, newest first, with kind, owner and sharer', async () => {
    const t0 = new Date('2026-09-01T00:00:00Z');
    const mine = server.repo.seedDocument(aliceId, 'mine', t0);
    const fromBob = server.repo.seedDocument(bobId, 'from bob', new Date(t0.getTime() + 1000));
    server.repo.share(fromBob.id, aliceId, 'view');
    server.repo.seedDocument(bobId, 'private to bob');
    const gone = server.repo.seedDocument(aliceId, 'gone');
    await server.repo.documents.softDelete(gone.id);
    server.repo.userById(bobId)!.displayName = 'Bob B';

    const res = await list(alice);
    expect(res.status).toBe(200);
    expect(res.body.documents.map((d) => d.id)).toEqual([fromBob.id, mine.id]);
    const shared = res.body.documents[0]!;
    expect(shared).toMatchObject({
      kind: 'workscape',
      permission: 'view',
      ownerId: bobId,
      ownerName: 'Bob B',
      sharedBy: { id: bobId, name: 'Bob B' },
      sharedWithOthers: true,
      sizeBytes: 0,
      createdAt: fromBob.createdAt.toISOString(),
    });
    expect(shared.deletedAt).toBeNull();
    const own = res.body.documents[1]!;
    expect(own).toMatchObject({
      permission: 'owner',
      ownerName: 'alice@example.com',
      sharedWithOthers: false,
    });
    expect(own.sharedBy).toBeUndefined();
  });

  test('LIB-01 the default view is recents', async () => {
    const mine = server.repo.seedDocument(aliceId, 'mine');
    const explicit = await list(alice, 'recents');
    const implicit = await list(alice);
    expect(implicit.body).toEqual(explicit.body);
    expect(implicit.body.documents.map((d) => d.id)).toEqual([mine.id]);
  });

  test('LIB-01 browse lists only what the caller owns', async () => {
    const mine = server.repo.seedDocument(aliceId, 'mine');
    const fromBob = server.repo.seedDocument(bobId, 'from bob');
    server.repo.share(fromBob.id, aliceId, 'edit');
    const res = await list(alice, 'browse');
    expect(res.body.documents.map((d) => d.id)).toEqual([mine.id]);
  });

  test('LIB-01 shared lists documents shared with me and my own that have shares, flagged', async () => {
    server.repo.seedDocument(aliceId, 'mine, unshared');
    const mineShared = server.repo.seedDocument(aliceId, 'mine, shared out');
    server.repo.share(mineShared.id, carolId, 'view');
    const fromBob = server.repo.seedDocument(bobId, 'from bob');
    server.repo.share(fromBob.id, aliceId, 'edit');
    server.repo.seedDocument(bobId, 'bob keeps this');

    const res = await list(alice, 'shared');
    const byId = new Map(res.body.documents.map((d) => [d.id, d]));
    expect([...byId.keys()].sort()).toEqual([fromBob.id, mineShared.id].sort());
    expect(byId.get(mineShared.id)).toMatchObject({
      permission: 'owner',
      sharedWithOthers: true,
    });
    expect(byId.get(mineShared.id)?.sharedBy).toBeUndefined();
    expect(byId.get(fromBob.id)).toMatchObject({
      permission: 'edit',
      sharedBy: { id: bobId, name: 'bob@example.com' },
    });
  });

  test('LIB-08 deleted lists my own documents deleted within 30 days only', async () => {
    const recent = server.repo.seedDocument(aliceId, 'recent');
    await server.repo.documents.softDelete(recent.id);
    const old = server.repo.seedDocument(aliceId, 'old');
    server.repo.docs.get(old.id)!.deletedAt = new Date(Date.now() - 31 * DAY);
    const bobs = server.repo.seedDocument(bobId, 'bobs');
    server.repo.share(bobs.id, aliceId, 'edit');
    await server.repo.documents.softDelete(bobs.id);
    server.repo.seedDocument(aliceId, 'live');

    const res = await list(alice, 'deleted');
    expect(res.body.documents.map((d) => d.id)).toEqual([recent.id]);
    expect(res.body.documents[0]?.deletedAt).not.toBeNull();
    expect(res.body.documents[0]?.permission).toBe('owner');
  });

  test('LIB-01 an unknown view is a 400 in the error envelope', async () => {
    const res = await json<ErrorBody>(server, 'GET', '/api/documents?view=starred', {
      token: alice,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.ref).toBe(res.headers.get('x-request-id'));
  });

  test('LIB-01 every view needs a bearer token', async () => {
    for (const view of ['recents', 'browse', 'shared', 'deleted']) {
      const res = await json<ErrorBody>(server, 'GET', `/api/documents?view=${view}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    }
  });
});

describe('sizeBytes (LIB-02)', () => {
  test('LIB-02 size is the latest snapshot plus every update logged after it', async () => {
    const doc = server.repo.seedDocument(aliceId, 'sized');
    const bytes = (n: number) => new Uint8Array(n).fill(1);
    await server.repo.updates.append(doc.id, [
      { update: bytes(100), authorId: aliceId },
      { update: bytes(50), authorId: aliceId },
    ]);
    let res = await list(alice, 'browse');
    expect(res.body.documents[0]?.sizeBytes).toBe(150);

    await server.repo.updates.commitSnapshot({
      coversFrom: 0,
      appended: 2,
      documentId: doc.id,
      seq: 2,
      s3Key: `docs/${doc.id}/2.yjs`,
      sizeBytes: 120,
    });
    res = await list(alice, 'browse');
    expect(res.body.documents[0]?.sizeBytes).toBe(120);

    await server.repo.updates.append(doc.id, [{ update: bytes(7), authorId: aliceId }]);
    res = await list(alice, 'browse');
    expect(res.body.documents[0]?.sizeBytes).toBe(127);

    const one = await json<{ document: DocumentSummaryView }>(
      server,
      'GET',
      `/api/documents/${doc.id}`,
      { token: alice },
    );
    expect(one.status).toBe(200);
    expect(one.body.document).toMatchObject({
      sizeBytes: 127,
      permission: 'owner',
      ownerName: 'alice@example.com',
      kind: 'workscape',
      sharedWithOthers: false,
    });
  });

  test('LIB-02 a participant reading one document sees their permission and who shared it', async () => {
    const doc = server.repo.seedDocument(bobId, 'shared one');
    server.repo.share(doc.id, aliceId, 'view');
    const res = await json<{ document: DocumentSummaryView }>(
      server,
      'GET',
      `/api/documents/${doc.id}`,
      { token: alice },
    );
    expect(res.body.document).toMatchObject({
      permission: 'view',
      ownerName: 'bob@example.com',
      sharedBy: { id: bobId, name: 'bob@example.com' },
      sharedWithOthers: true,
    });
  });
});

describe('recover (LIB-08)', () => {
  test('LIB-08 the owner recovers a deleted document and an audit row is written', async () => {
    const doc = server.repo.seedDocument(aliceId, 'oops');
    await server.repo.documents.softDelete(doc.id);
    const res = await json<{ document: DocumentView }>(
      server,
      'POST',
      `/api/documents/${doc.id}/recover`,
      { token: alice },
    );
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ id: doc.id, deletedAt: null, permission: 'owner' });
    expect(server.repo.docs.get(doc.id)?.deletedAt).toBeNull();
    expect(server.repo.auditLog.at(-1)).toMatchObject({
      documentId: doc.id,
      userId: aliceId,
      action: 'document.recover',
    });
    expect((await list(alice, 'deleted')).body.documents).toEqual([]);
    expect((await list(alice)).body.documents.map((d) => d.id)).toEqual([doc.id]);
  });

  test('LIB-08 recovering a live document is a 409, not a silent no-op', async () => {
    const doc = server.repo.seedDocument(aliceId, 'live');
    const res = await json<ErrorBody>(server, 'POST', `/api/documents/${doc.id}/recover`, {
      token: alice,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  test('SHARE-03 only the owner may recover; an editor is told it is gone (404), a stranger 403, neither the title', async () => {
    const doc = server.repo.seedDocument(aliceId, SECRET_TITLE);
    server.repo.share(doc.id, bobId, 'edit');
    await server.repo.documents.softDelete(doc.id);
    const asEditor = await json<ErrorBody>(server, 'POST', `/api/documents/${doc.id}/recover`, {
      token: bob,
    });
    expect(asEditor.status).toBe(404);
    expect(JSON.stringify(asEditor.body)).not.toContain(SECRET_TITLE);
    const asStranger = await json<ErrorBody>(server, 'POST', `/api/documents/${doc.id}/recover`, {
      token: carol,
    });
    expect(asStranger.status).toBe(403);
    expect(JSON.stringify(asStranger.body)).not.toContain(SECRET_TITLE);
    expect(server.repo.docs.get(doc.id)?.deletedAt).not.toBeNull();
  });

  test('LIB-08 a document deleted more than 30 days ago is not recoverable (404), matching the deleted view', async () => {
    const expired = server.repo.seedDocument(aliceId, 'expired');
    server.repo.docs.get(expired.id)!.deletedAt = new Date(Date.now() - 31 * DAY);
    expect((await list(alice, 'deleted')).body.documents).toEqual([]);
    const res = await json<ErrorBody>(server, 'POST', `/api/documents/${expired.id}/recover`, {
      token: alice,
    });
    expect(res.status).toBe(404);
    expect(server.repo.docs.get(expired.id)?.deletedAt).not.toBeNull();
    expect(server.repo.auditLog.filter((e) => e.action === 'document.recover')).toEqual([]);
  });

  test('LIB-08 a participant of a deleted document gets 404 on every read, a stranger 403', async () => {
    const doc = server.repo.seedDocument(aliceId, SECRET_TITLE);
    server.repo.share(doc.id, bobId, 'view');
    await server.repo.documents.softDelete(doc.id);
    for (const path of [`/api/documents/${doc.id}`, `/api/documents/${doc.id}/shares`]) {
      const asViewer = await json<ErrorBody>(server, 'GET', path, { token: bob });
      expect(asViewer.status, path).toBe(404);
      expect(asViewer.body.error.message).toBe('Nothing at this address');
      expect(JSON.stringify(asViewer.body)).not.toContain(SECRET_TITLE);
      const asStranger = await json<ErrorBody>(server, 'GET', path, { token: carol });
      expect(asStranger.status, path).toBe(403);
      expect(JSON.stringify(asStranger.body)).not.toContain(SECRET_TITLE);
    }
    const rename = await json<ErrorBody>(server, 'PATCH', `/api/documents/${doc.id}`, {
      token: bob,
      body: { title: 'x' },
    });
    expect(rename.status).toBe(404);
  });

  test('LIB-08 recover needs a token and a well-formed id', async () => {
    const doc = server.repo.seedDocument(aliceId, 'x');
    expect((await json(server, 'POST', `/api/documents/${doc.id}/recover`)).status).toBe(401);
    const bad = await json<ErrorBody>(server, 'POST', '/api/documents/nope/recover', {
      token: alice,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('That link is not a workscape');
    const missing = await json<ErrorBody>(
      server,
      'POST',
      `/api/documents/${crypto.randomUUID()}/recover`,
      { token: alice },
    );
    expect(missing.status).toBe(404);
  });
});

describe('recover-all and delete-all (LIB-08)', () => {
  test('LIB-08 recover-all restores every owned document inside the window, nothing else', async () => {
    const a = server.repo.seedDocument(aliceId, 'a');
    const b = server.repo.seedDocument(aliceId, 'b');
    await server.repo.documents.softDelete(a.id);
    await server.repo.documents.softDelete(b.id);
    const expired = server.repo.seedDocument(aliceId, 'expired');
    server.repo.docs.get(expired.id)!.deletedAt = new Date(Date.now() - 31 * DAY);
    const bobs = server.repo.seedDocument(bobId, 'bobs');
    await server.repo.documents.softDelete(bobs.id);

    const res = await json<{ recovered: number; ids: string[] }>(
      server,
      'POST',
      '/api/documents/recover-all',
      { token: alice },
    );
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(2);
    // LIB-D9: the ids come back so the client's Undo can delete each again.
    expect([...res.body.ids].sort()).toEqual([a.id, b.id].sort());
    expect(server.repo.docs.get(a.id)?.deletedAt).toBeNull();
    expect(server.repo.docs.get(b.id)?.deletedAt).toBeNull();
    expect(server.repo.docs.get(expired.id)?.deletedAt).not.toBeNull();
    expect(server.repo.docs.get(bobs.id)?.deletedAt).not.toBeNull();
    const recovers = server.repo.auditLog.filter((e) => e.action === 'document.recover');
    expect(recovers.map((e) => e.documentId).sort()).toEqual([a.id, b.id].sort());
    expect(recovers.every((e) => e.userId === aliceId)).toBe(true);

    const again = await json<{ recovered: number }>(server, 'POST', '/api/documents/recover-all', {
      token: alice,
    });
    expect(again.body).toEqual({ recovered: 0, ids: [] });
  });

  test('LIB-08 delete-all permanently removes rows, shares, updates, snapshots and S3 objects, and audits each', async () => {
    const doomed = server.repo.seedDocument(aliceId, 'doomed');
    server.repo.share(doomed.id, bobId, 'edit');
    await server.repo.updates.append(doomed.id, [
      { update: new Uint8Array([1, 2, 3]), authorId: aliceId },
    ]);
    await server.s3.put(`docs/${doomed.id}/1.yjs`, new Uint8Array([9]));
    await server.repo.updates.commitSnapshot({
      coversFrom: 0,
      appended: 0,
      documentId: doomed.id,
      seq: 1,
      s3Key: `docs/${doomed.id}/1.yjs`,
      sizeBytes: 1,
    });
    await server.s3.put(`docs/${doomed.id}/orphan.yjs`, new Uint8Array([9]));
    await server.repo.documents.softDelete(doomed.id);
    const expired = server.repo.seedDocument(aliceId, 'expired long ago');
    server.repo.docs.get(expired.id)!.deletedAt = new Date(Date.now() - 45 * DAY);
    const live = server.repo.seedDocument(aliceId, 'live');
    await server.s3.put(`docs/${live.id}/1.yjs`, new Uint8Array([9]));
    const bobs = server.repo.seedDocument(bobId, 'bobs');
    await server.repo.documents.softDelete(bobs.id);

    const res = await json<{ deleted: number }>(server, 'POST', '/api/documents/delete-all', {
      token: alice,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });

    for (const id of [doomed.id, expired.id]) {
      expect(server.repo.docs.has(id)).toBe(false);
      expect(server.repo.updatesByDoc.has(id)).toBe(false);
      expect(server.repo.snapshotsByDoc.has(id)).toBe(false);
      expect(server.repo.sharesByDoc.has(id)).toBe(false);
    }
    const sampleKeys = [...server.repo.docs.values()]
      .filter((d) => d.sample)
      .map((d) => `docs/${d.id}/1.yjs`);
    expect([...server.s3.objects.keys()].filter((k) => !sampleKeys.includes(k))).toEqual([
      `docs/${live.id}/1.yjs`,
    ]);
    expect(server.repo.docs.has(live.id)).toBe(true);
    expect(server.repo.docs.has(bobs.id)).toBe(true);

    const purges = server.repo.auditLog.filter((e) => e.action === 'document.purge');
    expect(purges).toEqual(
      expect.arrayContaining([
        { documentId: doomed.id, userId: aliceId, action: 'document.purge', target: 'doomed' },
        {
          documentId: expired.id,
          userId: aliceId,
          action: 'document.purge',
          target: 'expired long ago',
        },
      ]),
    );
    expect(purges).toHaveLength(2);
    expect((await list(alice, 'deleted')).body.documents).toEqual([]);
  });

  test('LIB-08 an S3 failure after the commit is logged, not surfaced: the rows stay gone', async () => {
    const doomed = server.repo.seedDocument(aliceId, 'doomed');
    await server.s3.put(`docs/${doomed.id}/1.yjs`, new Uint8Array([9]));
    await server.repo.documents.softDelete(doomed.id);
    server.s3.failNextDelete = true;

    const res = await json<{ deleted: number }>(server, 'POST', '/api/documents/delete-all', {
      token: alice,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    expect(server.repo.docs.has(doomed.id)).toBe(false);
    expect(server.s3.objects.has(`docs/${doomed.id}/1.yjs`)).toBe(true); // orphan for the operator
  });

  test('LIB-08 a failed purge transaction leaves everything in place and answers 500 with a ref', async () => {
    const doomed = server.repo.seedDocument(aliceId, 'doomed');
    await server.repo.documents.softDelete(doomed.id);
    server.repo.failNextPurge = true;
    const res = await json<ErrorBody>(server, 'POST', '/api/documents/delete-all', {
      token: alice,
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'server_error' });
    expect(res.body.error.ref).toBe(res.headers.get('x-request-id'));
    expect(server.repo.docs.has(doomed.id)).toBe(true);
    expect(server.repo.auditLog.filter((e) => e.action === 'document.purge')).toEqual([]);
  });

  test('LIB-08 both bulk routes are empty-safe and require a token', async () => {
    expect((await json(server, 'POST', '/api/documents/recover-all')).status).toBe(401);
    expect((await json(server, 'POST', '/api/documents/delete-all')).status).toBe(401);
    const recovered = await json<{ recovered: number }>(
      server,
      'POST',
      '/api/documents/recover-all',
      { token: carol },
    );
    expect(recovered.body).toEqual({ recovered: 0, ids: [] });
    const deleted = await json<{ deleted: number }>(server, 'POST', '/api/documents/delete-all', {
      token: carol,
    });
    expect(deleted.body).toEqual({ deleted: 0 });
  });
});

describe('GET /api/documents/:id/shares (LIB-07)', () => {
  test('LIB-07 lists the owner apart, every participant with permission and inviter, and the link mode', async () => {
    server.repo.userById(aliceId)!.displayName = 'Alice A';
    const doc = server.repo.seedDocument(aliceId, 'team');
    server.repo.share(doc.id, bobId, 'edit');
    server.repo.share(doc.id, carolId, 'view', bobId);
    // Participants come back in the order they were added (shares.created_at).
    server.repo.sharesByDoc.get(doc.id)!.get(carolId)!.createdAt = new Date(Date.now() + 1000);

    const res = await json<ParticipantsView>(server, 'GET', `/api/documents/${doc.id}/shares`, {
      token: alice,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      owner: { id: aliceId, name: 'Alice A', email: 'alice@example.com' },
      participants: [
        {
          userId: bobId,
          name: null,
          email: 'bob@example.com',
          permission: 'edit',
          invitedBy: aliceId,
          source: 'invite',
        },
        {
          userId: carolId,
          name: null,
          email: null,
          permission: 'view',
          invitedBy: bobId,
          source: 'invite',
        },
      ],
      invites: [],
      linkAccess: 'none',
      linkToken: null,
      permission: 'owner',
      callerId: aliceId,
    });
    expect(res.body.participants.some((p) => p.userId === aliceId)).toBe(false);
  });

  test('LIB-07 an editor sees emails; a view-only participant sees names only', async () => {
    server.repo.userById(aliceId)!.displayName = 'Alice A';
    const doc = server.repo.seedDocument(aliceId, 'team');
    server.repo.share(doc.id, bobId, 'edit');
    server.repo.share(doc.id, carolId, 'view');
    server.repo.sharesByDoc.get(doc.id)!.get(carolId)!.createdAt = new Date(Date.now() + 1000);

    const asEditor = await json<ParticipantsView>(
      server,
      'GET',
      `/api/documents/${doc.id}/shares`,
      { token: bob },
    );
    expect(asEditor.status).toBe(200);
    expect(asEditor.body.owner).toEqual({
      id: aliceId,
      name: 'Alice A',
      email: 'alice@example.com',
    });
    expect(asEditor.body.participants.map((p) => p.email)).toEqual(['bob@example.com', null]);

    const asViewer = await json<ParticipantsView>(
      server,
      'GET',
      `/api/documents/${doc.id}/shares`,
      { token: carol },
    );
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.owner).toEqual({ id: aliceId, name: 'Alice A', email: null });
    expect(asViewer.body.participants.map((p) => [p.userId, p.permission, p.email])).toEqual([
      [bobId, 'edit', null],
      [carolId, 'view', null],
    ]);
    expect(JSON.stringify(asViewer.body)).not.toContain('@example.com');
  });

  test('SHARE-03 a non-participant gets 403 and the response never carries the title', async () => {
    const doc = server.repo.seedDocument(aliceId, SECRET_TITLE);
    server.repo.share(doc.id, carolId, 'view');
    for (const path of [
      `/api/documents/${doc.id}`,
      `/api/documents/${doc.id}/shares`,
      `/api/documents/${doc.id}/recover`,
    ]) {
      const method = path.endsWith('/recover') ? 'POST' : 'GET';
      const res = await json<ErrorBody>(server, method, path, { token: bob });
      expect(res.status, path).toBe(403);
      expect(res.body.error).toEqual({
        code: 'forbidden',
        message: 'You do not have access to this workscape',
        ref: res.headers.get('x-request-id'),
      });
      expect(JSON.stringify(res.body), path).not.toContain(SECRET_TITLE);
    }
    const rename = await json<ErrorBody>(server, 'PATCH', `/api/documents/${doc.id}`, {
      token: bob,
      body: { title: 'x' },
    });
    expect(rename.status).toBe(403);
    expect(JSON.stringify(rename.body)).not.toContain(SECRET_TITLE);
  });

  test('LIB-07 shares needs a token, a well-formed id and an existing document', async () => {
    const doc = server.repo.seedDocument(aliceId, 'team');
    expect((await json(server, 'GET', `/api/documents/${doc.id}/shares`)).status).toBe(401);
    expect(
      (await json(server, 'GET', '/api/documents/not-a-uuid/shares', { token: alice })).status,
    ).toBe(400);
    expect(
      (await json(server, 'GET', `/api/documents/${crypto.randomUUID()}/shares`, { token: alice }))
        .status,
    ).toBe(404);
  });
});

describe('delete vs archive (LIB-D1..D11)', () => {
  const del = (token: string, id: string) =>
    json<ErrorBody>(server, 'DELETE', `/api/documents/${id}`, { token });
  const archive = (token: string, id: string) =>
    json<{ document: DocumentView } & ErrorBody>(server, 'POST', `/api/documents/${id}/archive`, {
      token,
    });
  const unarchive = (token: string, id: string) =>
    json<{ document: DocumentView } & ErrorBody>(server, 'POST', `/api/documents/${id}/unarchive`, {
      token,
    });
  const flag = (id: string) => server.repo.docs.get(id)!.everShared;
  const actions = (id: string) =>
    server.repo.auditLog.filter((e) => e.documentId === id).map((e) => e.action);

  test('LIB-D1 a workscape with no participant and no link deletes (204) and is listed as not shared', async () => {
    const doc = server.repo.seedDocument(aliceId, 'mine alone');
    const listed = (await list(alice, 'browse')).body.documents[0]!;
    expect(listed).toMatchObject({ everShared: false, archivedAt: null, sample: false });
    expect((await del(alice, doc.id)).status).toBe(204);
    expect(actions(doc.id)).toEqual(['document.delete']);
  });

  test('LIB-D2 LIB-D4 a workscape becomes non-deletable when an invitation is accepted, not when it is sent; delete answers 409 shared', async () => {
    const doc = server.repo.seedDocument(aliceId, 'to share');
    server.verifier.issueId('id.alice', 'sub-alice', 'alice@example.com');
    await json(server, 'PATCH', '/api/me', { token: alice, body: { idToken: 'id.alice' } });
    const sent = await json<{ kind: string }>(server, 'POST', `/api/documents/${doc.id}/invites`, {
      token: alice,
      body: { email: 'dana@example.com', permission: 'edit' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.kind).toBe('invite');
    // Sent, not accepted: still deletable.
    expect(flag(doc.id)).toBe(false);
    expect((await list(alice, 'browse')).body.documents[0]?.everShared).toBe(false);

    // Dana signs in with the invited address: the invitation converts, the flag flips.
    const dana = server.verifier.issue('tok-dana', 'sub-dana', 'dana@example.com');
    await me(dana);
    expect(flag(doc.id)).toBe(true);
    const refused = await del(alice, doc.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'shared',
      message: 'This workscape has been shared, so it can be archived but not deleted',
    });
    expect(server.repo.docs.get(doc.id)?.deletedAt).toBeNull();
    // A participant's request is still 403, never 409 (SHARE-03: no hints).
    expect((await del(dana, doc.id)).status).toBe(403);

    // LIB-D4: removing the last participant restores deletability.
    const danaId = (await me(dana)).id;
    await json(server, 'DELETE', `/api/documents/${doc.id}/shares/${danaId}`, { token: alice });
    expect(flag(doc.id)).toBe(false);
    expect((await del(alice, doc.id)).status).toBe(204);
  });

  test('LIB-D2 LIB-D4 naming a person who already has an account shares on the spot; stop sharing restores deletability', async () => {
    const doc = server.repo.seedDocument(aliceId, 'named');
    server.verifier.issueId('id.alice', 'sub-alice', 'alice@example.com');
    await json(server, 'PATCH', '/api/me', { token: alice, body: { idToken: 'id.alice' } });
    const added = await json<{ kind: string }>(server, 'POST', `/api/documents/${doc.id}/invites`, {
      token: alice,
      body: { email: 'bob@example.com', permission: 'view' },
    });
    expect(added.body.kind).toBe('share');
    expect(flag(doc.id)).toBe(true);
    expect((await del(alice, doc.id)).status).toBe(409);
    await json(server, 'POST', `/api/documents/${doc.id}/stop-sharing`, { token: alice });
    expect(flag(doc.id)).toBe(false);
    expect((await del(alice, doc.id)).status).toBe(204);
  });

  test('LIB-D1 LIB-D4 an active share link makes a workscape non-deletable; switching it off, with nobody left, restores deletability', async () => {
    const doc = server.repo.seedDocument(aliceId, 'linked');
    const on = await json<{ linkToken: string }>(server, 'PATCH', `/api/documents/${doc.id}/link`, {
      token: alice,
      body: { access: 'view' },
    });
    expect(flag(doc.id)).toBe(true);
    expect((await del(alice, doc.id)).body.error.code).toBe('shared');
    // Carol redeems the link, then the link goes: her link share goes with it.
    const redeemed = await json(server, 'POST', `/api/documents/${doc.id}/link/redeem`, {
      token: carol,
      body: { token: on.body.linkToken },
    });
    expect(redeemed.status).toBe(200);
    await json(server, 'PATCH', `/api/documents/${doc.id}/link`, {
      token: alice,
      body: { access: 'none' },
    });
    expect(server.repo.sharesByDoc.get(doc.id)?.size ?? 0).toBe(0);
    expect(flag(doc.id)).toBe(false);
    expect((await del(alice, doc.id)).status).toBe(204);
  });

  test('LIB-D4 switching the link off while an invited participant remains keeps the workscape non-deletable', async () => {
    const doc = server.repo.seedDocument(aliceId, 'linked and shared');
    server.repo.share(doc.id, bobId, 'view');
    await json(server, 'PATCH', `/api/documents/${doc.id}/link`, {
      token: alice,
      body: { access: 'edit' },
    });
    await json(server, 'PATCH', `/api/documents/${doc.id}/link`, {
      token: alice,
      body: { access: 'none' },
    });
    expect(flag(doc.id)).toBe(true);
    expect((await del(alice, doc.id)).status).toBe(409);
  });

  test('LIB-D3 LIB-D6 archive keeps every share and the link, hides the row from the owner’s Recents, Browse and Shared, lists it under archived, and participants see no change', async () => {
    const doc = server.repo.seedDocument(aliceId, 'shared then archived');
    server.repo.share(doc.id, bobId, 'edit');
    await json(server, 'PATCH', `/api/documents/${doc.id}/link`, {
      token: alice,
      body: { access: 'view' },
    });
    const before = (await list(bob, 'recents')).body.documents.map((d) => d.id);
    expect(before).toEqual([doc.id]);

    const res = await archive(alice, doc.id);
    expect(res.status).toBe(200);
    expect(res.body.document.archivedAt).not.toBeNull();
    expect(res.body.document.everShared).toBe(true);
    expect(actions(doc.id)).toEqual(['share.link', 'document.archive']);

    for (const view of ['recents', 'browse', 'shared'] as const) {
      expect(
        (await list(alice, view)).body.documents.map((d) => d.id),
        view,
      ).toEqual([]);
    }
    const archived = (await list(alice, 'archived')).body.documents;
    expect(archived.map((d) => d.id)).toEqual([doc.id]);
    expect(archived[0]).toMatchObject({ permission: 'owner', sharedWithOthers: true });
    // Participants: same rows, same access, same link (LIB-D3).
    expect((await list(bob, 'recents')).body.documents.map((d) => d.id)).toEqual(before);
    expect((await list(bob, 'shared')).body.documents.map((d) => d.id)).toEqual(before);
    expect(server.repo.sharesByDoc.get(doc.id)?.get(bobId)?.permission).toBe('edit');
    expect(server.repo.docs.get(doc.id)?.linkAccess).toBe('view');
    const bobReads = await json<{ document: DocumentSummaryView }>(
      server,
      'GET',
      `/api/documents/${doc.id}`,
      { token: bob },
    );
    expect(bobReads.status).toBe(200);
    expect(bobReads.body.document.archivedAt).not.toBeNull();
    // Archive has no expiry: the row is not in Recently Deleted and `deletedAt` stays null.
    expect((await list(alice, 'deleted')).body.documents).toEqual([]);
    expect(server.repo.docs.get(doc.id)?.deletedAt).toBeNull();

    // A second archive is a 409; a participant may not archive (403).
    expect((await archive(alice, doc.id)).status).toBe(409);
    expect((await archive(bob, doc.id)).status).toBe(403);

    // Unarchive: back in every view, audited.
    const back = await unarchive(alice, doc.id);
    expect(back.status).toBe(200);
    expect(back.body.document.archivedAt).toBeNull();
    expect((await list(alice, 'browse')).body.documents.map((d) => d.id)).toEqual([doc.id]);
    expect((await list(alice, 'archived')).body.documents).toEqual([]);
    expect(actions(doc.id).at(-1)).toBe('document.unarchive');
    expect((await unarchive(alice, doc.id)).status).toBe(409);
  });

  test('LIB-D5 delete from the archive moves the row to Recently Deleted and out of the archive; recover leaves it unarchived', async () => {
    const doc = server.repo.seedDocument(aliceId, 'archived, unshared');
    expect((await archive(alice, doc.id)).status).toBe(200);
    expect((await del(alice, doc.id)).status).toBe(204);
    const row = server.repo.docs.get(doc.id)!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.archivedAt).toBeNull();
    expect((await list(alice, 'archived')).body.documents).toEqual([]);
    expect((await list(alice, 'deleted')).body.documents.map((d) => d.id)).toEqual([doc.id]);
    // A deleted workscape cannot be archived or unarchived: it is gone (404).
    expect((await archive(alice, doc.id)).status).toBe(404);
    expect((await unarchive(alice, doc.id)).status).toBe(404);
    await json(server, 'POST', `/api/documents/${doc.id}/recover`, { token: alice });
    expect((await list(alice, 'browse')).body.documents.map((d) => d.id)).toEqual([doc.id]);
  });

  test('LIB-D10 the guided sample is exempt from delete and archive: 409 sample, with the reason', async () => {
    // The sample every account owns from its first request (ONB-01), not a fixture.
    const listed = (await listAll(alice, 'browse')).body.documents[0]!;
    expect(listed).toMatchObject({ sample: true, title: 'Q3 Delivery — Guided sample' });
    const sample = { id: listed.id };
    const deleted = await del(alice, sample.id);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error).toMatchObject({
      code: 'sample',
      message: 'The guided sample cannot be deleted',
    });
    const archived = await archive(alice, sample.id);
    expect(archived.status).toBe(409);
    expect(archived.body.error).toMatchObject({
      code: 'sample',
      message: 'The guided sample cannot be archived',
    });
    // ONB-01: it is *named* `Q3 Delivery — Guided sample`; a rename is refused the same way.
    const renamed = await json<ErrorBody>(server, 'PATCH', `/api/documents/${sample.id}`, {
      token: alice,
      body: { title: 'Mine now' },
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toMatchObject({
      code: 'sample',
      message: 'The guided sample cannot be renamed',
    });
    expect(server.repo.docs.get(sample.id)).toMatchObject({
      deletedAt: null,
      archivedAt: null,
      title: 'Q3 Delivery — Guided sample',
    });
    // Only its seeding is audited; the refused delete, archive and rename wrote nothing.
    expect(actions(sample.id)).toEqual(['document.create']);
  });

  test('LIB-D11 archive is a document state: a second client of the same account reads it from the list at once, and the view is served by name', async () => {
    const doc = server.repo.seedDocument(aliceId, 'state');
    const second = server.verifier.issue('tok-alice-2', 'sub-alice', 'alice@example.com');
    expect((await list(second, 'browse')).body.documents.map((d) => d.id)).toEqual([doc.id]);
    await archive(alice, doc.id);
    expect((await list(second, 'browse')).body.documents).toEqual([]);
    expect((await list(second, 'archived')).body.documents.map((d) => d.id)).toEqual([doc.id]);
    expect((await listAll(alice, 'archive')).status).toBe(400);
  });

  test('LIB-D6 archive and unarchive need a token, a well-formed id and an existing document', async () => {
    const doc = server.repo.seedDocument(aliceId, 'x');
    for (const path of ['archive', 'unarchive']) {
      expect((await json(server, 'POST', `/api/documents/${doc.id}/${path}`)).status).toBe(401);
      expect(
        (await json(server, 'POST', `/api/documents/not-a-uuid/${path}`, { token: alice })).status,
      ).toBe(400);
      expect(
        (
          await json(server, 'POST', `/api/documents/${crypto.randomUUID()}/${path}`, {
            token: alice,
          })
        ).status,
      ).toBe(404);
    }
  });
});

describe('profile (AUTH-09, I18N-05)', () => {
  test('AUTH-09 GET /api/me returns id, sub, email, displayName and locale', async () => {
    const res = await json<ProfileView>(server, 'GET', '/api/me', { token: alice });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: aliceId,
      sub: 'sub-alice',
      email: 'alice@example.com',
      displayName: null,
      locale: null,
      tourDoneAt: null,
      sampleDocumentId: server.repo.sampleOf(aliceId),
    });
    expect(res.body.sampleDocumentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('ONB-03 PATCH /api/me { tourDone: true } stamps the account flag; false clears it (ONB-08); GET reflects both', async () => {
    const done = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { tourDone: true },
    });
    expect(done.status).toBe(200);
    expect(done.body.tourDoneAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(server.repo.usersBySub.get('sub-alice')?.tourDoneAt).toBeInstanceOf(Date);
    expect((await me(alice)).tourDoneAt).toBe(done.body.tourDoneAt);
    // Per account, not per device: a second client of the same account reads it at once.
    const second = server.verifier.issue('tok-alice-2', 'sub-alice', 'alice@example.com');
    expect((await me(second)).tourDoneAt).toBe(done.body.tourDoneAt);

    const replay = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { tourDone: false },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.tourDoneAt).toBeNull();
    expect((await me(second)).tourDoneAt).toBeNull();
    // Nothing else on the profile moved.
    expect(replay.body).toMatchObject({ locale: null, displayName: null });
  });

  test('ONB-03 tourDone must be a boolean and cannot be the only unknown field', async () => {
    const res = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { tourDone: 'yes' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'tourDone' })]);
  });

  test('I18N-05 PATCH /api/me persists the locale and the next GET reflects it', async () => {
    const res = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { locale: 'ta-IN' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: aliceId, locale: 'ta-IN', displayName: null });
    expect(server.repo.usersBySub.get('sub-alice')?.locale).toBe('ta-IN');
    expect((await me(alice)).locale).toBe('ta-IN');
  });

  test('AUTH-09 PATCH /api/me trims and stores the display name, and shows it in the library', async () => {
    const res = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: bob,
      body: { displayName: '  Bob Builder  ', locale: 'en-IN' },
    });
    expect(res.body).toMatchObject({ displayName: 'Bob Builder', locale: 'en-IN' });
    const doc = server.repo.seedDocument(bobId, 'from bob');
    server.repo.share(doc.id, aliceId, 'view');
    const listing = await list(alice);
    expect(listing.body.documents[0]).toMatchObject({
      ownerName: 'Bob Builder',
      sharedBy: { id: bobId, name: 'Bob Builder' },
    });
  });

  test('I18N-05 an unsupported locale is a 400 that names the field', async () => {
    const res = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { locale: 'fr-FR' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'locale' })]);
    expect((await me(alice)).locale).toBeNull();
  });

  test('AUTH-09 display name must be 1–80 characters after trimming; unknown or empty bodies fail', async () => {
    for (const body of [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(81) },
      { nickname: 'x' },
      {},
    ]) {
      const res = await json<ErrorBody>(server, 'PATCH', '/api/me', { token: alice, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
    const max = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { displayName: 'y'.repeat(80) },
    });
    expect(max.status).toBe(200);
    expect(max.body.displayName).toBe('y'.repeat(80));
  });

  test('AUTH-09 LIB-06 a NUL or other control character in a name or title is a 400, never a 500', async () => {
    // Postgres `text` rejects NUL outright ("invalid byte sequence for encoding UTF8: 0x00");
    // without the schema check the insert fails and the client sees a server_error.
    const doc = server.repo.seedDocument(aliceId, 'plain');
    const probes: [string, string, Record<string, string>][] = [
      ['PATCH', '/api/me', { displayName: 'a\u0000b' }],
      ['PATCH', '/api/me', { displayName: 'a\nb' }],
      ['PATCH', '/api/me', { displayName: 'a\u001b[31mb' }],
      ['POST', '/api/documents', { title: 'a\u0000b' }],
      ['PATCH', `/api/documents/${doc.id}`, { title: 'a\tb' }],
    ];
    for (const [method, path, body] of probes) {
      const res = await json<ErrorBody>(server, method, path, { token: alice, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
    expect(server.repo.docs.get(doc.id)?.title).toBe('plain');
    // Non-ASCII, including combining marks, is fine.
    const ok = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { displayName: 'தமிழ் — नाम' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.displayName).toBe('தமிழ் — नाम');
  });

  test('AUTH-09 PATCH /api/me needs a token', async () => {
    const res = await json<ErrorBody>(server, 'PATCH', '/api/me', { body: { locale: 'en-GB' } });
    expect(res.status).toBe(401);
  });
});

describe('guided sample (ONB-01)', () => {
  test('ONB-01 every account owns one sample from its first request, pinned first in Recents and Browse and flagged', async () => {
    for (const [token, id] of [
      [alice, aliceId],
      [bob, bobId],
      [carol, carolId],
    ] as const) {
      const sampleId = server.repo.sampleOf(id);
      expect(sampleId).not.toBeNull();
      for (const view of ['recents', 'browse'] as const) {
        const rows = (await listAll(token, view)).body.documents;
        expect(rows[0]).toMatchObject({
          id: sampleId,
          title: 'Q3 Delivery — Guided sample',
          sample: true,
          permission: 'owner',
          ownerId: id,
        });
      }
    }
    // It stays pinned above rows that are newer than it.
    server.repo.seedDocument(aliceId, 'newer', new Date(Date.now() + 60_000));
    const rows = (await listAll(alice, 'browse')).body.documents;
    expect(rows.map((d) => d.sample)).toEqual([true, false]);
  });

  test('ONB-01 the sample is seeded once: later requests, a second client and a profile change never add another', async () => {
    const first = server.repo.sampleOf(aliceId);
    const second = server.verifier.issue('tok-alice-2', 'sub-alice', 'alice@example.com');
    await me(second);
    await json(server, 'PATCH', '/api/me', { token: alice, body: { locale: 'en-GB' } });
    await listAll(alice);
    const samples = [...server.repo.docs.values()].filter((d) => d.ownerId === aliceId && d.sample);
    expect(samples.map((d) => d.id)).toEqual([first]);
    expect((await me(second)).sampleDocumentId).toBe(first);
  });

  test('ONB-01 DOC-03 the sample is seeded server-side as snapshot seq 1 with the tables the tour refers to, audited and projected', async () => {
    const sampleId = server.repo.sampleOf(aliceId)!;
    const stored = server.repo.docs.get(sampleId);
    expect(stored).toMatchObject({ snapshotKey: `docs/${sampleId}/1.yjs`, snapshotSeq: 1 });
    expect(server.repo.snapshotsByDoc.get(sampleId)).toEqual([
      expect.objectContaining({ seq: 1, s3Key: `docs/${sampleId}/1.yjs` }),
    ]);
    const bytes = server.s3.objects.get(`docs/${sampleId}/1.yjs`);
    expect(bytes).toBeDefined();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes!);
    const gd = openDocument(doc);
    expect(documentMeta(gd).title).toBe('Q3 Delivery — Guided sample');
    const [sheet] = listSheets(gd);
    expect(tablesOnSheet(gd, sheet!.id).map((t) => t.title)).toEqual(['Deliverables', 'Team']);
    expect(server.repo.auditLog).toContainEqual(
      expect.objectContaining({
        documentId: sampleId,
        action: 'document.create',
        target: 'sample',
      }),
    );
    await server.app.projection.close();
    expect(server.repo.projections.get(sampleId)?.tables.map((t) => t.title)).toEqual([
      'Deliverables',
      'Team',
    ]);
  });

  test('ONB-01 a failed seed never fails the request: the profile answers sampleDocumentId null, the failure is logged and counted, nothing is written, and the next request seeds', async () => {
    await server.close();
    server = await startServer({}, { captureLogs: true });
    const dave = server.verifier.issue('tok-dave', 'sub-dave', 'dave@example.com');
    server.s3.failPuts = true;
    const first = await json<ProfileView>(server, 'GET', '/api/me', { token: dave });
    expect(first.status).toBe(200);
    expect(first.body.sampleDocumentId).toBeNull();
    const daveId = first.body.id;
    expect(server.repo.sampleOf(daveId)).toBeNull();
    expect(server.app.samples.stats).toEqual({ seeded: 0, adopted: 0, failures: 1 });
    expect(server.logs.some((l) => l.msg === 'guided sample seed failed')).toBe(true);
    // Other requests of the account work meanwhile: the library lists, without a sample.
    expect((await listAll(dave, 'recents')).status).toBe(200);
    // Still failing: still degraded, still counted, never cached as "done".
    expect(
      (await json<ProfileView>(server, 'GET', '/api/me', { token: dave })).body.sampleDocumentId,
    ).toBeNull();
    expect(server.app.samples.stats.failures).toBe(3);
    // S3 back: the next request seeds and the answer carries the id.
    server.s3.failPuts = false;
    const later = await json<ProfileView>(server, 'GET', '/api/me', { token: dave });
    expect(later.body.sampleDocumentId).toBe(server.repo.sampleOf(daveId));
    expect(later.body.sampleDocumentId).not.toBeNull();
    expect(server.app.samples.stats).toEqual({ seeded: 1, adopted: 0, failures: 3 });
    expect(server.s3.objects.has(`docs/${String(later.body.sampleDocumentId)}/1.yjs`)).toBe(true);
  });

  test('ONB-02 an account whose first request is a shared link still gets its sample: seeding is not tied to the library', async () => {
    const doc = server.repo.seedDocument(bobId, 'from bob');
    server.repo.share(doc.id, aliceId, 'view');
    const dave = server.verifier.issue('tok-dave', 'sub-dave', 'dave@example.com');
    // Dave's first request ever is a document read, not the library.
    const res = await json(server, 'GET', `/api/documents/${doc.id}`, { token: dave });
    expect(res.status).toBe(403);
    const daveId = server.repo.usersBySub.get('sub-dave')!.id;
    expect(server.repo.sampleOf(daveId)).not.toBeNull();
    expect((await listAll(dave, 'recents')).body.documents.map((d) => d.sample)).toEqual([true]);
  });

  test('ONB-01 someone else’s sample shared with me is an ordinary shared row: not flagged, not pinned, my own sample stays first', async () => {
    // The tour's last step invites a person to the sample, so this is the common case.
    const alicesSample = server.repo.sampleOf(aliceId)!;
    const bobsSample = server.repo.sampleOf(bobId)!;
    server.repo.docs.get(alicesSample)!.updatedAt = new Date(Date.now() + 60_000);
    server.repo.share(alicesSample, bobId, 'edit');
    for (const view of ['recents', 'shared'] as const) {
      const rows = (await listAll(bob, view)).body.documents;
      const theirs = rows.find((d) => d.id === alicesSample);
      expect(theirs).toMatchObject({
        sample: false,
        permission: 'edit',
        ownerId: aliceId,
        sharedBy: { id: aliceId },
      });
      if (view === 'recents') {
        expect(rows[0]).toMatchObject({ id: bobsSample, sample: true, permission: 'owner' });
      }
    }
    // Alice still sees it as her sample, pinned and flagged.
    expect((await listAll(alice, 'recents')).body.documents[0]).toMatchObject({
      id: alicesSample,
      sample: true,
    });
    const direct = await json<{ document: DocumentView }>(
      server,
      'GET',
      `/api/documents/${alicesSample}`,
      { token: bob },
    );
    expect(direct.status).toBe(200);
    expect(direct.body.document.sample).toBe(false);
  });
});
