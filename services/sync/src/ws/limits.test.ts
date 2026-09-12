/**
 * Rate limiting and back-pressure (#37): REST buckets per caller, per-connection
 * update and awareness buckets, slow-consumer closes, the proxy hop count.
 */
import * as encoding from 'lib0/encoding';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { AddressLimiter } from '../ip-limit.js';
import { perUserKey, trustOneHop } from '../server.js';
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
import { MESSAGE_QUERY_AWARENESS, MESSAGE_SYNC } from './protocol.js';
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

describe('REST rate limits', () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  test('LOAD-05 the per-user budget is keyed by the verified user, not the bearer string: a rotating token shares the bucket, 429 follows the error contract, other users and health checks are unaffected', async () => {
    server = await startServer({ RATE_LIMIT_PER_MINUTE: 3, RATE_LIMIT_PER_IP_PER_MINUTE: 1000 });
    const alice = server.verifier.issue('tok-alice', 'sub-alice');
    const aliceAgain = server.verifier.issue('tok-alice-rotated', 'sub-alice');
    const bob = server.verifier.issue('tok-bob', 'sub-bob');
    expect((await json(server, 'GET', '/api/me', { token: alice })).status).toBe(200);
    expect((await json(server, 'GET', '/api/me', { token: aliceAgain })).status).toBe(200);
    expect((await json(server, 'GET', '/api/me', { token: alice })).status).toBe(200);
    const limited = await json<ErrorBody>(server, 'GET', '/api/me', { token: aliceAgain });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('too_many_requests');
    expect(limited.body.error.ref).toBe(limited.headers.get('x-request-id'));
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect((await json(server, 'GET', '/api/me', { token: bob })).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      expect((await json(server, 'GET', '/healthz')).status).toBe(200);
      expect((await json(server, 'GET', '/api/health')).status).toBe(200);
    }
    expect(perUserKey({ ip: '1.1.1.1' })).toBe('ip:1.1.1.1');
    expect(
      perUserKey({
        user: {
          id: 'u1',
          sub: 's',
          email: null,
          displayName: null,
          locale: null,
          tourDoneAt: null,
          sampleDocumentId: null,
        },
        ip: '1.1.1.1',
      }),
    ).toBe('user:u1');
  });

  test('AUTH-01 the per-address budget bounds callers with no or a rotating invalid token, keyed by the address the ALB appended, never a forged leftmost X-Forwarded-For', async () => {
    server = await startServer({ RATE_LIMIT_PER_MINUTE: 1000, RATE_LIMIT_PER_IP_PER_MINUTE: 3 });
    const hit = (forwardedFor: string, token?: string) =>
      fetch(`${server.baseUrl}/api/me`, {
        headers: {
          'x-forwarded-for': forwardedFor,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      });
    // Random bearers are not fresh buckets: the address pays for each 401.
    expect((await hit('9.9.9.9, 1.1.1.1', 'random-1')).status).toBe(401);
    expect((await hit('9.9.9.9, 1.1.1.1', 'random-2')).status).toBe(401);
    expect((await hit('9.9.9.9, 1.1.1.1')).status).toBe(401);
    const limited = await hit('9.9.9.9, 1.1.1.1', 'random-3');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as ErrorBody).error.code).toBe('too_many_requests');
    // A different forged leftmost address does not buy a new bucket…
    expect((await hit('8.8.8.8, 1.1.1.1')).status).toBe(429);
    // …a different client behind the ALB does.
    expect((await hit('9.9.9.9, 2.2.2.2')).status).toBe(401);
    expect(trustOneHop('127.0.0.1', 0)).toBe(true);
    expect(trustOneHop('1.1.1.1', 1)).toBe(false);
  });

  test('LOAD-05 the address limiter refills at its rate and evicts the least recently seen address', () => {
    let now = 0;
    const limiter = new AddressLimiter(60, () => now);
    for (let i = 0; i < 60; i += 1) expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    now = 2_000; // two seconds → two tokens at 60/min
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    for (let i = 0; i < 10_000; i += 1) limiter.take(`addr-${String(i)}`);
    expect(limiter.size).toBe(10_000); // 'a' was the least recently seen and went
    expect(limiter.take('a')).toBe(true); // a fresh bucket
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
      WS_UPDATES_BURST: 4,
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
    // The handshake cost two tokens (the client's step 1, then its step 2); two more
    // updates fit, the third does not.
    for (let i = 0; i < 5; i += 1) client.setCell(`r${String(i)}:c1`, 'x');
    const closed = await client.closed;
    expect(closed.code).toBe(CLOSE_TOO_MANY_REQUESTS);
    const room = server.app.rooms.get(docId);
    expect(room?.stats.rateLimited).toBe(1);
    expect(room?.doc.getMap<string>('cells').size).toBeGreaterThanOrEqual(2);
  });

  test('LOAD-05 sync step 1 and awareness queries cost tokens too: a burst of reads from a view-only socket is closed with 4429 (review of #66)', async () => {
    const viewer = server.verifier.issue('tok-viewer', 'sub-viewer');
    const viewerId = (await json<{ id: string }>(server, 'GET', '/api/me', { token: viewer })).body
      .id;
    server.repo.share(docId, viewerId, 'view');
    const client = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
      protocols: bearerProtocols(viewer),
    });
    clients.push(client);
    await client.synced; // step 1 + step 2 (dropped as a write, but the token was taken first)
    const step2s = () =>
      client.received.filter(
        (m) => m[0] === MESSAGE_SYNC && m[1] === syncProtocol.messageYjsSyncStep2,
      ).length;
    const before = step2s();
    // Each step 1 with an empty state vector would make the server encode and send
    // the whole document; the bucket (burst 4) refuses the third of these.
    for (let i = 0; i < 6; i += 1) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, new Y.Doc());
      client.send(encoding.toUint8Array(encoder));
    }
    const closed = await client.closed;
    expect(closed).toEqual({ code: CLOSE_TOO_MANY_REQUESTS, reason: 'too many sync messages' });
    const room = server.app.rooms.get(docId);
    expect(room?.stats.rateLimited).toBe(1);
    // At most two full step-2 replies went out before the close.
    expect(step2s() - before).toBeLessThanOrEqual(2);

    // An awareness query burst is refused the same way.
    const other = await connect();
    for (let i = 0; i < 6; i += 1) other.send(new Uint8Array([MESSAGE_QUERY_AWARENESS]));
    expect((await other.closed).reason).toBe('too many awareness queries');
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
