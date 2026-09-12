/**
 * Final red team, WebSocket findings: memory exhaustion by one authenticated
 * user (#99), permission frozen at upgrade (#104), malformed updates
 * swallowed by y-protocols (#105). Every refusal is asserted twice: as the
 * close code the client sees, and as the `GeDe/Sync` embedded-metric line the
 * operator sees.
 */
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { METRIC_NAMESPACE, type CountLine, type RefusalReason } from '../metrics.js';
import { json, startServer, WEB_ORIGIN, type LogLine, type TestServer } from '../test/fakes.js';
import { bearerProtocols, sleep, waitFor, YClient } from '../test/y-client.js';
import { MESSAGE_SYNC } from './protocol.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_MALFORMED,
  CLOSE_MESSAGE_TOO_BIG,
  CLOSE_NOT_FOUND,
  CLOSE_TOO_LARGE,
  CLOSE_TOO_MANY_REQUESTS,
  CLOSE_TRY_AGAIN_LATER,
} from './route.js';

/** The reviewer's frame: one valid Yjs update of 15,728,667 bytes. */
const REVIEWER_UPDATE_BYTES = 15_728_667;

let server: TestServer;
let ownerToken: string;
let ownerId: string;
let docId: string;
const clients: YClient[] = [];

async function userId(token: string): Promise<string> {
  const res = await json<{ id: string }>(server, 'GET', '/api/me', { token });
  return res.body.id;
}

async function connect(token: string, id = docId): Promise<YClient> {
  const client = await YClient.connect(`${server.wsUrl}/ws/${id}`, WEB_ORIGIN, {
    protocols: bearerProtocols(token),
  });
  clients.push(client);
  return client;
}

/** A type-0 sync frame carrying `payload` as a step 2 or an update, exactly as a provider frames it. */
function syncFrame(subtype: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/** One valid Yjs update inserting `bytes` characters into a text; its encoded size is a little over `bytes`. */
function bigUpdate(bytes: number): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, 'x'.repeat(bytes));
  return Y.encodeStateAsUpdate(doc);
}

function refusals(logs: LogLine[]): (LogLine & CountLine)[] {
  return logs.filter((line): line is LogLine & CountLine => 'WsRefusals' in line);
}

