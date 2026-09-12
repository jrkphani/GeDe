import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { json, startServer, WEB_ORIGIN, type TestServer } from '../test/fakes.js';
import { sleep, waitFor, YClient } from '../test/y-client.js';
import { MESSAGE_SYNC } from './protocol.js';
import { CLOSE_FORBIDDEN, CLOSE_NOT_FOUND, CLOSE_UNAUTHENTICATED } from './route.js';

let server: TestServer;
let ownerToken: string;
let editorToken: string;
let viewerToken: string;
let docId: string;
const clients: YClient[] = [];

async function userId(token: string): Promise<string> {
  const res = await json<{ id: string }>(server, 'GET', '/api/me', { token });
  return res.body.id;
}

async function connect(
  token: string,
  id = docId,
  origin: string | undefined = WEB_ORIGIN,
): Promise<YClient> {
  const client = await YClient.connect(`${server.wsUrl}/ws/${id}?token=${token}`, origin);
  clients.push(client);
  return client;
}

beforeEach(async () => {
  server = await startServer();
  ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
  editorToken = server.verifier.issue('tok-editor', 'sub-editor');
  viewerToken = server.verifier.issue('tok-viewer', 'sub-viewer');
  const owner = await userId(ownerToken);
  docId = server.repo.seedDocument(owner, 'shared doc').id;
  server.repo.share(docId, await userId(editorToken), 'edit');
  server.repo.share(docId, await userId(viewerToken), 'view');
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

describe('upgrade authorisation', () => {
  test('AUTH-01 a missing or invalid token closes with 4401 before any document data', async () => {
    const noToken = new YClient(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN);
    expect((await noToken.closed).code).toBe(CLOSE_UNAUTHENTICATED);
    expect(noToken.received).toEqual([]);

    const bad = new YClient(`${server.wsUrl}/ws/${docId}?token=forged`, WEB_ORIGIN);
    expect((await bad.closed).code).toBe(CLOSE_UNAUTHENTICATED);
    expect(bad.received).toEqual([]);
  });

  test('SHARE-03 a signed-in non-participant closes with 4403; an unknown document with 4404', async () => {
    const stranger = server.verifier.issue('tok-stranger', 'sub-stranger');
    const forbidden = new YClient(`${server.wsUrl}/ws/${docId}?token=${stranger}`, WEB_ORIGIN);
    expect((await forbidden.closed).code).toBe(CLOSE_FORBIDDEN);

    const missing = new YClient(
      `${server.wsUrl}/ws/${crypto.randomUUID()}?token=${ownerToken}`,
      WEB_ORIGIN,
    );
    expect((await missing.closed).code).toBe(CLOSE_NOT_FOUND);
  });

  test('AUTH-01 a wrong or missing Origin is refused', async () => {
    const wrong = new YClient(
      `${server.wsUrl}/ws/${docId}?token=${ownerToken}`,
      'https://evil.example',
    );
    expect((await wrong.closed).code).toBe(CLOSE_FORBIDDEN);
    const none = new YClient(`${server.wsUrl}/ws/${docId}?token=${ownerToken}`, undefined);
    expect((await none.closed).code).toBe(CLOSE_FORBIDDEN);
  });

  test('SHARE-03 a deleted document is not served, even to its owner', async () => {
    await server.repo.documents.softDelete(docId);
    const gone = new YClient(`${server.wsUrl}/ws/${docId}?token=${ownerToken}`, WEB_ORIGIN);
    expect((await gone.closed).code).toBe(CLOSE_NOT_FOUND);
  });
});

describe('sync protocol', () => {
  test('LOAD-05 the y-websocket handshake completes: server sends step 1, answers step 1 with step 2', async () => {
    const client = await connect(ownerToken);
    await client.synced;
    // First message from the server is sync step 1 (type 0, subtype 0).
    const first = client.received[0];
    expect(first?.[0]).toBe(MESSAGE_SYNC);
    expect(first?.[1]).toBe(syncProtocol.messageYjsSyncStep1);
    expect(server.app.rooms.get(docId)?.size).toBe(1);
  });

  test('LOAD-05 an edit client’s update reaches a second client through the room', async () => {
    const a = await connect(ownerToken);
    const b = await connect(editorToken);
    await Promise.all([a.synced, b.synced]);

    a.setCell('r1:c1', 'hello');
    await waitFor(() => b.cell('r1:c1') === 'hello');

    b.setCell('r1:c2', 'world');
    await waitFor(() => a.cell('r1:c2') === 'world');
    expect(server.app.rooms.get(docId)?.stats.droppedUpdates).toBe(0);
  });

  test('LOAD-06 a client connecting later receives the full state in sync step 2', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    a.setCell('r1:c1', 'before');
    await waitFor(
      () => server.app.rooms.get(docId)?.doc.getMap<string>('cells').get('r1:c1') === 'before',
    );

    const late = await connect(editorToken);
    await late.synced;
    expect(late.cell('r1:c1')).toBe('before');
  });

  test('SHARE-03 a view-only client receives the stream but its updates are dropped and counted', async () => {
    const editor = await connect(ownerToken);
    const viewer = await connect(viewerToken);
    await Promise.all([editor.synced, viewer.synced]);

    editor.setCell('r1:c1', 'from editor');
    await waitFor(() => viewer.cell('r1:c1') === 'from editor');

    // The viewer's local replica may change (LOAD-05: typing is never blocked), but the server rejects it.
    viewer.setCell('r1:c1', 'viewer tried');
    viewer.setCell('r2:c1', 'and again');
    await waitFor(() => (server.app.rooms.get(docId)?.stats.droppedUpdates ?? 0) >= 2);
    await sleep(30);

    expect(editor.cell('r1:c1')).toBe('from editor');
    expect(editor.cell('r2:c1')).toBeUndefined();
    expect(server.app.rooms.get(docId)?.doc.getMap<string>('cells').get('r1:c1')).toBe(
      'from editor',
    );
    const room = server.app.rooms.get(docId);
    await room?.persistence.flush();
    expect(server.repo.updatesByDoc.get(docId)?.length ?? 0).toBe(1);
  });

  test('SHARE-03 a forged sync step 2 from a viewer is dropped too', async () => {
    const editor = await connect(ownerToken);
    const viewer = await connect(viewerToken);
    await Promise.all([editor.synced, viewer.synced]);

    const forged = new Y.Doc();
    forged.getMap<string>('cells').set('r9:c9', 'injected');
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep2(encoder, forged);
    viewer.send(encoding.toUint8Array(encoder));

    await waitFor(() => (server.app.rooms.get(docId)?.stats.droppedUpdates ?? 0) >= 1);
    await sleep(30);
    expect(editor.cell('r9:c9')).toBeUndefined();
  });

  test('SHARE-04 awareness is relayed to every socket and cleared when a socket leaves', async () => {
    const a = await connect(ownerToken);
    const b = await connect(viewerToken);
    await Promise.all([a.synced, b.synced]);

    a.awareness.setLocalState({ user: { name: 'Ada' }, cell: 'B2' });
    await waitFor(() => b.awareness.getStates().size === 2);
    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({
      user: { name: 'Ada' },
      cell: 'B2',
    });

    a.close();
    await waitFor(() => b.awareness.getStates().size === 1);
  });

  test('SHARE-04 an oversized awareness update is dropped', async () => {
    const a = await connect(ownerToken);
    const b = await connect(viewerToken);
    await Promise.all([a.synced, b.synced]);
    a.awareness.setLocalState({ blob: 'x'.repeat(5000) });
    await waitFor(() => (server.app.rooms.get(docId)?.stats.droppedAwareness ?? 0) === 1);
    expect(b.awareness.getStates().size).toBe(1);
  });
});

describe('persistence', () => {
  test('LOAD-06 every accepted update is appended to doc_updates with increasing seq', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    a.setCell('r1:c1', 'one');
    a.setCell('r1:c2', 'two');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 2);
    const seqs = server.repo.updatesByDoc.get(docId)?.map((u) => u.seq);
    expect(seqs).toEqual([1, 2]);
  });

  test('LOAD-06 compaction after N=3 updates writes a snapshot to S3, records it, and prunes the log', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    a.setCell('r1:c1', '1');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);
    a.setCell('r1:c2', '2');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 2);
    a.setCell('r1:c3', '3');
    await waitFor(() => server.s3.puts === 1);
    await waitFor(() => server.repo.snapshotsByDoc.get(docId)?.length === 1);

    const snapshot = server.repo.snapshotsByDoc.get(docId)?.[0];
    expect(snapshot).toMatchObject({ seq: 3, s3Key: `docs/${docId}/3.yjs` });
    expect(server.repo.docs.get(docId)).toMatchObject({
      snapshotSeq: 3,
      snapshotKey: `docs/${docId}/3.yjs`,
    });
    expect(server.repo.updatesByDoc.get(docId)).toEqual([]);

    // The snapshot is a complete Yjs state.
    const restored = new Y.Doc();
    Y.applyUpdate(restored, server.s3.objects.get(`docs/${docId}/3.yjs`) ?? new Uint8Array());
    expect(restored.getMap<string>('cells').toJSON()).toEqual({
      'r1:c1': '1',
      'r1:c2': '2',
      'r1:c3': '3',
    });

    // Further updates continue the sequence after the snapshot.
    a.setCell('r2:c1', '4');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);
    expect(server.repo.updatesByDoc.get(docId)?.[0]?.seq).toBe(4);
  });

  test('LOAD-06 a cold room loads the snapshot and replays the log tail', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    for (const n of ['1', '2', '3', '4']) {
      a.setCell(`r${n}:c1`, n);
      await sleep(25);
    }
    await waitFor(() => server.repo.docs.get(docId)?.snapshotSeq === 3);
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);

    const room = server.app.rooms.get(docId);
    if (!room) throw new Error('room missing');
    a.close();
    await room.persistence.flush();
    await server.app.rooms.evict(room);
    expect(server.app.rooms.get(docId)).toBeUndefined();

    const b = await connect(editorToken);
    await b.synced;
    expect(b.doc.getMap<string>('cells').toJSON()).toEqual({
      'r1:c1': '1',
      'r2:c1': '2',
      'r3:c1': '3',
      'r4:c1': '4',
    });
  });

  test('LOAD-06 a failed append is retried, nothing is lost', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    server.repo.failNextAppend = true;
    a.setCell('r1:c1', 'kept');
    await waitFor(() => server.repo.appendCalls === 1);
    expect(server.repo.updatesByDoc.get(docId) ?? []).toEqual([]);
    await server.app.rooms.get(docId)?.persistence.flush(); // the retry
    expect(server.repo.updatesByDoc.get(docId)?.length).toBe(1);
    expect(server.app.rooms.get(docId)?.persistence.stats.flushFailures).toBe(1);
  });

  test('LOAD-06 eviction after the last socket leaves does a final compaction and frees the room', async () => {
    await server.close();
    server = await startServer({ ROOM_IDLE_MS: 50 });
    ownerToken = server.verifier.issue('tok-owner2', 'sub-owner2');
    docId = server.repo.seedDocument(await userId(ownerToken), 'evict me').id;

    const a = await connect(ownerToken);
    await a.synced;
    a.setCell('r1:c1', 'x');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);
    a.close();
    await waitFor(() => server.app.rooms.get(docId) === undefined, { timeoutMs: 2000 });
    await waitFor(() => server.repo.snapshotsByDoc.get(docId)?.length === 1);
    expect(server.repo.updatesByDoc.get(docId)).toEqual([]);
  });

  test('LOAD-06 shutdown flushes pending updates, snapshots, and closes sockets with 1001', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    a.setCell('r1:c1', 'pending');
    // Do not wait for the coalescing window; close immediately.
    await server.close();
    expect((await a.closed).code).toBe(1001);
    // Flushed to the log (seq 1), then the shutdown snapshot covered it and pruned the log.
    expect(server.repo.snapshotsByDoc.get(docId)?.map((s) => s.seq)).toEqual([1]);
    expect(server.repo.docs.get(docId)?.snapshotSeq).toBe(1);
    expect(server.s3.objects.has(`docs/${docId}/1.yjs`)).toBe(true);
    expect(server.repo.updatesByDoc.get(docId)).toEqual([]);
    server = await startServer(); // afterEach closes this one
  });
});

describe('load failures', () => {
  test('LOAD-06 a missing snapshot object refuses the room with 1011 and does not poison later joins', async () => {
    const doc = server.repo.docs.get(docId);
    if (!doc) throw new Error('doc');
    doc.snapshotKey = 'docs/missing.yjs';
    doc.snapshotSeq = 5;

    const a = new YClient(`${server.wsUrl}/ws/${docId}?token=${ownerToken}`, WEB_ORIGIN);
    expect((await a.closed).code).toBe(1011);
    await waitFor(() => server.app.rooms.get(docId) === undefined);

    server.s3.objects.set('docs/missing.yjs', Y.encodeStateAsUpdate(new Y.Doc()));
    const b = await connect(ownerToken);
    await b.synced;
    expect(server.app.rooms.get(docId)?.size).toBe(1);
  });
});
