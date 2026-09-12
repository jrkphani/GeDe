/**
 * Assembles the Fastify instance from injected dependencies. `main.ts` passes
 * the real verifier, repository and S3 store; tests pass fakes.
 */
import { createHash } from 'node:crypto';

import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { bearerToken, UserResolver } from './auth.js';
import type { Deps } from './deps.js';
import { AppError, newRequestId, registerErrorHandling } from './errors.js';
import { ProjectionWorker } from './projection/worker.js';
import { registerApi } from './routes/api.js';
import { registerHealth } from './routes/health.js';
import { RoomManager } from './ws/room-manager.js';
import { registerWs, selectSubprotocol } from './ws/route.js';

/** proxy-addr callback: trust the socket peer (hop 0, the ALB) and nothing further up the chain. */
export const trustOneHop = (_address: string, hop: number): boolean => hop < 1;

/** Bucket key: `user:<sha256 of the token>` for a bearer caller, else `ip:<address>`. */
export function rateLimitKey(request: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const token = bearerToken(request);
  if (token !== null) return `user:${createHash('sha256').update(token).digest('base64url')}`;
  return `ip:${request.ip}`;
}

/** The Fastify instance plus the room manager and projection worker, exposed for shutdown and tests. */
export type SyncServer = FastifyInstance & {
  readonly rooms: RoomManager;
  readonly projection: ProjectionWorker;
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

  await app.register(cors, {
    origin: deps.config.WEB_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  // REST and upgrade rate limit per caller (#37): keyed by a digest of the
  // bearer token when one is presented (per user, never the token itself),
  // otherwise by the client address. Health checks are exempt; the answer
  // follows the error contract with `too_many_requests`.
  await app.register(rateLimit, {
    max: deps.config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    allowList: (request) => request.url === '/healthz' || request.url === '/api/health',
    errorResponseBuilder: (_request, context) =>
      new AppError(429, 'too_many_requests', `Too many requests; try again in ${context.after}`),
  });

  await app.register(websocket, {
    options: {
      maxPayload: deps.config.WS_MAX_PAYLOAD_BYTES,
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

  const resolver = new UserResolver(deps.verifier, deps.db);

  registerHealth(app, deps);
  registerApi(app, deps, resolver, rooms, projection);
  registerWs(app, { config: deps.config, repo: deps.db, resolver, rooms });

  // Runs during app.close(), after @fastify/websocket has stopped accepting
  // upgrades: flush every room's pending updates before the pool goes away.
  app.addHook('onClose', async () => {
    await rooms.shutdown();
    // Rooms compact on shutdown; write what they scheduled before the pool goes away.
    await projection.close();
  });

  await app.ready();
  // `Fastify()` returns the instance intersected with `PromiseLike<undefined>`
  // (legacy `await fastify()` support); strip that so the async return is not
  // treated as a thenable.
  const instance: FastifyInstance = app;
  return Object.assign(instance, { rooms, projection });
}
