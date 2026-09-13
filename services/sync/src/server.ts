/**
 * Assembles the Fastify instance from injected dependencies. `main.ts` passes
 * the real verifier, repository and S3 store; tests pass fakes.
 */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { UserResolver } from './auth.js';
import type { Deps } from './deps.js';
import { AppError, newRequestId, registerErrorHandling } from './errors.js';
import { AddressLimiter, registerAddressLimit } from './ip-limit.js';
import { MailEventsPoller } from './mail/events.js';
import { ProjectionWorker } from './projection/worker.js';
import { registerApi } from './routes/api.js';
import { registerHealth } from './routes/health.js';
import { SampleSeeder } from './sample.js';
import { RoomManager } from './ws/room-manager.js';
import { registerWs, selectSubprotocol } from './ws/route.js';

/** proxy-addr callback: trust the socket peer (hop 0, the ALB) and nothing further up the chain. */
export const trustOneHop = (_address: string, hop: number): boolean => hop < 1;

/**
 * Per-user bucket key for `/api`: the verified user's id (the auth hook has run
 * by `preHandler`), never the bearer string — a rotating token is the same
 * user, and a random one never reaches this hook. The address is the fallback
 * only for a route that reaches this without a user (none today).
 */
export function perUserKey(request: Pick<FastifyRequest, 'user' | 'ip'>): string {
  return request.user === undefined ? `ip:${request.ip}` : `user:${request.user.id}`;
}

/** The Fastify instance plus the room manager and projection worker, exposed for shutdown and tests. */
export type SyncServer = FastifyInstance & {
  readonly rooms: RoomManager;
  readonly projection: ProjectionWorker;
  /** The guided-sample seeder (ONB-01); tests read its counters. */
  readonly samples: SampleSeeder;
  /** The SES events poller (ADR-046), or null without a queue; tests read its stats. */
  readonly mailEvents: MailEventsPoller | null;
};

export async function buildServer(deps: Deps): Promise<SyncServer> {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => newRequestId(),
    // Never trust a client-supplied request id: `ref` must be ours to be useful to support.
    requestIdHeader: false,
    // One hop: the ALB appends the real client to X-Forwarded-For. `true` would
    // take the leftmost entry, which a client can forge (#42); on the CloudFront
    // path (`/api/*`) the "client" is therefore CloudFront's edge, which is why
    // rate limiting keys on the bearer token first and the address second.
    trustProxy: trustOneHop,
    bodyLimit: 64 * 1024,
  });

  const projection = new ProjectionWorker(deps.db.projection, deps.config, deps.logger);
  const rooms = new RoomManager(deps.db, deps.s3, deps.config, deps.logger, projection);

  registerErrorHandling(app);

  // The static web behaviour gets its security headers from CloudFront
  // (infra web-stack.ts); `/api/*` is proxied to this process and carried none
  // (#144). The same three on every response, error responses included: no
  // sniffing of a JSON body into a script, a year of HSTS to match the edge,
  // and no referrer leaking a document path to a third party.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  });

  await app.register(cors, {
    origin: deps.config.WEB_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  // Two limits (#37, review of #66). First, coarse and per address, on every
  // route at `onRequest` — the only thing that bounds callers with no or a
  // rotating token. Second, precise and per verified user, on `/api` at
  // `preHandler` (after the auth hook) — see `registerApi`. Health checks are
  // exempt from both; the answer follows the error contract (`too_many_requests`).
  registerAddressLimit(app, new AddressLimiter(deps.config.RATE_LIMIT_PER_IP_PER_MINUTE));
  await app.register(rateLimit, {
    global: false,
    max: deps.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: perUserKey,
    errorResponseBuilder: (_request, context) =>
      new AppError(429, 'too_many_requests', `Too many requests; try again in ${context.after}`),
  });

  await app.register(websocket, {
    options: {
      // The largest client → server frame (#99): `ws` closes 1009 on the declared length.
      maxPayload: deps.config.WS_MAX_UPDATE_BYTES,
      // Select `gede.v1`; never echo the `bearer.<token>` entry (issue #32).
      handleProtocols: selectSubprotocol,
    },
    // On shutdown tell every provider we are going away (1001) so it reconnects
    // with backoff to the replacement task; the plugin default sends no code.
    preClose(done) {
      for (const client of this.websocketServer.clients) client.close(1001, 'going away');
      this.websocketServer.close(done);
    },
  });

  // ONB-01: every account's first request seeds its guided sample (S3 object, then row).
  const samples = new SampleSeeder({
    repo: deps.db,
    s3: deps.s3,
    config: deps.config,
    projection,
    logger: deps.logger,
  });
  const resolver = new UserResolver(deps.verifier, deps.db, undefined, samples);

  registerHealth(app, deps);
  registerApi(app, deps, resolver, rooms, projection);
  registerWs(app, { config: deps.config, repo: deps.db, resolver, rooms });

  // SES bounces and complaints (ADR-046): consumed from the queue while the
  // server runs, on this task; nothing to consume locally.
  const mailEvents =
    deps.mailEvents === null
      ? null
      : new MailEventsPoller({ queue: deps.mailEvents, repo: deps.db.mail, logger: deps.logger });

  // Runs during app.close(), after @fastify/websocket has stopped accepting
  // upgrades: flush every room's pending updates before the pool goes away.
  app.addHook('onClose', async () => {
    // First: the in-flight long poll is aborted and the message in hand finished.
    await mailEvents?.stop();
    await rooms.shutdown();
    // Rooms compact on shutdown; write what they scheduled before the pool goes away.
    await projection.close();
  });

  await app.ready();
  mailEvents?.start();
  // `Fastify()` returns the instance intersected with `PromiseLike<undefined>`
  // (legacy `await fastify()` support); strip that so the async return is not
  // treated as a thenable.
  const instance: FastifyInstance = app;
  return Object.assign(instance, { rooms, projection, samples, mailEvents });
}
