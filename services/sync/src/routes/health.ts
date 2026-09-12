import type { FastifyInstance, RouteHandlerMethod } from 'fastify';

import type { Deps } from '../deps.js';

/**
 * `GET /healthz` — the ALB and ECS health check. No auth. Verifies the
 * database pool with `SELECT 1`; a failing pool answers 503 so ECS restarts
 * the task rather than leaving it in rotation.
 *
 * `GET /api/health` — the same check on the path CloudFront forwards
 * (`/api/*`), polled by the web app's 503 page every 15 s.
 */
export function registerHealth(app: FastifyInstance, deps: Deps): void {
  const handler: RouteHandlerMethod = async (_request, reply) => {
    try {
      await deps.db.ping();
    } catch (error) {
      app.log.error({ err: error }, 'health: database unreachable');
      return reply.status(503).send({ ok: false, version: deps.version, database: 'unreachable' });
    }
    return { ok: true, version: deps.version };
  };
  app.get('/healthz', handler);
  app.get('/api/health', handler);
}
