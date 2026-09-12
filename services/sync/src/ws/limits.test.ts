/**
 * Rate limiting and back-pressure (#37): REST buckets per caller, per-connection
 * update and awareness buckets, slow-consumer closes, the proxy hop count.
 */
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { rateLimitKey, trustOneHop } from '../server.js';
import { FakeRepo } from '../test/fake-repo.js';
import {
  FakeSnapshotStore,
  json,
  startServer,
  testConfig,
  WEB_ORIGIN,
  type TestServer,
} from '../test/fakes.js';
import { bearerProtocols, sleep, waitFor, YClient } from '../test/y-client.js';
import { Room } from './room.js';
import { CLOSE_TOO_MANY_REQUESTS, CLOSE_TRY_AGAIN_LATER } from './route.js';
import { TokenBucket } from './throttle.js';

interface ErrorBody {
  error: { code: string; message: string; ref: string };
}

describe('TokenBucket', () => {
  test('refills at the rate up to the burst', () => {
    let now = 0;
    const bucket = new TokenBucket(10, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    now = 100; // 0.1 s → one token
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
    now = 10_000; // long idle → capped at the burst, not accumulated
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
  });
});

describe('REST rate limit', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer({ RATE_LIMIT_PER_MINUTE: 3 });
  });
  afterEach(async () => {
    await server.close();
  });

  test('LOAD-05 a caller over the per-minute budget gets 429 with the error contract; other callers and health checks are unaffected', async () => {
    const alice = server.verifier.issue('tok-alice', 'sub-alice');
    const bob = server.verifier.issue('tok-bob', 'sub-bob');
    for (let i = 0; i < 3; i += 1) {
      expect((await json(server, 'GET', '/api/me', { token: alice })).status).toBe(200);
    }
    const limited = await json<ErrorBody>(server, 'GET', '/api/me', { token: alice });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('too_many_requests');
    expect(limited.body.error.ref).toBe(limited.headers.get('x-request-id'));
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect((await json(server, 'GET', '/api/me', { token: bob })).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      expect((await json(server, 'GET', '/healthz')).status).toBe(200);
      expect((await json(server, 'GET', '/api/health')).status).toBe(200);
    }
  });

  test('AUTH-01 unauthenticated callers are keyed by the address the ALB appended, never a forged leftmost X-Forwarded-For', async () => {
    const hit = (forwardedFor: string) =>
      fetch(`${server.baseUrl}/api/me`, { headers: { 'x-forwarded-for': forwardedFor } });
    for (let i = 0; i < 3; i += 1) expect((await hit('9.9.9.9, 1.1.1.1')).status).toBe(401);
    expect((await hit('9.9.9.9, 1.1.1.1')).status).toBe(429);
    // A different forged leftmost address does not buy a new bucket…
    expect((await hit('8.8.8.8, 1.1.1.1')).status).toBe(429);
    // …a different client behind the ALB does.
    expect((await hit('9.9.9.9, 2.2.2.2')).status).toBe(401);
    expect(trustOneHop('127.0.0.1', 0)).toBe(true);
    expect(trustOneHop('1.1.1.1', 1)).toBe(false);
    expect(rateLimitKey({ headers: { authorization: 'Bearer abc' }, ip: '1.1.1.1' })).toMatch(
      /^user:[A-Za-z0-9_-]{43}$/,
    );
    expect(rateLimitKey({ headers: {}, ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
  });
});

describe('WebSocket limits', () => {
  let server: TestServer;
  let owner: string;
  let docId: string;
  const clients: YClient[] = [];

  beforeEach(async () => {
    server = await startServer({
      WS_UPDATES_PER_SEC: 1,
      WS_UPDATES_BURST: 3,
      WS_AWARENESS_PER_SEC: 1,
      WS_AWARENESS_BURST: 2,
    });
    owner = server.verifier.issue('tok-owner', 'sub-owner');
    const me = await json<{ id: string }>(server, 'GET', '/api/me', { token: owner });
    docId = server.repo.seedDocument(me.body.id, 'limits').id;
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
  });

  async function connect(): Promise<YClient> {
    const client = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
      protocols: bearerProtocols(owner),
    });
    clients.push(client);
    await client.synced;
    return client;
  }

  test('LOAD-05 a connection sending updates over its burst is closed with 4429; the room keeps what it accepted', async () => {
    const client = await connect();
    // The handshake's step 2 took one token; two more updates fit, the fourth does not.
    for (let i = 0; i < 5; i += 1) client.setCell(`r${String(i)}:c1`, 'x');
    const closed = await client.closed;
    expect(closed.code).toBe(CLOSE_TOO_MANY_REQUESTS);
    const room = server.app.rooms.get(docId);
    expect(room?.stats.rateLimited).toBe(1);
    expect(room?.doc.getMap<string>('cells').size).toBeGreaterThanOrEqual(2);
  });

  test('SHARE-04 awareness over its budget is dropped, not fanned out, and the connection stays open', async () => {
    const a = await connect();
    const b = await connect();
    for (let i = 0; i < 6; i += 1) a.awareness.setLocalState({ cell: `B${String(i)}` });
    await waitFor(() => (server.app.rooms.get(docId)?.stats.throttledAwareness ?? 0) >= 4);
    await sleep(20);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
    // b saw a's first states only: the throttled ones never reached the room.
    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ cell: 'B1' });
  });

  test('SHARE-04 an oversized awareness frame is refused on its length before it is decoded', async () => {
    const a = await connect();
    const frame = new Uint8Array(5000);
    frame[0] = 1; // MESSAGE_AWARENESS, then garbage
    a.send(frame);
    await waitFor(() => (server.app.rooms.get(docId)?.stats.droppedAwareness ?? 0) === 1);
    expect(server.app.rooms.get(docId)?.stats.malformed).toBe(0);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
  });
});

describe('slow consumer back-pressure', () => {
  test('LOAD-05 a socket whose buffered bytes exceed the limit is closed with 1013 instead of growing the heap', async () => {
    const repo = new FakeRepo();
    const owner = repo.seedUser('sub-owner').id;
    const doc = repo.seedDocument(owner, 'slow');
    const config = testConfig({ WS_MAX_BUFFERED_BYTES: 10 });
    const room = new Room(doc.id, repo, new FakeSnapshotStore(), config, pino({ level: 'silent' }));
    await room.ready;
    // FAKE socket: what `ws` exposes, with the buffer already past the limit.
    const closes: [number, string][] = [];
    const sent: Uint8Array[] = [];
    const socket = {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 11,
      on: () => socket,
      once: () => socket,
      send: (m: Uint8Array) => sent.push(m),
      close: (code: number, reason: string) => closes.push([code, reason]),
    };
    room.join(socket as never, { userId: owner, permission: 'owner' });
    await waitFor(() => closes.length === 1);
    expect(closes[0]).toEqual([CLOSE_TRY_AGAIN_LATER, 'slow consumer']);
    expect(sent).toEqual([]);
    expect(room.stats.slowConsumers).toBe(1);
    await room.dispose({ compact: false });
  });
});
