/**
 * Library (LIB-01, LIB-02, LIB-07, LIB-08), profile (AUTH-09, I18N-05) and
 * the non-participant rule (SHARE-03: the title is never revealed) over the
 * fake repo. Every route is exercised for its happy path, 401, 403 and 400.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { json, startServer, type TestServer } from '../test/fakes.js';
import type { DocumentSummaryView, DocumentView, ParticipantsView, ProfileView } from './api.js';

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

function list(token: string, view?: string) {
  const path = view === undefined ? '/api/documents' : `/api/documents?view=${view}`;
  return json<{ documents: DocumentSummaryView[] }>(server, 'GET', path, { token });
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

  test('SHARE-03 only the owner may recover; an editor gets 403 and never the title', async () => {
    const doc = server.repo.seedDocument(aliceId, SECRET_TITLE);
    server.repo.share(doc.id, bobId, 'edit');
    await server.repo.documents.softDelete(doc.id);
    const res = await json<ErrorBody>(server, 'POST', `/api/documents/${doc.id}/recover`, {
      token: bob,
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TITLE);
    expect(server.repo.docs.get(doc.id)?.deletedAt).not.toBeNull();
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

    const res = await json<{ recovered: number }>(server, 'POST', '/api/documents/recover-all', {
      token: alice,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recovered: 2 });
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
    expect(again.body).toEqual({ recovered: 0 });
  });

  test('LIB-08 delete-all permanently removes rows, shares, updates, snapshots and S3 objects, and audits each', async () => {
    const doomed = server.repo.seedDocument(aliceId, 'doomed');
    server.repo.share(doomed.id, bobId, 'edit');
    await server.repo.updates.append(doomed.id, [
      { update: new Uint8Array([1, 2, 3]), authorId: aliceId },
    ]);
    await server.s3.put(`docs/${doomed.id}/1.yjs`, new Uint8Array([9]));
    await server.repo.updates.commitSnapshot({
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
    expect([...server.s3.objects.keys()]).toEqual([`docs/${live.id}/1.yjs`]);
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
    expect(recovered.body).toEqual({ recovered: 0 });
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
        },
        { userId: carolId, name: null, email: null, permission: 'view', invitedBy: bobId },
      ],
      linkAccess: 'none',
    });
    expect(res.body.participants.some((p) => p.userId === aliceId)).toBe(false);
  });

  test('LIB-07 any participant may read the sheet; a view-only one included', async () => {
    const doc = server.repo.seedDocument(aliceId, 'team');
    server.repo.share(doc.id, carolId, 'view');
    const res = await json<ParticipantsView>(server, 'GET', `/api/documents/${doc.id}/shares`, {
      token: carol,
    });
    expect(res.status).toBe(200);
    expect(res.body.owner.id).toBe(aliceId);
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
    });
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

  test('AUTH-09 PATCH /api/me needs a token', async () => {
    const res = await json<ErrorBody>(server, 'PATCH', '/api/me', { body: { locale: 'en-GB' } });
    expect(res.status).toBe(401);
  });
});