function refusalReasons(logs: LogLine[]): RefusalReason[] {
  return refusals(logs).map((line) => line.Reason);
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

describe('bytes per frame, per document and per second (#99)', () => {
  beforeEach(async () => {
    server = await startServer({ PERSIST_COALESCE_MS: 5 }, { captureLogs: true });
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'exhaustion').id;
  });

  test('LOAD-05 SHARE-03 the reviewer’s 15.7 MB update is refused on its frame length (1009) before anything is applied, persisted or fanned out', async () => {
    const editor = await connect(ownerToken);
    const viewer = await connect(ownerToken);
    await Promise.all([editor.synced, viewer.synced]);
    const update = bigUpdate(REVIEWER_UPDATE_BYTES - 40);
    expect(update.byteLength).toBeGreaterThan(15_000_000);
    expect(update.byteLength).toBeLessThan(server.config.WS_MAX_UPDATE_BYTES * 8);
    const receivedBefore = viewer.received.length;
    editor.send(syncFrame(syncProtocol.messageYjsUpdate, update));
    const closed = await editor.closed;
    expect(closed.code).toBe(CLOSE_MESSAGE_TOO_BIG);
    const room = server.app.rooms.get(docId);
    await waitFor(() => room?.stats.oversized === 1);
    await sleep(30);
    expect(room?.doc.getText('t').length).toBe(0);
    expect(server.repo.updatesByDoc.get(docId) ?? []).toHaveLength(0);
    expect(viewer.received.length).toBe(receivedBefore);
    expect(viewer.ws.readyState).toBe(viewer.ws.OPEN);
    // The refusal is a GeDe/Sync datapoint, dimensioned by reason, with no payload in the line.
    const line = refusals(server.logs).find((l) => l.Reason === 'message_too_big');
    expect(line).toBeDefined();
    expect(line?._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: METRIC_NAMESPACE,
      Dimensions: [['Reason']],
      Metrics: [{ Name: 'WsRefusals', Unit: 'Count' }],
    });
    expect(line?.WsRefusals).toBe(1);
    expect(line?.documentId).toBe(docId);
    expect(line?.userId).toBe(ownerId);
    expect(JSON.stringify(line)).not.toContain('xxxxxxxx');
  });

  test('LOAD-06 a document has a ceiling: an update that would pass DOC_MAX_BYTES is refused (4413), the socket closed, the document and log untouched; a second socket keeps working', async () => {
    await server.close();
    server = await startServer(
      { DOC_MAX_BYTES: 4096, WS_MAX_UPDATE_BYTES: 64 * 1024, WS_BYTES_BURST: 64 * 1024 },
      { captureLogs: true },
    );
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'ceiling').id;
    const a = await connect(ownerToken);
    const b = await connect(ownerToken);
    await Promise.all([a.synced, b.synced]);
    const room = server.app.rooms.get(docId);
    const before = room?.stateBytes ?? 0;
    // Under the ceiling: applied, persisted, fanned out, and counted towards the estimate.
    a.setCell('r1:c1', 'small');
    await waitFor(() => b.cell('r1:c1') === 'small');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);
    expect(room?.stateBytes ?? 0).toBeGreaterThan(before);
    // Over it: refused whole.
    a.send(syncFrame(syncProtocol.messageYjsUpdate, bigUpdate(8000)));
    const closed = await a.closed;
    expect(closed).toEqual({ code: CLOSE_TOO_LARGE, reason: 'document too large' });
    expect(room?.stats.tooLarge).toBe(1);
    await sleep(30);
    expect(room?.doc.getText('t').length).toBe(0);
    expect(server.repo.updatesByDoc.get(docId)).toHaveLength(1);
    expect(refusalReasons(server.logs)).toContain('document_too_large');
    // The other socket is unaffected and the room still accepts what fits.
    b.setCell('r2:c1', 'still fine');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 2);
    expect(b.ws.readyState).toBe(b.ws.OPEN);
  });

  test('LOAD-06 the room’s size estimate is corrected to the encoded state at each snapshot, and a byte threshold compacts early however few the updates', async () => {
    await server.close();
    server = await startServer(
      {
        SNAPSHOT_EVERY_UPDATES: 1000,
        DOC_LOG_MAX_BYTES: 2048,
        WS_MAX_UPDATE_BYTES: 64 * 1024,
        WS_BYTES_BURST: 64 * 1024,
      },
      { captureLogs: true },
    );
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'log bytes').id;
    const a = await connect(ownerToken);
    await a.synced;
    const room = server.app.rooms.get(docId);
    if (!room) throw new Error('room');
    // Two updates of ~1.5 KB each: well under 1000 updates, over 2 KB of log.
    a.setCell('r1:c1', 'y'.repeat(1500));
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);
    expect(room.persistence.stats.snapshots).toBe(0);
    a.setCell('r2:c1', 'z'.repeat(1500));
    await waitFor(() => room.persistence.stats.snapshots === 1);
    // The log was pruned by the compaction and the estimate now equals the snapshot's size.
    expect(server.repo.updatesByDoc.get(docId) ?? []).toHaveLength(0);
    const snapshot = server.repo.snapshotsByDoc.get(docId)?.at(-1);
    expect(snapshot).toBeDefined();
    expect(room.stateBytes).toBe(snapshot?.sizeBytes);
    expect(room.stateBytes).toBe(Y.encodeStateAsUpdate(room.doc).byteLength);
  });

  test('LOAD-05 sync bytes have their own bucket: many frames under the message budget but over the byte budget close 4429', async () => {
    await server.close();
    server = await startServer(
      {
        WS_UPDATES_BURST: 1000,
        WS_UPDATES_PER_SEC: 1000,
        WS_BYTES_PER_SEC: 1,
        WS_BYTES_BURST: 6000,
        WS_MAX_UPDATE_BYTES: 64 * 1024,
      },
      { captureLogs: true },
    );
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'bytes').id;
    const a = await connect(ownerToken);
    await a.synced;
    // Five updates of ~1.5 KB: the fourth passes 6000 bytes.
    for (let i = 0; i < 5; i += 1) a.setCell(`r${String(i)}:c1`, 'q'.repeat(1500));
    const closed = await a.closed;
    expect(closed).toEqual({ code: CLOSE_TOO_MANY_REQUESTS, reason: 'too many bytes' });
    const room = server.app.rooms.get(docId);
    expect(room?.stats.bytesRateLimited).toBe(1);
    expect(room?.doc.getMap<string>('cells').size).toBeLessThan(5);
    expect(refusalReasons(server.logs)).toContain('bytes_rate_limited');
  });
});

