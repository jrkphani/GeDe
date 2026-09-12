/**
 * `GET /ws/:docId` — the document room endpoint.
 *
 * Browsers cannot set headers on a WebSocket, but they can offer subprotocols,
 * so the access token travels in `Sec-WebSocket-Protocol` as
 * `gede.v1, bearer.<token>` (issue #32); the server selects `gede.v1` and
 * never echoes the token. That is the only transport: a `?token=` query
 * parameter is ignored (#63 removed the one-release fallback #49 kept for the
 * rolling deploy), so a URL can never carry a credential the server would
 * honour — URLs reach access logs and browser history in ways headers do not.
 *
 * Verification happens in a `preValidation` hook, i.e. before the HTTP
 * upgrade completes; nothing about the document is sent to an unverified
 * caller. The outcome is delivered as a close code the provider can read —
 * 4401 unauthenticated, 4403 no access, 4404 unknown document — which needs
 * the upgrade to have happened (an HTTP 401 would surface in the browser
 * only as an opaque 1006).
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
/** The connection sent updates faster than the per-connection limit (#37); the client must not retry blindly. */
export const CLOSE_TOO_MANY_REQUESTS = 4429;
/** Standard "try again later": the socket stopped reading and its buffer filled (#37), or the task is full (#99). */
export const CLOSE_TRY_AGAIN_LATER = 1013;
/** Standard "invalid frame payload data": a frame that is not the protocol or an update that does not decode (#105). */
export const CLOSE_MALFORMED = 1007;
/** Standard "message too big": what `ws` sends for a frame over `WS_MAX_UPDATE_BYTES` (#99). */
export const CLOSE_MESSAGE_TOO_BIG = 1009;
/** The update would take the document past `DOC_MAX_BYTES` (#99, ADR-037); the client treats 44xx as terminal. */
export const CLOSE_TOO_LARGE = 4413;

/** The subprotocol the server selects; the client must offer it alongside `bearer.<token>`. */
export const WS_SUBPROTOCOL = 'gede.v1';
/** Prefix of the subprotocol entry that carries the access token. */
export const WS_BEARER_PREFIX = 'bearer.';

export type WsAuthOutcome =
  | {
      ok: true;
      user: AuthUser;
      documentId: string;
      permission: DocumentPermission;
      /** When the presented token expires (ms epoch), for the periodic re-check (#104). */
      tokenExpiresAt: number | null;
    }
  | { ok: false; code: number; reason: string };

declare module 'fastify' {
  interface FastifyRequest {
    wsAuth?: WsAuthOutcome;
  }
}

const params = z.object({ docId: z.string().uuid() });

/** Split a `Sec-WebSocket-Protocol` value (one header, or several joined) into its entries. */
export function parseSubprotocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/**
 * The access token a client offered as a subprotocol, or `undefined`. A
 * `bearer.` entry without `gede.v1` beside it is still read (the client is
 * telling us who it is); what the server selects is decided in
 * `selectSubprotocol`, which `ws` calls after this hook.
 */
export function tokenFromSubprotocols(header: string | string[] | undefined): string | undefined {
  for (const entry of parseSubprotocols(header)) {
    if (entry.startsWith(WS_BEARER_PREFIX) && entry.length > WS_BEARER_PREFIX.length) {
      return entry.slice(WS_BEARER_PREFIX.length);
    }
  }
  return undefined;
}

/**
 * `ws`'s `handleProtocols`: select `gede.v1` when offered, otherwise nothing —
 * a `bearer.<token>` entry must never be selected, or the token would be sent
 * back in the response headers. A browser that offered protocols and gets
 * none selected fails the handshake itself, which is the right outcome for a
 * client that does not speak `gede.v1`.
 */
export function selectSubprotocol(offered: Set<string>): string | false {
  return offered.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false;
}

/** The access token offered on the upgrade, or `undefined`. The subprotocol is the only place it is read from. */
export function extractToken(request: Pick<FastifyRequest, 'headers'>): string | undefined {
  return tokenFromSubprotocols(request.headers['sec-websocket-protocol']);
}

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
  const token = extractToken(request);
  if (token === undefined) {
    return { ok: false, code: CLOSE_UNAUTHENTICATED, reason: 'missing token' };
  }

  let user: AuthUser;
  try {
    user = await deps.resolver.fromToken(token);
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
  return {
    ok: true,
    user,
    documentId: p.data.docId,
    permission: resolved.permission,
    tokenExpiresAt: user.tokenExpiresAt,
  };
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
      // A refused join (task full, too many sockets, #99) has already closed
      // the socket with its code and written its metric line.
      const conn = deps.rooms.join(outcome.documentId, socket, {
        userId: outcome.user.id,
        permission: outcome.permission,
        tokenExpiresAt: outcome.tokenExpiresAt,
      });
      if (conn === undefined) return;
      request.log.info(
        { documentId: outcome.documentId, userId: outcome.user.id, permission: outcome.permission },
        'websocket joined',
      );
    },
  );
}
