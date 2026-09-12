import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { json, startServer, type TestServer } from '../test/fakes.js';
import type { DocumentView } from './api.js';

interface ErrorBody {
  error: { code: string; message: string; ref: string };
}

let server: TestServer;
let alice: string;
let bob: string;

beforeEach(async () => {
  server = await startServer();
  alice = server.verifier.issue('tok-alice', 'sub-alice', 'alice@example.com');
  bob = server.verifier.issue('tok-bob', 'sub-bob');
});

afterEach(async () => {
  await server.close();
});

describe('GET /healthz', () => {
  test('LOAD-05 answers ok with the version and no auth', async () => {
    const res = await json<{ ok: boolean; version: string }>(server, 'GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 'test' });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}$/);
  });

  test('LOAD-05 answers 503 when SELECT 1 fails so ECS restarts the task', async () => {
    server.repo.down = true;
    const res = await json<{ ok: boolean }>(server, 'GET', '/healthz');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  test('503 page polls /api/health through CloudFront without a bearer token', async () => {
    const res = await json<{ ok: boolean; version: string }>(server, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 'test' });
  });
});

describe('auth hook', () => {
  test('AUTH-01 rejects a missing bearer token with the error contract', async () => {
    const res = await json<ErrorBody>(server, 'GET', '/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
    expect(res.body.error.message).toBe('Your session ended');
    expect(res.body.error.ref).toBe(res.headers.get('x-request-id'));
  });

  test('AUTH-01 rejects an invalid token', async () => {
    const res = await json<ErrorBody>(server, 'GET', '/api/me', { token: 'forged' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  test('AUTH-01 rejects a malformed Authorization header', async () => {
    const response = await fetch(`${server.baseUrl}/api/me`, {
      headers: { authorization: `Basic ${alice}` },
    });
    expect(response.status).toBe(401);
  });

  test('AUTH-01 creates the users row on first sight of a sub and returns it from /api/me', async () => {
    expect(server.repo.usersBySub.size).toBe(0);
    const res = await json<{ id: string; sub: string; email: string | null }>(
      server,
      'GET',
      '/api/me',
      {
        token: alice,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.sub).toBe('sub-alice');
    expect(res.body.email).toBe('alice@example.com');
    expect(server.repo.usersBySub.get('sub-alice')?.id).toBe(res.body.id);

    const bobMe = await json<{ email: string | null }>(server, 'GET', '/api/me', { token: bob });
    expect(bobMe.body.email).toBeNull();
  });
});

describe('documents', () => {
  test('LOAD-05 POST creates an Untitled document owned by the caller and writes an audit row', async () => {
    const res = await json<{ document: DocumentView }>(server, 'POST', '/api/documents', {
      token: alice,
    });
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({
      title: 'Untitled',
      permission: 'owner',
      deletedAt: null,
    });
    expect(server.repo.auditLog).toEqual([
      expect.objectContaining({ documentId: res.body.document.id, action: 'document.create' }),
    ]);
  });

  test('LOAD-05 POST accepts a title and rejects an invalid body', async () => {
    const ok = await json<{ document: DocumentView }>(server, 'POST', '/api/documents', {
      token: alice,
      body: { title: '  Q3 plan  ' },
    });
    expect(ok.body.document.title).toBe('Q3 plan');

    const bad = await json<ErrorBody>(server, 'POST', '/api/documents', {
      token: alice,
      body: { title: '' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_request');

    const unknownField = await json<ErrorBody>(server, 'POST', '/api/documents', {
      token: alice,
      body: { name: 'x' },
    });
    expect(unknownField.status).toBe(400);
  });

  test('SHARE-03 GET lists owned and shared documents with permission, newest first, excluding deleted', async () => {
    const me = await json<{ id: string }>(server, 'GET', '/api/me', { token: alice });
    const bobMe = await json<{ id: string }>(server, 'GET', '/api/me', { token: bob });
    const older = server.repo.seedDocument(me.body.id, 'older');
    const shared = server.repo.seedDocument(bobMe.body.id, 'bob shares this');
    server.repo.share(shared.id, me.body.id, 'view');
    const notShared = server.repo.seedDocument(bobMe.body.id, 'private to bob');
    const deleted = server.repo.seedDocument(me.body.id, 'gone');
    await server.repo.documents.softDelete(deleted.id);
    await new Promise((r) => setTimeout(r, 2));
    const newer = await json<{ document: DocumentView }>(server, 'POST', '/api/documents', {
      token: alice,
      body: { title: 'newer' },
    });

    const res = await json<{ documents: DocumentView[] }>(server, 'GET', '/api/documents', {
      token: alice,
    });
    expect(res.status).toBe(200);
    const ids = res.body.documents.map((d) => d.id);
    expect(ids[0]).toBe(newer.body.document.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(shared.id);
    expect(ids).not.toContain(notShared.id);
    expect(ids).not.toContain(deleted.id);
    expect(res.body.documents.find((d) => d.id === shared.id)?.permission).toBe('view');
    expect(res.body.documents.find((d) => d.id === older.id)?.permission).toBe('owner');

    const bin = await json<{ documents: DocumentView[] }>(
      server,
      'GET',
      '/api/documents?view=deleted',
      {
        token: alice,
      },
    );
    expect(bin.body.documents.map((d) => d.id)).toEqual([deleted.id]);
  });

  test('SHARE-03 PATCH renames for owner and edit participants, 403 for view, 404 for strangers-of-nothing', async () => {
    const me = await json<{ id: string }>(server, 'GET', '/api/me', { token: alice });
    const bobMe = await json<{ id: string }>(server, 'GET', '/api/me', { token: bob });
    const doc = server.repo.seedDocument(me.body.id, 'draft');

    const asViewer = await json<ErrorBody>(server, 'PATCH', `/api/documents/${doc.id}`, {
      token: bob,
      body: { title: 'x' },
    });
    expect(asViewer.status).toBe(403);
    expect(asViewer.body.error.message).toBe('You do not have access to this workscape');

    server.repo.share(doc.id, bobMe.body.id, 'view');
    const stillViewer = await json<ErrorBody>(server, 'PATCH', `/api/documents/${doc.id}`, {
      token: bob,
      body: { title: 'x' },
    });
    expect(stillViewer.status).toBe(403);

    server.repo.share(doc.id, bobMe.body.id, 'edit');
    const asEditor = await json<{ document: DocumentView }>(
      server,
      'PATCH',
      `/api/documents/${doc.id}`,
      {
        token: bob,
        body: { title: 'renamed by bob' },
      },
    );
    expect(asEditor.status).toBe(200);
    expect(asEditor.body.document).toMatchObject({ title: 'renamed by bob', permission: 'edit' });

    const missing = await json<ErrorBody>(
      server,
      'PATCH',
      `/api/documents/${crypto.randomUUID()}`,
      {
        token: alice,
        body: { title: 'x' },
      },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('Nothing at this address');

    const malformed = await json<ErrorBody>(server, 'PATCH', '/api/documents/not-a-uuid', {
      token: alice,
      body: { title: 'x' },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toBe('That link is not a workscape');
  });

  test('SHARE-03 DELETE soft-deletes for the owner only and hides the document from participants', async () => {
    const me = await json<{ id: string }>(server, 'GET', '/api/me', { token: alice });
    const bobMe = await json<{ id: string }>(server, 'GET', '/api/me', { token: bob });
    const doc = server.repo.seedDocument(me.body.id, 'to delete');
    server.repo.share(doc.id, bobMe.body.id, 'edit');

    const asEditor = await json<ErrorBody>(server, 'DELETE', `/api/documents/${doc.id}`, {
      token: bob,
    });
    expect(asEditor.status).toBe(403);

    const asOwner = await json<null>(server, 'DELETE', `/api/documents/${doc.id}`, {
      token: alice,
    });
    expect(asOwner.status).toBe(204);
    expect(server.repo.docs.get(doc.id)?.deletedAt).not.toBeNull();
    expect(server.repo.auditLog.at(-1)).toMatchObject({
      action: 'document.delete',
      documentId: doc.id,
    });

    const again = await json<ErrorBody>(server, 'DELETE', `/api/documents/${doc.id}`, {
      token: alice,
    });
    expect(again.status).toBe(404);

    const bobSees = await json<ErrorBody>(server, 'GET', `/api/documents/${doc.id}`, {
      token: bob,
    });
    expect(bobSees.status).toBe(403);
    const ownerSees = await json<{ document: DocumentView }>(
      server,
      'GET',
      `/api/documents/${doc.id}`,
      {
        token: alice,
      },
    );
    expect(ownerSees.status).toBe(200);
    expect(ownerSees.body.document.deletedAt).not.toBeNull();
  });

  test('LOAD-05 unknown routes use the error contract too', async () => {
    const res = await json<ErrorBody>(server, 'GET', '/api/nothing', { token: alice });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Nothing at this address' });
  });

  test('LOAD-05 CORS allows only the web origin', async () => {
    const allowed = await fetch(`${server.baseUrl}/api/me`, {
      method: 'OPTIONS',
      headers: {
        origin: server.config.WEB_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(server.config.WEB_ORIGIN);

    const denied = await fetch(`${server.baseUrl}/api/me`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    // @fastify/cors always answers with the configured origin; the browser
    // rejects the response because it does not match the page's origin.
    expect(denied.headers.get('access-control-allow-origin')).toBe(server.config.WEB_ORIGIN);
    expect(denied.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});
