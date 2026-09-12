/**
 * Account erasure, `DELETE /api/me` (#111, ADR-038; AUTH-09 partial): what
 * goes, what is handed over, what the tombstone refuses, and the Cognito
 * half behind its flag.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ERASED_DISPLAY_NAME } from '../repo/pg.js';
import { json, startServer, WEB_ORIGIN, type TestServer } from '../test/fakes.js';
import { bearerProtocols, YClient } from '../test/y-client.js';
import { CLOSE_FORBIDDEN, CLOSE_NOT_FOUND } from '../ws/route.js';
import type { DocumentSummaryView, ErasureView, ProfileView } from './api.js';
import type { SharesView } from './share.js';

interface ErrorBody {
  error: { code: string; message: string; ref: string };
}

let server: TestServer;
let alice: string;
let bob: string;
let carol: string;
let aliceId: string;
let bobId: string;
let carolId: string;

async function me(token: string) {
  return json<ProfileView>(server, 'GET', '/api/me', { token });
}

function audits(documentId: string) {
  return server.repo.auditLog.filter((a) => a.documentId === documentId);
}

beforeEach(async () => {
  server = await startServer({ PERSIST_COALESCE_MS: 5 }, { captureLogs: true });
  alice = server.verifier.issue('tok-alice', 'sub-alice', 'alice@example.com');
  bob = server.verifier.issue('tok-bob', 'sub-bob', 'bob@example.com');
  carol = server.verifier.issue('tok-carol', 'sub-carol', 'carol@example.com');
  aliceId = (await me(alice)).body.id;
  bobId = (await me(bob)).body.id;
  carolId = (await me(carol)).body.id;
  await json(server, 'PATCH', '/api/me', {
    token: alice,
    body: { displayName: 'Alice A', locale: 'en-IN' },
  });
});

afterEach(async () => {
  await server.close();
});

describe('DELETE /api/me', () => {
  test('AUTH-09 (partial) the row becomes a tombstone the auth hook refuses; the Cognito user is deleted; a second call is idempotent', async () => {
    const before = await me(alice);
    const res = await json<ErasureView>(server, 'DELETE', '/api/me', { token: alice });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      erased: true,
      identity: 'deleted',
      documentsTransferred: 0,
      documentsDeleted: 1, // the guided sample
    });
    expect(server.identity.deleted).toEqual(['sub-alice']);
    const row = server.repo.userById(aliceId);
    expect(row).toMatchObject({
      email: null,
      displayName: ERASED_DISPLAY_NAME,
      locale: null,
      tourDoneAt: null,
      librarySort: null,
      cognitoSub: 'sub-alice',
    });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    // The still-valid token is refused everywhere, and nothing is re-bound from it.
    const after = await json<ErrorBody>(server, 'GET', '/api/me', { token: alice });
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('account_deleted');
    expect(server.repo.userById(aliceId)?.email).toBeNull();
    const bind = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: alice,
      body: { idToken: server.verifier.issueId('id-alice', 'sub-alice', 'alice@example.com') },
    });
    expect(bind.status).toBe(403);
    expect(server.repo.userById(aliceId)?.email).toBeNull();
    // No new account for the same sub: the tombstone answers.
    expect(
      [...server.repo.usersBySub.values()].filter((u) => u.cognitoSub === 'sub-alice'),
    ).toHaveLength(1);
    const again = await json<ErasureView>(server, 'DELETE', '/api/me', { token: alice });
    expect(again.status).toBe(403);
    // The audit rows keep the actor id, as the retention decision records.
    expect(audits(before.body.sampleDocumentId ?? '').map((a) => a.userId)).toContain(aliceId);
  });

  test('SHARE-01 owned documents go to the earliest editor or into the trash with their shares removed; shares held elsewhere go; sockets close', async () => {
    // Alice owns: `handed` (Bob edit since earlier, Carol edit later, Dana view),
    // `binned` (Carol view only), and her sample. She holds a share on Bob's `theirs`.
    const handed = server.repo.seedDocument(aliceId, 'handed');
    server.repo.share(handed.id, carolId, 'edit');
    server.repo.share(handed.id, bobId, 'edit');
    server.repo.sharesByDoc.get(handed.id)!.get(bobId)!.createdAt = new Date(Date.now() - 60_000);
    const dana = server.verifier.issue('tok-dana', 'sub-dana', 'dana@example.com');
    const danaId = (await me(dana)).body.id;
    server.repo.share(handed.id, danaId, 'view');
    const binned = server.repo.seedDocument(aliceId, 'binned');
    server.repo.share(binned.id, carolId, 'view');
    await json(server, 'PATCH', `/api/documents/${binned.id}/link`, {
      token: alice,
      body: { access: 'view' },
    });
    const theirs = server.repo.seedDocument(bobId, 'theirs');
    server.repo.share(theirs.id, aliceId, 'edit');
    // A pending invitation she sent, and one sent to her.
    await json(server, 'POST', `/api/documents/${handed.id}/invites`, {
      token: alice,
      body: { email: 'erin@example.com', permission: 'view' },
    });
    await json(server, 'POST', `/api/documents/${theirs.id}/invites`, {
      token: bob,
      body: { email: 'frank@example.com', permission: 'view' },
    });
    await server.repo.invites.create({
      documentId: theirs.id,
      email: 'alice@example.com',
      permission: 'view',
      token: 'tok-to-alice-0000000000000000',
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedBy: bobId,
    });
    // Alice is editing `handed`; Carol is on `binned`; Bob is on `handed`.
    const aliceSocket = await YClient.connect(`${server.wsUrl}/ws/${handed.id}`, WEB_ORIGIN, {
      protocols: bearerProtocols(alice),
    });
    const carolSocket = await YClient.connect(`${server.wsUrl}/ws/${binned.id}`, WEB_ORIGIN, {
      protocols: bearerProtocols(carol),
    });
    const bobSocket = await YClient.connect(`${server.wsUrl}/ws/${handed.id}`, WEB_ORIGIN, {
      protocols: bearerProtocols(bob),
    });
    await Promise.all([aliceSocket.synced, carolSocket.synced, bobSocket.synced]);
    aliceSocket.setCell('r1:c1', 'by alice');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.repo.updatesByDoc.get(handed.id)?.map((u) => u.authorId)).toEqual([aliceId]);

    const res = await json<ErasureView>(server, 'DELETE', '/api/me', { token: alice });
    expect(res.body).toMatchObject({ erased: true, documentsTransferred: 1, documentsDeleted: 2 });

    // `handed`: Bob (the earliest editor) owns it; Carol and Dana stay, invited by Bob now.
    const handedRow = await server.repo.documents.get(handed.id);
    expect(handedRow).toMatchObject({ ownerId: bobId, deletedAt: null, everShared: true });
    expect(server.repo.sharesByDoc.get(handed.id)?.has(bobId)).toBe(false);
    expect(server.repo.sharesByDoc.get(handed.id)?.get(carolId)).toMatchObject({
      permission: 'edit',
      invitedBy: bobId,
    });
    expect(server.repo.sharesByDoc.get(handed.id)?.get(danaId)).toMatchObject({
      permission: 'view',
      invitedBy: bobId,
    });
    expect(audits(handed.id).map((a) => a.action)).toContain('document.transfer');
    const asBob = await json<{ document: DocumentSummaryView }>(
      server,
      'GET',
      `/api/documents/${handed.id}`,
      { token: bob },
    );
    expect(asBob.body.document.permission).toBe('owner');
    // Bob's socket was admitted as an editor: told to reconnect as the owner.
    expect((await bobSocket.closed).code).toBe(1001);
    // The invitation Alice sent is withdrawn; the one sent to her is gone.
    expect(
      [...server.repo.invitesById.values()].filter((i) => i.email === 'erin@example.com'),
    ).toEqual([]);
    expect(
      [...server.repo.invitesById.values()].filter((i) => i.email === 'alice@example.com'),
    ).toEqual([]);
    // Bob's own invitation to Frank stands.
    expect(
      [...server.repo.invitesById.values()].filter((i) => i.email === 'frank@example.com'),
    ).toHaveLength(1);

    // `binned`: no editor to take it — shares removed, link off, in the trash; Carol's socket 4404.
    const binnedRow = await server.repo.documents.get(binned.id);
    expect(binnedRow).toMatchObject({ everShared: false, linkAccess: 'none', linkToken: null });
    expect(binnedRow?.deletedAt).toBeInstanceOf(Date);
    expect(server.repo.sharesByDoc.get(binned.id)?.size ?? 0).toBe(0);
    expect((await carolSocket.closed).code).toBe(CLOSE_NOT_FOUND);
    expect(audits(binned.id).map((a) => a.action)).toEqual(
      expect.arrayContaining(['share.stop', 'document.delete']),
    );
    // Her sample went the same way, sample flag cleared so it can be purged later.
    const sample = [...server.repo.docs.values()].find(
      (d) => d.ownerId === aliceId && d.title.includes('Guided sample'),
    );
    expect(sample).toMatchObject({ sample: false });
    expect(sample?.deletedAt).toBeInstanceOf(Date);

    // Her share on Bob's document is gone (audited), and her sockets closed 4403.
    expect(server.repo.sharesByDoc.get(theirs.id)?.has(aliceId)).toBe(false);
    expect(audits(theirs.id).map((a) => a.action)).toContain('share.remove');
    expect((await aliceSocket.closed).code).toBe(CLOSE_FORBIDDEN);
    // Her edits are no longer attributable; the share sheet shows the tombstone name.
    expect(server.repo.updatesByDoc.get(handed.id)?.map((u) => u.authorId)).toEqual([null]);
    const sheet = await json<SharesView>(server, 'GET', `/api/documents/${handed.id}/shares`, {
      token: bob,
    });
    expect(JSON.stringify(sheet.body)).not.toContain('alice@example.com');
    // And her address is scrubbed from every audit target that carried it.
    expect(server.repo.auditLog.some((a) => a.target?.includes('alice@example.com'))).toBe(false);
    expect(server.repo.auditLog.some((a) => a.target?.includes('[erased]'))).toBe(true);
  });

  test('AUTH-09 (partial) without the identity store the erasure still happens and answers skipped; a Cognito failure answers failed with a GeDe/Sync datapoint', async () => {
    await server.close();
    server = await startServer({}, { withoutIdentity: true, captureLogs: true });
    alice = server.verifier.issue('tok-alice', 'sub-alice', 'alice@example.com');
    aliceId = (await me(alice)).body.id;
    const skipped = await json<ErasureView>(server, 'DELETE', '/api/me', { token: alice });
    expect(skipped.body.identity).toBe('skipped');
    expect(server.repo.userById(aliceId)?.deletedAt).toBeInstanceOf(Date);
    expect((await me(alice)).status).toBe(403);

    await server.close();
    server = await startServer({}, { captureLogs: true });
    bob = server.verifier.issue('tok-bob', 'sub-bob', 'bob@example.com');
    bobId = (await me(bob)).body.id;
    server.identity.failNextDelete = true;
    const failed = await json<ErasureView>(server, 'DELETE', '/api/me', { token: bob });
    expect(failed.status).toBe(200);
    expect(failed.body.identity).toBe('failed');
    expect(server.repo.userById(bobId)?.deletedAt).toBeInstanceOf(Date);
    const line = server.logs.find((l) => 'UserErasureIdentityFailures' in l);
    expect(line).toMatchObject({ Reason: 'identity_delete_failed', userId: bobId });
    expect(line?._aws).toMatchObject({
      CloudWatchMetrics: [{ Namespace: 'GeDe/Sync' }],
    });
  });
});
