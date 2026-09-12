import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FakeRoom, until } from '../test/fake-websocket.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHENTICATED,
  OFFLINE_AFTER_ATTEMPTS,
  SyncClient,
  type SyncSnapshot,
} from './sync-client.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-000000000001';
const WS_URL = 'wss://ws.test/ws';

function client(
  room: FakeRoom,
  overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {},
) {
  const doc = new Y.Doc();
  let tokens = 0;
  const c = new SyncClient({
    docId: DOC_ID,
    doc,
    wsUrl: WS_URL,
    getToken: () => Promise.resolve(`tok-${String(++tokens)}`),
    WebSocketImpl: room.WebSocket,
    random: () => 0,
    ...overrides,
  });
  const history: SyncSnapshot[] = [c.getSnapshot()];
  c.subscribe(() => history.push(c.getSnapshot()));
  return { c, doc, history };
}

describe('SyncClient', () => {
  let room: FakeRoom;
  const clients: SyncClient[] = [];
  beforeEach(() => {
    room = new FakeRoom();
  });
  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
    vi.useRealTimers();
  });

  it('LOAD-05 connects with the access token in the query and reaches synced; edits flow both ways', async () => {
    const { c, doc } = client(room);
    clients.push(c);
    c.connect();
    await until(() => c.getSnapshot().status === 'synced');
    expect(room.urls[0]).toBe(`${WS_URL}/${DOC_ID}?token=tok-1`);
    // Local edit renders immediately (the doc is the state) and reaches the room.
    doc.getMap('meta').set('title', 'Everest trek');
    expect(doc.getMap('meta').get('title')).toBe('Everest trek');
    await until(() => room.doc.getMap('meta').get('title') === 'Everest trek');
    // Another participant's edit arrives.
    room.edit((d) => {
      d.getMap('meta').set('title', 'Everest trek 2027');
    });
    await until(() => doc.getMap('meta').get('title') === 'Everest trek 2027');
  });

  it('AUTH-09 re-reads the token before every connect and reconnects with backoff after a drop', async () => {
    vi.useFakeTimers();
    const { c, history } = client(room);
    clients.push(c);
    c.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getSnapshot().status).toBe('synced');
    room.dropAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      attempts: 1,
      everSynced: true,
    });
    // Backoff: 400 ms × 2^0 × (0.5 + random 0) = 200 ms before the next attempt.
    await vi.advanceTimersByTimeAsync(150);
    expect(room.urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(room.urls).toHaveLength(2);
    expect(room.urls[1]).toBe(`${WS_URL}/${DOC_ID}?token=tok-2`);
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getSnapshot()).toMatchObject({ status: 'synced', attempts: 0 });
    expect(history.map((h) => h.status)).toEqual([
      'connecting',
      'synced',
      'reconnecting',
      'synced',
    ]);
  });

  it('LOAD-06 repeated failures read as offline while attempts continue with growing, jittered delays', async () => {
    vi.useFakeTimers();
    room.options = { refuseWith: { code: 1011, reason: 'boom' } };
    const randoms = [0, 0.5, 1];
    let i = 0;
    const { c } = client(room, { random: () => randoms[i++ % randoms.length] ?? 0 });
    clients.push(c);
    c.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getSnapshot()).toMatchObject({ status: 'connecting', attempts: 1 });
    await vi.advanceTimersByTimeAsync(200); // 400 × 1 × 0.5
    expect(room.urls).toHaveLength(2);
    expect(c.getSnapshot()).toMatchObject({ status: 'connecting', attempts: 2 });
    await vi.advanceTimersByTimeAsync(800); // 400 × 2 × 1.0
    expect(room.urls).toHaveLength(3);
    expect(c.getSnapshot()).toMatchObject({ status: 'offline', attempts: OFFLINE_AFTER_ATTEMPTS });
    await vi.advanceTimersByTimeAsync(2400); // 400 × 4 × 1.5
    expect(room.urls).toHaveLength(4);
    // Every attempt carried a fresh token.
    expect(new Set(room.urls.map((u) => u.split('token=')[1])).size).toBe(4);
    // The service comes back: the next attempt syncs and the counter resets.
    room.options = {};
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot()).toMatchObject({ status: 'synced', attempts: 0, failure: null });
  });

  it('AUTH-09 a 4401 close retries once with a fresh token, a second 4401 becomes a failure', async () => {
    vi.useFakeTimers();
    room.options = {
      refuseWith: { code: CLOSE_UNAUTHENTICATED, reason: 'invalid token' },
      refuseCount: 1,
    };
    const { c } = client(room);
    clients.push(c);
    c.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(room.urls).toEqual([
      `${WS_URL}/${DOC_ID}?token=tok-1`,
      `${WS_URL}/${DOC_ID}?token=tok-2`,
    ]);
    expect(c.getSnapshot().status).toBe('synced');
    c.destroy();

    const again = new FakeRoom({ refuseWith: { code: CLOSE_UNAUTHENTICATED, reason: 'expired' } });
    const second = client(again);
    clients.push(second.c);
    second.c.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(again.urls).toHaveLength(2);
    expect(second.c.getSnapshot()).toMatchObject({
      status: 'offline',
      failure: { code: CLOSE_UNAUTHENTICATED, reason: 'expired' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(again.urls).toHaveLength(2); // no further attempts without Retry
  });

  it('SHARE-03 a 4403 is terminal: no reconnect until Retry, which reconnects at once', async () => {
    vi.useFakeTimers();
    room.options = { refuseWith: { code: CLOSE_FORBIDDEN, reason: 'not a participant' } };
    const { c } = client(room);
    clients.push(c);
    c.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getSnapshot()).toMatchObject({
      status: 'offline',
      failure: { code: CLOSE_FORBIDDEN, reason: 'not a participant' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.urls).toHaveLength(1);
    room.options = {};
    c.retry();
    expect(c.getSnapshot().failure).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(room.urls).toHaveLength(2);
    expect(c.getSnapshot().status).toBe('synced');
  });

  it('SHARE-03 a view-only socket still receives the stream while its updates are dropped', async () => {
    room.options = { viewOnly: true };
    room.edit((d) => {
      d.getMap('meta').set('title', 'Read me');
    });
    const { c, doc } = client(room);
    clients.push(c);
    c.connect();
    await until(() => doc.getMap('meta').get('title') === 'Read me');
    doc.getMap('meta').set('title', 'Vandalism');
    await until(() => room.droppedUpdates > 0);
    expect(room.doc.getMap('meta').get('title')).toBe('Read me');
  });

  it('LOAD-06 pause drops the socket and resume reconnects with a fresh token; offline reports at once', async () => {
    vi.useFakeTimers();
    const { c } = client(room);
    clients.push(c);
    c.connect();
    await vi.advanceTimersByTimeAsync(10);
    c.pause();
    await vi.advanceTimersByTimeAsync(10);
    expect(room.sockets.size).toBe(0);
    expect(c.getSnapshot().status).toBe('synced'); // no announcement churn while hidden
    c.resume();
    expect(c.getSnapshot().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10);
    expect(room.urls).toHaveLength(2);
    expect(c.getSnapshot().status).toBe('synced');
    c.setOnline(false);
    expect(c.getSnapshot().status).toBe('offline');
    c.setOnline(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getSnapshot().status).toBe('synced');
  });

  it('AUTH-09 a signed-out session (no token) never opens a socket', async () => {
    const { c } = client(room, { getToken: () => Promise.resolve(null) });
    clients.push(c);
    c.connect();
    await until(() => c.getSnapshot().status === 'offline');
    expect(room.urls).toHaveLength(0);
    expect(c.getSnapshot().failure?.code).toBe(CLOSE_UNAUTHENTICATED);
  });
});
