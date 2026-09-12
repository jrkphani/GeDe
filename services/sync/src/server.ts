/**
 * Assembles the Fastify instance from injected dependencies. `main.ts` passes
 * the real verifier, repository and S3 store; tests pass fakes.
 */
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { UserResolver } from './auth.js';
import type { Deps } from './deps.js';
import { newRequestId, registerErrorHandling } from './errors.js';
import { registerApi } from './routes/api.js';
import { registerHealth } from './routes/health.js';
import { RoomManager } from './ws/room-manager.js';
import { registerWs } from './ws/route.js';

/** The Fastify instance plus the room manager, exposed for shutdown and tests. */
export type SyncServer = FastifyInstance & { readonly rooms: RoomManager };

export async function buildServer(deps: Deps): Promise<SyncServer> {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => newRequestId(),
    // Never trust a client-supplied request id: `ref` must be ours to be useful to support.
    requestIdHeader: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  const rooms = new RoomManager(deps.db, deps.s3, deps.config, deps.logger);

  registerErrorHandling(app);

  await app.register(cors, {
    origin: deps.config.WEB_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  await app.register(websocket, {
    options: { maxPayload: deps.config.WS_MAX_PAYLOAD_BYTES },
    // On shutdown tell every provider we are going away (1001) so it reconnects
    // with backoff to the replacement task; the plugin default sends no code.
    preClose(done) {
      for (const client of this.websocketServer.clients) client.close(1001, 'going away');
      this.websocketServer.close(done);
    },
  });

  const resolver = new UserResolver(deps.verifier, deps.db);

  registerHealth(app, deps);
  registerApi(app, deps, resolver, rooms);
  registerWs(app, { config: deps.config, repo: deps.db, resolver, rooms });

  // Runs during app.close(), after @fastify/websocket has stopped accepting
  // upgrades: flush every room's pending updates before the pool goes away.
  app.addHook('onClose', async () => {
    await rooms.shutdown();
  });

  await app.ready();
  // `Fastify()` returns the instance intersected with `PromiseLike<undefined>`
  // (legacy `await fastify()` support); strip that so the async return is not
  // treated as a thenable.
  const instance: FastifyInstance = app;
  return Object.assign(instance, { rooms });
}