describe('sockets per user, sockets per task, rooms per task (#99)', () => {
  beforeEach(async () => {
    server = await startServer(
      { WS_MAX_SOCKETS_PER_USER: 2, WS_MAX_SOCKETS: 3, WS_MAX_ROOMS: 2 },
      { captureLogs: true },
    );
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'caps').id;
  });

  test('LOAD-05 a user’s third socket on one task is refused 4429; closing one frees the slot', async () => {
    const a = await connect(ownerToken);
    const b = await connect(ownerToken);
    await Promise.all([a.synced, b.synced]);
    expect(server.app.rooms.socketsFor(ownerId)).toBe(2);
    const c = await connect(ownerToken);
    expect(await c.closed).toEqual({
      code: CLOSE_TOO_MANY_REQUESTS,
      reason: 'too many connections',
    });
    expect(server.app.rooms.stats.refusedUserSockets).toBe(1);
    expect(server.app.rooms.socketsFor(ownerId)).toBe(2);
    a.close();
    await waitFor(() => server.app.rooms.socketsFor(ownerId) === 1);
    const d = await connect(ownerToken);
    await d.synced;
    expect(server.app.rooms.socketsFor(ownerId)).toBe(2);
    expect(refusalReasons(server.logs)).toEqual(['too_many_sockets_for_user']);
  });

  test('LOAD-05 the task refuses sockets past WS_MAX_SOCKETS and rooms past WS_MAX_ROOMS with 1013, so a full task tells the provider to try again later', async () => {
    const other = server.verifier.issue('tok-other', 'sub-other');
    const otherId = await userId(other);
    const third = server.verifier.issue('tok-third', 'sub-third');
    const thirdId = await userId(third);
    server.repo.share(docId, otherId, 'edit');
    server.repo.share(docId, thirdId, 'view');
    const a = await connect(ownerToken);
    const b = await connect(ownerToken);
    const c = await connect(other);
    await Promise.all([a.synced, b.synced, c.synced]);
    expect(server.app.rooms.socketCount).toBe(3);
    const d = await connect(third);
    expect(await d.closed).toEqual({ code: CLOSE_TRY_AGAIN_LATER, reason: 'too many connections' });
    expect(server.app.rooms.stats.refusedSockets).toBe(1);
    c.close();
    await waitFor(() => server.app.rooms.socketCount === 2);

    // Rooms: a third document cannot open a third room on this task.
    const doc2 = server.repo.seedDocument(ownerId, 'second').id;
    const doc3 = server.repo.seedDocument(otherId, 'third').id;
    // The owner already holds two sockets; the other user opens the second room.
    server.repo.share(doc2, otherId, 'view');
    const e = await connect(other, doc2);
    await e.synced;
    expect(server.app.rooms.size).toBe(2);
    // Under the socket cap again, so the room cap is what refuses the third document.
    b.close();
    await waitFor(() => server.app.rooms.socketCount === 2);
    const f = await connect(other, doc3);
    expect(await f.closed).toEqual({
      code: CLOSE_TRY_AGAIN_LATER,
      reason: 'too many open documents',
    });
    expect(server.app.rooms.stats.refusedRooms).toBe(1);
    expect(server.app.rooms.size).toBe(2);
    expect(refusalReasons(server.logs)).toEqual(['too_many_sockets', 'too_many_rooms']);
  });
});

