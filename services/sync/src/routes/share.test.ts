/**
 * Sharing routes (SHARE-01, SHARE-02, SHARE-03) over the fake repo, the fake
 * verifier and the fake mailer. Every write is checked for who may call it,
 * for its audit row, and for what a live socket sees.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { INVITE_VALID_DAYS } from '../repo/types.js';
import { json, startServer, WEB_ORIGIN, type TestServer } from '../test/fakes.js';
import { bearerProtocols, YClient } from '../test/y-client.js';
import { CLOSE_FORBIDDEN } from '../ws/route.js';
import type { ProfileView } from './api.js';
import { mintToken, type SharesView } from './share.js';

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
let docId: string;

async function me(token: string): Promise<ProfileView> {
  return (await json<ProfileView>(server, 'GET', '/api/me', { token })).body;
}

function shares(token: string) {
  return json<SharesView>(server, 'GET', `/api/documents/${docId}/shares`, { token });
}

function invite(token: string, email: string, permission: 'view' | 'edit' = 'edit') {
  return json<{ kind: string; shares: SharesView }>(
    server,
    'POST',
    `/api/documents/${docId}/invites`,
    { token, body: { email, permission } },
  );
}

function auditActions(): string[] {
  return server.repo.auditLog.filter((a) => a.documentId === docId).map((a) => a.action);
}

beforeEach(async () => {
  server = await startServer({ RATE_LIMIT_INVITES_PER_HOUR: 3 });
  alice = server.verifier.issue('tok-alice', 'sub-alice', 'alice@example.com');
  bob = server.verifier.issue('tok-bob', 'sub-bob', 'bob@example.com');
  carol = server.verifier.issue('tok-carol', 'sub-carol', 'carol@example.com');
  aliceId = (await me(alice)).id;
  bobId = (await me(bob)).id;
  carolId = (await me(carol)).id;
  await json(server, 'PATCH', '/api/me', { token: alice, body: { displayName: 'Alice A' } });
  docId = server.repo.seedDocument(aliceId, SECRET_TITLE).id;
  server.repo.share(docId, bobId, 'edit');
  server.repo.share(docId, carolId, 'view');
  // Participants list in the order they were added (shares.created_at).
  server.repo.sharesByDoc.get(docId)!.get(carolId)!.createdAt = new Date(Date.now() + 1000);
});

afterEach(async () => {
  await server.close();
});

describe('the sheet (SHARE-01, LIB-07)', () => {
  test('SHARE-01 the owner and editors see emails, pending invitations and the link token; a viewer sees names and the link mode only', async () => {
    await invite(alice, 'new@example.com', 'view');
    await json(server, 'PATCH', `/api/documents/${docId}/link`, {
      token: alice,
      body: { access: 'view' },
    });
    const asOwner = (await shares(alice)).body;
    expect(asOwner.permission).toBe('owner');
    expect(asOwner.invites.map((i) => [i.email, i.permission, i.invitedBy])).toEqual([
      ['new@example.com', 'view', aliceId],
    ]);
    expect(asOwner.linkAccess).toBe('view');
    expect(asOwner.linkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const asEditor = (await shares(bob)).body;
    expect(asEditor.permission).toBe('edit');
    expect(asEditor.linkToken).toBe(asOwner.linkToken);
    expect(asEditor.invites).toHaveLength(1);
    const asViewer = (await shares(carol)).body;
    expect(asViewer.permission).toBe('view');
    expect(asViewer.invites).toEqual([]);
    expect(asViewer.linkToken).toBeNull();
    expect(asViewer.linkAccess).toBe('view');
    expect(JSON.stringify(asViewer)).not.toContain('@example.com');
    expect(JSON.stringify(asViewer)).not.toContain(SECRET_TITLE);
  });
});

describe('invitations (SHARE-02)', () => {
  test('SHARE-02 an address without an account gets an invitation valid 14 days, a share.invite audit row and a share.invite mail carrying the token', async () => {
    const before = Date.now();
    const res = await invite(alice, 'Sembian@Example.com', 'edit');
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('invite');
    const [pending] = res.body.shares.invites;
    expect(pending).toMatchObject({ email: 'Sembian@Example.com', permission: 'edit' });
    const expires = new Date(pending!.expiresAt).getTime();
    expect(expires - before).toBeGreaterThanOrEqual(INVITE_VALID_DAYS * DAY - 1000);
    expect(expires - before).toBeLessThanOrEqual(INVITE_VALID_DAYS * DAY + 5000);
    expect(auditActions()).toEqual(['share.invite']);

    expect(server.mail.sent).toHaveLength(1);
    const mail = server.mail.sent[0]!;
    expect(mail.template).toBe('share.invite');
    expect(mail.to).toBe('Sembian@Example.com');
    expect(mail.from).toBe('no-reply@gede.test');
    expect(mail.replyTo).toBe('alice@example.com');
    expect(mail.subject).toBe('Alice A invited you to a GeDe workscape');
    expect(mail.subject.length).toBeLessThanOrEqual(60);
    const stored = [...server.repo.invitesById.values()][0]!;
    expect(mail.text).toContain(`${WEB_ORIGIN}/d/${docId}?invite=${stored.token}`);
    expect(mail.text).toContain('14 days');
    expect(mail.text).toContain('passkey');
    // The title is named (the invitee is joining it); no cell content ever is.
    expect(mail.text).toContain(SECRET_TITLE);
  });

  test('SHARE-02 an address with an account gets a share at once (share.add) and a share.member mail; inviting them again is 409', async () => {
    const dana = server.repo.seedUser('sub-dana', 'dana@example.com', 'Dana D');
    const res = await invite(bob, 'DANA@example.com', 'view');
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('share');
    const dana2 = server.repo.sharesByDoc.get(docId)!.get(dana.id)!;
    dana2.createdAt = new Date(Date.now() + 2000);
    const listed = (await shares(alice)).body.participants;
    expect(listed.map((p) => [p.userId, p.permission, p.invitedBy])).toEqual([
      [bobId, 'edit', aliceId],
      [carolId, 'view', aliceId],
      [dana.id, 'view', bobId],
    ]);
    expect(res.body.shares.invites).toEqual([]);
    expect(auditActions()).toEqual(['share.add']);
    expect(server.mail.sent.map((m) => m.template)).toEqual(['share.member']);
    expect(server.mail.sent[0]!.subject).toBe(`bob@example.com shared “${SECRET_TITLE}” with you`);
    expect(server.mail.sent[0]!.text).toContain(`${WEB_ORIGIN}/d/${docId}`);
    const again = await invite(bob, 'dana@example.com', 'edit');
    expect(again.status).toBe(409);
    expect(await repoPermission(dana.id)).toBe('view');
    const owner = await invite(bob, 'alice@example.com', 'edit');
    expect(owner.status).toBe(409);
  });

  test('SHARE-02 a refused send (SES sandbox: unverified recipient) withdraws the invitation and answers 502', async () => {
    server.mail.failNextSend = true;
    const res = await json<ErrorBody>(server, 'POST', `/api/documents/${docId}/invites`, {
      token: alice,
      body: { email: 'nobody@example.com', permission: 'view' },
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('unavailable');
    expect((await shares(alice)).body.invites).toEqual([]);
    expect(auditActions()).toEqual(['share.invite', 'share.invite_remove']);
  });

  test('SHARE-03 only the owner and editors may invite; a viewer or a stranger gets 403, and the body is validated', async () => {
    expect((await invite(carol, 'x@example.com')).status).toBe(403);
    const stranger = server.verifier.issue('tok-stranger', 'sub-stranger');
    expect((await invite(stranger, 'x@example.com')).status).toBe(403);
    for (const body of [
      { email: 'not-an-email', permission: 'view' },
      { email: 'x@example.com', permission: 'owner' },
      { email: 'x@example.com' },
      { email: 'x@example.com', permission: 'view', extra: true },
    ]) {
      const res = await json<ErrorBody>(server, 'POST', `/api/documents/${docId}/invites`, {
        token: alice,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(server.mail.sent).toEqual([]);
  });

  test('LOAD-05 invitations have their own per-user bucket (#66): the fourth in an hour is 429 while other routes still answer', async () => {
    for (const n of [1, 2, 3]) {
      expect((await invite(alice, `p${String(n)}@example.com`)).status).toBe(201);
    }
    const fourth = await json<ErrorBody>(server, 'POST', `/api/documents/${docId}/invites`, {
      token: alice,
      body: { email: 'p4@example.com', permission: 'view' },
    });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('too_many_requests');
    expect((await shares(alice)).status).toBe(200);
    // Bob's bucket is his own.
    expect((await invite(bob, 'p5@example.com')).status).toBe(201);
  });

  test('SHARE-02 the owner withdraws a pending invitation; an editor may not', async () => {
    const created = await invite(alice, 'late@example.com');
    const inviteId = created.body.shares.invites[0]!.id;
    expect(
      (
        await json(server, 'DELETE', `/api/documents/${docId}/invites/${inviteId}`, {
          token: bob,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await json(server, 'DELETE', `/api/documents/${docId}/invites/${inviteId}`, {
          token: alice,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await json(server, 'DELETE', `/api/documents/${docId}/invites/${inviteId}`, {
          token: alice,
        })
      ).status,
    ).toBe(404);
    expect(auditActions()).toEqual(['share.invite', 'share.invite_remove']);
  });

  test('SHARE-02 the invitation converts to a share on first sign-in: the ID token binds the verified address through PATCH /api/me', async () => {
    await invite(alice, 'sembian@example.com', 'edit');
    // First sign-in: the access token carries no email (this pool).
    const sembian = server.verifier.issue('tok-sembian', 'sub-sembian');
    const fresh = await me(sembian);
    expect(fresh.email).toBeNull();
    expect((await json(server, 'GET', `/api/documents/${docId}`, { token: sembian })).status).toBe(
      403,
    );
    // A token for another account, or without a verified email, binds nothing.
    server.verifier.issueId('id.other.tok', 'sub-other', 'sembian@example.com');
    server.verifier.issueId('id.noemail.tok', 'sub-sembian', null);
    server.verifier.issueId('id.sembian.tok', 'sub-sembian', 'Sembian@example.com');
    const other = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: sembian,
      body: { idToken: 'id.other.tok' },
    });
    expect(other.status).toBe(403);
    const noEmail = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: sembian,
      body: { idToken: 'id.noemail.tok' },
    });
    expect(noEmail.status).toBe(400);
    const junk = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: sembian,
      body: { idToken: 'not a jwt' },
    });
    expect(junk.status).toBe(400);
    const unknown = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: sembian,
      body: { idToken: 'a.b.c' },
    });
    expect(unknown.status).toBe(400);
    expect(await repoPermission(fresh.id)).toBeUndefined();

    const bound = await json<ProfileView>(server, 'PATCH', '/api/me', {
      token: sembian,
      body: { idToken: 'id.sembian.tok' },
    });
    expect(bound.status).toBe(200);
    expect(bound.body.email).toBe('Sembian@example.com');
    expect((await me(sembian)).email).toBe('Sembian@example.com');
    expect(await repoPermission(fresh.id)).toBe('edit');
    const doc = await json<{ document: { permission: string } }>(
      server,
      'GET',
      `/api/documents/${docId}`,
      { token: sembian },
    );
    expect(doc.status).toBe(200);
    expect(doc.body.document.permission).toBe('edit');
    expect(auditActions()).toEqual(['share.invite', 'share.invite_accept']);
    // The invitation is spent: the sheet no longer lists it.
    expect((await shares(alice)).body.invites).toEqual([]);

    // The same address on a second account is refused (users_email_key).
    const rival = server.verifier.issue('tok-rival', 'sub-rival');
    await me(rival);
    server.verifier.issueId('id.rival.tok', 'sub-rival', 'sembian@example.com');
    const taken = await json<ErrorBody>(server, 'PATCH', '/api/me', {
      token: rival,
      body: { idToken: 'id.rival.tok' },
    });
    expect(taken.status).toBe(409);
  });

  test('SHARE-02 the invitation link accepts for the invited address only; a spent or expired one says so', async () => {
    await invite(alice, 'sembian@example.com', 'view');
    const token = [...server.repo.invitesById.values()][0]!.token;
    const accept = (bearer: string, t: string = token) =>
      json<{ permission: string } & ErrorBody>(
        server,
        'POST',
        `/api/documents/${docId}/invites/accept`,
        { token: bearer, body: { token: t } },
      );
    // Bob holds a different address.
    expect((await accept(bob)).status).toBe(403);
    // An account with no address yet is told to finish signing in.
    const unbound = server.verifier.issue('tok-unbound', 'sub-unbound');
    expect((await accept(unbound)).status).toBe(409);
    // A wrong token is a 404, never a hint.
    expect((await accept(bob, mintToken())).status).toBe(404);
    // The right account: the share appears, the token is spent.
    const sembian = server.verifier.issue('tok-sembian', 'sub-sembian', 'sembian@example.com');
    const sembianId = (await me(sembian)).id;
    // (The access token carried the address: the upsert path converted already — SHARE-02 either way.)
    expect(await repoPermission(sembianId)).toBe('view');
    expect((await accept(sembian)).status).toBe(409);
    // A fresh invitation for someone else, expired: 410.
    await invite(alice, 'late@example.com');
    const late = [...server.repo.invitesById.values()].find((i) => i.email === 'late@example.com')!;
    server.repo.invitesById.set(late.id, { ...late, expiresAt: new Date(Date.now() - 1000) });
    const lateUser = server.verifier.issue('tok-late', 'sub-late', 'late@example.com');
    expect((await accept(lateUser, late.token)).status).toBe(410);
  });
});

describe('participants (SHARE-01, SHARE-03)', () => {
  test('SHARE-01 the owner changes a permission and removes a person, each with an audit row; the person is told by their socket', async () => {
    const bobSocket = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
      protocols: bearerProtocols(bob),
    });
    await bobSocket.synced;
    const carolSocket = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
      protocols: bearerProtocols(carol),
    });
    await carolSocket.synced;

    const changed = await json<SharesView>(
      server,
      'PATCH',
      `/api/documents/${docId}/shares/${bobId}`,
      {
        token: alice,
        body: { permission: 'view' },
      },
    );
    expect(changed.status).toBe(200);
    expect(changed.body.participants.find((p) => p.userId === bobId)?.permission).toBe('view');
    // A changed permission closes the socket with 1001: the provider reconnects and resolves anew.
    expect((await bobSocket.closed).code).toBe(1001);
    const back = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
      protocols: bearerProtocols(bob),
    });
    await back.synced;
    expect(server.app.rooms.get(docId)!.conns.size).toBe(2);

    const removed = await json(server, 'DELETE', `/api/documents/${docId}/shares/${carolId}`, {
      token: alice,
    });
    expect(removed.status).toBe(204);
    expect((await carolSocket.closed).code).toBe(CLOSE_FORBIDDEN);
    expect((await json(server, 'GET', `/api/documents/${docId}`, { token: carol })).status).toBe(
      403,
    );
    expect(
      (await json(server, 'DELETE', `/api/documents/${docId}/shares/${carolId}`, { token: alice }))
        .status,
    ).toBe(404);
    expect(auditActions()).toEqual(['share.permission', 'share.remove']);
    back.close();
  });

  test('SHARE-03 permission changes, removals, link mode and stop sharing are owner-only; the owner cannot be changed or removed', async () => {
    for (const token of [bob, carol]) {
      expect(
        (
          await json(server, 'PATCH', `/api/documents/${docId}/shares/${carolId}`, {
            token,
            body: { permission: 'edit' },
          })
        ).status,
      ).toBe(403);
      expect(
        (await json(server, 'DELETE', `/api/documents/${docId}/shares/${carolId}`, { token }))
          .status,
      ).toBe(403);
      expect(
        (
          await json(server, 'PATCH', `/api/documents/${docId}/link`, {
            token,
            body: { access: 'edit' },
          })
        ).status,
      ).toBe(403);
      expect(
        (await json(server, 'POST', `/api/documents/${docId}/stop-sharing`, { token })).status,
      ).toBe(403);
    }
    expect(
      (
        await json(server, 'PATCH', `/api/documents/${docId}/shares/${aliceId}`, {
          token: alice,
          body: { permission: 'view' },
        })
      ).status,
    ).toBe(409);
    expect(
      (await json(server, 'DELETE', `/api/documents/${docId}/shares/${aliceId}`, { token: alice }))
        .status,
    ).toBe(409);
    expect(auditActions()).toEqual([]);
    expect(await repoPermission(carolId)).toBe('view');
  });

  test('SHARE-01 stop sharing removes everyone and every invitation, turns the link off, and closes their sockets', async () => {
    await invite(alice, 'pending@example.com');
    await json(server, 'PATCH', `/api/documents/${docId}/link`, {
      token: alice,
      body: { access: 'edit' },
    });
    const bobSocket = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
      protocols: bearerProtocols(bob),
    });
    await bobSocket.synced;
    const res = await json<SharesView>(server, 'POST', `/api/documents/${docId}/stop-sharing`, {
      token: alice,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      participants: [],
      invites: [],
      linkAccess: 'none',
      linkToken: null,
    });
    expect((await bobSocket.closed).code).toBe(CLOSE_FORBIDDEN);
    expect((await json(server, 'GET', `/api/documents/${docId}`, { token: bob })).status).toBe(403);
    expect(auditActions()).toEqual(['share.invite', 'share.link', 'share.stop']);
  });
});

describe('link access (SHARE-01)', () => {
  test('SHARE-01 the owner turns the link on, a signed-in stranger redeems it at the link level, and a wrong token is a 404', async () => {
    const on = await json<SharesView>(server, 'PATCH', `/api/documents/${docId}/link`, {
      token: alice,
      body: { access: 'view' },
    });
    expect(on.status).toBe(200);
    const linkToken = on.body.linkToken!;
    expect(linkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const dana = server.verifier.issue('tok-dana', 'sub-dana', 'dana@example.com');
    const danaId = (await me(dana)).id;
    const wrong = await json<ErrorBody>(server, 'POST', `/api/documents/${docId}/link/redeem`, {
      token: dana,
      body: { token: mintToken() },
    });
    expect(wrong.status).toBe(404);
    expect(JSON.stringify(wrong.body)).not.toContain(SECRET_TITLE);
    const junk = await json<ErrorBody>(server, 'POST', `/api/documents/${docId}/link/redeem`, {
      token: dana,
      body: { token: 'short' },
    });
    expect(junk.status).toBe(400);

    const redeemed = await json<{ permission: string }>(
      server,
      'POST',
      `/api/documents/${docId}/link/redeem`,
      { token: dana, body: { token: linkToken } },
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toEqual({ permission: 'view' });
    expect(await repoPermission(danaId)).toBe('view');
    // Now a participant: the sheet lists them with the owner as inviter.
    const listed = (await shares(alice)).body.participants.find((p) => p.userId === danaId);
    expect(listed).toMatchObject({ permission: 'view', invitedBy: aliceId });
    // The owner redeeming their own link stays the owner.
    const owner = await json<{ permission: string }>(
      server,
      'POST',
      `/api/documents/${docId}/link/redeem`,
      { token: alice, body: { token: linkToken } },
    );
    expect(owner.body).toEqual({ permission: 'owner' });
    // Off: the token is gone from the sheet and no longer redeems.
    const off = await json<SharesView>(server, 'PATCH', `/api/documents/${docId}/link`, {
      token: alice,
      body: { access: 'none' },
    });
    expect(off.body.linkToken).toBeNull();
    const eve = server.verifier.issue('tok-eve', 'sub-eve');
    expect(
      (
        await json(server, 'POST', `/api/documents/${docId}/link/redeem`, {
          token: eve,
          body: { token: linkToken },
        })
      ).status,
    ).toBe(404);
    expect(auditActions()).toEqual(['share.link', 'share.link_redeem', 'share.link']);
  });
});

async function repoPermission(userId: string) {
  return server.repo.documents.sharePermission(docId, userId);
}
