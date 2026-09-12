/**
 * The logger contract the service depends on: pino's call shapes, so a pino
 * instance satisfies it directly and tests can pass `pino({ level: 'silent' })`.
 *
 * `requestSerializer` replaces Fastify's default `req` serializer (Fastify
 * takes serializers from the pino instance it is given): the same fields, with
 * any `token` query parameter redacted. The server no longer reads a token
 * from the URL (#63), but a client that puts one there anyway must never see
 * it land in a log line (#34) — defence in depth.
 */
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

export type Logger = FastifyBaseLogger;

const TOKEN_PARAM = /([?&]token=)[^&#]*/gi;

/** `/ws/abc?token=eyJ…&x=1` → `/ws/abc?token=[redacted]&x=1`. */
export function redactTokenParam(url: string): string {
  return url.replace(TOKEN_PARAM, '$1[redacted]');
}

export interface SerializedRequest {
  method: string | undefined;
  url: string;
  host: string | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
}

export function requestSerializer(
  request: Partial<Pick<FastifyRequest, 'method' | 'url' | 'host' | 'ip' | 'socket'>>,
): SerializedRequest {
  // A serializer must never throw: pino calls it for anything logged under
  // `req`, including a partial object from a careless call site.
  return {
    method: request.method,
    url: typeof request.url === 'string' ? redactTokenParam(request.url) : '',
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** Header paths pino redacts wholesale, in case a caller ever logs a raw request. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["sec-websocket-protocol"]',
  'headers.authorization',
  'headers["sec-websocket-protocol"]',
];