describe('malformed updates are refused, not swallowed (#105)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    consoleError = vi.spyOn(console, 'error');
    server = await startServer({ PERSIST_COALESCE_MS: 5 }, { captureLogs: true });
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'malformed').id;
  });
  afterEach(() => {
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('LOAD-06 4 KB of garbage as an update or a step 2 closes 1007, is counted, and reaches neither the document nor the log nor stderr', async () => {
    for (const subtype of [syncProtocol.messageYjsUpdate, syncProtocol.messageYjsSyncStep2]) {
      const a = await connect(ownerToken);
      await a.synced;
      const garbage = new Uint8Array(4096);
      for (let i = 0; i < garbage.length; i += 1) garbage[i] = (i * 7919) % 251;
      a.send(syncFrame(subtype, garbage));
      expect(await a.closed).toEqual({ code: CLOSE_MALFORMED, reason: 'malformed message' });
    }
    const room = server.app.rooms.get(docId);
    expect(room?.stats.malformed).toBe(2);
    await sleep(30);
    expect(server.repo.updatesByDoc.get(docId) ?? []).toHaveLength(0);
    expect(refusalReasons(server.logs)).toEqual(['malformed', 'malformed']);
  });

  test('LOAD-06 a valid update with its last byte cut is refused whole: nothing is half-applied, nothing is persisted, the other socket sees nothing', async () => {
    const a = await connect(ownerToken);
    const b = await connect(ownerToken);
    await Promise.all([a.synced, b.synced]);
    const doc = new Y.Doc();
    doc.getMap<string>('cells').set('r1:c1', 'truncated');
    const whole = Y.encodeStateAsUpdate(doc);
    const cut = whole.subarray(0, whole.byteLength - 1);
    const receivedBefore = b.received.length;
    a.send(syncFrame(syncProtocol.messageYjsUpdate, cut));
    expect(await a.closed).toEqual({ code: CLOSE_MALFORMED, reason: 'malformed message' });
    const room = server.app.rooms.get(docId);
    await sleep(30);
    expect(room?.doc.getMap<string>('cells').size).toBe(0);
    expect(server.repo.updatesByDoc.get(docId) ?? []).toHaveLength(0);
    expect(b.received.length).toBe(receivedBefore);
    expect(room?.stats.malformed).toBe(1);
  });

  test('LOAD-06 a text frame, an unknown message type and an undecodable envelope each close 1007; type-2 auth frames cost a sync token', async () => {
    const a = await connect(ownerToken);
    await a.synced;
    a.ws.send('hello');
    expect((await a.closed).code).toBe(CLOSE_MALFORMED);
    const b = await connect(ownerToken);
    await b.synced;
    b.send(new Uint8Array([9, 1, 2, 3]));
    expect((await b.closed).code).toBe(CLOSE_MALFORMED);
    const c = await connect(ownerToken);
    await c.synced;
    c.send(new Uint8Array([MESSAGE_SYNC, syncProtocol.messageYjsUpdate, 0xff, 0xff]));
    expect((await c.closed).code).toBe(CLOSE_MALFORMED);
    const room = server.app.rooms.get(docId);
    expect(room?.stats.malformed).toBe(3);

    await server.close();
    server = await startServer({ WS_UPDATES_PER_SEC: 1, WS_UPDATES_BURST: 4 });
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'auth frames').id;
    const d = await connect(ownerToken);
    await d.synced; // two tokens spent
    for (let i = 0; i < 4; i += 1) d.send(new Uint8Array([2]));
    expect((await d.closed).code).toBe(CLOSE_TOO_MANY_REQUESTS);
  });
});

