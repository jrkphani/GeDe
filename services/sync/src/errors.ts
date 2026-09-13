/**
 * Error contract shared with the SPA's error pages (ARCHITECTURE §3): every
 * failure is `{ error: { code, message, ref } }` where `ref` is the request id
 * also sent as `x-request-id`, so a user can quote it and support can find
 * the log line.
 */
import { randomBytes } from 'node:crypto';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  /** `DELETE /api/documents/:id` on a workscape that has been shared: archive it instead (LIB-D2). */
  | 'shared'
  /** Delete or Archive on the guided sample (LIB-D10). */
  | 'sample'
  /** `PATCH /api/me { idToken }`: the row already carries a different address (review of #76). */
  | 'email_bound'
  /** An invitation past its 14 days (410). */
  | 'expired'
  /** Invite or Resend to an address SES bounced or that complained (409, ADR-046). */
  | 'address_suppressed'
  /** The caller's account has been erased (#111); the tombstone refuses its remaining tokens (403). */
  | 'account_deleted'
  | 'too_many_requests'
  | 'server_error'
  | 'unavailable';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; ref: string; details?: unknown };
}

/** Short hex request id, e.g. `4a19c2f0` — the shape the error pages show as `ref`. */
export function newRequestId(): string {
  return randomBytes(4).toString('hex');
}

function isFastifyError(error: unknown): error is FastifyError {
  return typeof error === 'object' && error !== null && 'statusCode' in error && 'code' in error;
}

export function errorBody(error: unknown, ref: string): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message, ref } };
    if (error.details !== undefined) body.error.details = error.details;
    return { status: error.status, body };
  }
  if (isFastifyError(error) && typeof error.statusCode === 'number' && error.statusCode < 500) {
    const code: ErrorCode =
      error.statusCode === 404
        ? 'not_found'
        : error.statusCode === 429
          ? 'too_many_requests'
          : 'bad_request';
    return { status: error.statusCode, body: { error: { code, message: error.message, ref } } };
  }
  return {
    status: 500,
    body: { error: { code: 'server_error', message: 'Something failed on our side', ref } },
  };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const { status, body } = errorBody(error, request.id);
    if (status >= 500) {
      request.log.error({ err: error, ref: request.id }, 'request failed');
    } else {
      request.log.info({ status, code: body.error.code, ref: request.id }, body.error.message);
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body: ErrorBody = {
      error: { code: 'not_found', message: 'Nothing at this address', ref: request.id },
    };
    void reply.status(404).send(body);
  });
}
