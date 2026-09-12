/**
 * `GET /ws/:docId` — the document room endpoint.
 *
 * Browsers cannot set headers on a WebSocket, so the access token travels as
 * `?token=`. Verification happens in a `preValidation` hook, i.e. before the
 * HTTP upgrade completes; nothing about the document is sent to an
 * unverified caller. The outcome is delivered as a close code the provider
 * can read — 4401 unauthenticated, 4403 no access, 4404 unknown document —
 * which needs the upgrade to have happened (an HTTP 401 would surface in the
 * browser only as an opaque 1006).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { UserResolver, AuthUser } from '../auth.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { resolvePermission } from '../permissions.js';
import type { DocumentPermission, Repo } from '../repo/types.js';
import type { RoomManager } from './room-manager.js';

export const CLOSE_UNAUTHENTICATED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_BAD_REQUEST = 4400;

export type WsAuthOutcome =
  | { ok: true; user: AuthUser; documentId: string; permission: DocumentPermission }
  | { ok: false; code: number; reason: string };

declare module 'fastify' {
  interface FastifyRequest {
    wsAuth?: WsAuthOutcome;
  }
}

const params = z.object({ docId: z.string().uuid() });
const query = z.object({ token: z.string().min(1) });

export async function authoriseUpgrade(
  request: FastifyRequest,
  deps: { config: Config; repo: Repo; resolver: UserResolver },
): Promise<WsAuthOutcome> {
  const origin = request.headers.origin;
  if (origin !== deps.config.WEB_ORIGIN) {
    return { ok: false, code: CLOSE_FORBIDDEN, reason: 'origin not allowed' };
  }
  const p = params.safeParse(request.params);
  if (!p.success) return { ok: false, code: CLOSE_BAD_REQUEST, reason: 'bad document id' };
  const q = query.safeParse(request.query);
  if (!q.success) return { ok: false, code: CLOSE_UNAUTHENTICATED, reason: 'missing token' };

  let user: AuthUser;
  try {
    user = await deps.resolver.fromToken(q.data.token);
  } catch (error) {
    if (error instanceof AppError && error.status === 401) {
      return { ok: false, code: CLOSE_UNAUTHENTICATED, reason: 'invalid token' };
    }
    throw error;
  }

  const resolved = await resolvePermission(deps.repo, user.id, p.data.docId);
  if (!resolved) return { ok: false, code: CLOSE_NOT_FOUND, reason: 'no such document' };
  if (resolved.permission === null) {
    return { ok: false, code: CLOSE_FORBIDDEN, reason: 'not a participant' };
  }
  // A deleted document is served to nobody, its owner included; participants
  // and the owner learn it is gone (4404), a stranger only that they have no access.
  if (resolved.document.deletedAt !== null) {
    return { ok: false, code: CLOSE_NOT_FOUND, reason: 'document deleted' };
  }
  return { ok: true, user, documentId: p.data.docId, permission: resolved.permission };
}

export function registerWs(
  app: FastifyInstance,
  deps: { config: Config; repo: Repo; resolver: UserResolver; rooms: RoomManager },
): void {
  app.get(
    '/ws/:docId',
    {
      websocket: true,
      preValidation: async (request) => {
        request.wsAuth = await authoriseUpgrade(request, deps);
      },
    },
    (socket, request) => {
      const outcome = request.wsAuth;
      if (!outcome) {
        socket.close(1011, 'auth hook did not run');
        return;
      }
      if (!outcome.ok) {
        request.log.info({ code: outcome.code, reason: outcome.reason }, 'websocket refused');
        socket.close(outcome.code, outcome.reason);
        return;
      }
      request.log.info(
        { documentId: outcome.documentId, userId: outcome.user.id, permission: outcome.permission },
        'websocket joined',
      );
      deps.rooms.join(outcome.documentId, socket, {
        userId: outcome.user.id,
        permission: outcome.permission,
      });
    },
  );
}