describe('permission is re-resolved after upgrade (#104)', () => {
  let editorToken: string;
  let editorId: string;

  beforeEach(async () => {
    server = await startServer(
      { PERSIST_COALESCE_MS: 5, WS_PERMISSION_RECHECK_MS: 40 },
      { captureLogs: true },
    );
    ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
    ownerId = await userId(ownerToken);
    docId = server.repo.seedDocument(ownerId, 'recheck').id;
    editorToken = server.verifier.issue('tok-editor', 'sub-editor');
    editorId = await userId(editorToken);
    server.repo.share(docId, editorId, 'edit');
  });

  test('SHARE-03 a share removed behind the process (another task, by hand) closes the socket 4403 on the next sweep; frames sent meanwhile are refused and never persisted under the removed author', async () => {
    const editor = await connect(editorToken);
    const owner = await connect(ownerToken);
    await Promise.all([editor.synced, owner.synced]);
    editor.setCell('r1:c1', 'before');
    await waitFor(() => owner.cell('r1:c1') === 'before');
    await waitFor(() => (server.repo.updatesByDoc.get(docId)?.length ?? 0) === 1);

    // The removal never passes through this process's RoomManager.
    server.repo.sharesByDoc.get(docId)?.delete(editorId);
    await server.app.rooms.recheckPermissions();
    // The connection is revoked before the close frame goes out: a frame that
    // arrives before the peer answers the handshake is refused.
    const room = server.app.rooms.get(docId);
    if (!room) throw new Error('room');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc));
    doc.getMap<string>('cells').set('r2:c1', 'after removal');
    editor.send(syncFrame(syncProtocol.messageYjsUpdate, Y.encodeStateAsUpdate(doc)));
    expect(await editor.closed).toEqual({ code: CLOSE_FORBIDDEN, reason: 'access removed' });
    await waitFor(() => room.stats.refusedRevoked >= 1);
    await sleep(30);
    expect(room.doc.getMap<string>('cells').get('r2:c1')).toBeUndefined();
    const log = server.repo.updatesByDoc.get(docId) ?? [];
    expect(log).toHaveLength(1);
    expect(log.map((u) => u.authorId)).toEqual([editorId]);
    expect(owner.ws.readyState).toBe(owner.ws.OPEN);
    expect(server.app.rooms.stats.revoked).toBe(1);
    const line = server.logs.find((l) => 'WsRevocations' in l);
    expect(line).toMatchObject({ Reason: 'permission_ended', userId: editorId, documentId: docId });
  });

  test('SHARE-03 the sweep runs on its own cadence: a demotion closes 1001 so the provider reconnects as a viewer, and a deleted document closes 4404', async () => {
    const editor = await connect(editorToken);
    await editor.synced;
    server.repo.sharesByDoc.get(docId)?.set(editorId, {
      permission: 'view',
      invitedBy: ownerId,
      createdAt: new Date(),
      source: 'invite',
    });
    // No manual sweep: the interval (40 ms here) finds it.
    expect(await editor.closed).toEqual({ code: 1001, reason: 'permission changed' });
    const again = await connect(editorToken);
    await again.synced;
    expect(server.app.rooms.get(docId)?.conns.size).toBe(1);
    await server.repo.documents.softDelete(docId);
    expect(await again.closed).toEqual({ code: CLOSE_NOT_FOUND, reason: 'document deleted' });
    expect(server.app.rooms.stats.revoked).toBe(2);
  });

  test('AUTH-09 a socket whose access token has expired is closed 1001 by the sweep so the provider reconnects with a fresh token', async () => {
    const stale = server.verifier.issue('tok-stale', 'sub-editor', null, Date.now() + 60);
    const editor = await connect(stale);
    await editor.synced;
    await sleep(70);
    expect(await editor.closed).toEqual({ code: 1001, reason: 'token expired' });
    const line = server.logs.find((l) => 'WsRevocations' in l && l.Reason === 'token_expired');
    expect(line).toMatchObject({ userId: editorId });
    // A token with no expiry stated, or one still valid, is left alone.
    const fresh = server.verifier.issue('tok-fresh', 'sub-editor', null, Date.now() + 60_000);
    const kept = await connect(fresh);
    await kept.synced;
    await sleep(100);
    expect(kept.ws.readyState).toBe(kept.ws.OPEN);
  });

  test('SHARE-03 a sweep that cannot read the database keeps every socket and tries again later', async () => {
    const editor = await connect(editorToken);
    await editor.synced;
    const documents = server.repo.documents as { get: (id: string) => Promise<unknown> };
    const original = documents.get.bind(server.repo.documents);
    documents.get = () => Promise.reject(new Error('connection refused'));
    await server.app.rooms.recheckPermissions();
    documents.get = original;
    await sleep(30);
    expect(editor.ws.readyState).toBe(editor.ws.OPEN);
    expect(server.app.rooms.stats.revoked).toBe(0);
  });
});
