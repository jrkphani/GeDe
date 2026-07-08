// The debug/db inspection API's core request handler (issue 049) — the
// runtime-agnostic heart of the Lambda, mirroring src/server/writeApi/
// handler.ts vs albAdapter.ts (ADR-0010: "thin, not fat"). Pure orchestration
// over an injected QueryExecutor + expected token, so it is fully
// unit-testable without AWS/ALB/Postgres (HANDOFF: "no live AWS/Electric/
// Cognito reachable in tests"). `albAdapter.ts` is the thin, AWS-event-shaped
// wrapper that calls into this from a real Lambda.
import { timingSafeEqual } from 'node:crypto'
import { countsOperation, queryOperation, rowsOperation, type QueryExecutor } from './operations'

export type DebugOperation =
  | { readonly kind: 'counts' }
  | { readonly kind: 'rows'; readonly table: string; readonly limit: number }
  | { readonly kind: 'query'; readonly sql: string }

export interface DebugApiRequest {
  /** The value presented via `x-debug-token` or `Authorization: Bearer <token>` — undefined if neither was sent. */
  readonly providedToken: string | undefined
  readonly operation: DebugOperation
}

export interface DebugApiDeps {
  /** The shared secret from Secrets Manager (issue 049 — never the repo, never a default). */
  readonly expectedToken: string
  readonly executor: QueryExecutor
}

export type DebugApiFailureReason =
  | 'missing_token'
  | 'invalid_token'
  | 'not_whitelisted'
  | 'invalid_limit'
  | 'empty_statement'
  | 'not_select'
  | 'multiple_statements'
  | 'forbidden_keyword'
  | 'unterminated_literal'

export type DebugApiResult =
  | { readonly status: 401; readonly error: { readonly reason: 'missing_token' | 'invalid_token'; readonly message: string } }
  | { readonly status: 400; readonly error: { readonly reason: DebugApiFailureReason; readonly message: string } }
  | { readonly status: 200; readonly data: unknown }

/**
 * Constant-time token comparison — a naive `===` leaks timing information
 * proportional to the number of matching leading characters. Length is
 * compared first (timingSafeEqual throws on a length mismatch rather than
 * returning false), which itself doesn't leak anything useful about a
 * high-entropy shared secret.
 */
function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

/**
 * Test-first plan item 1 (auth gate): every request — `counts`, `rows`, and
 * `query` alike — is secret-gated. No/invalid `x-debug-token`/bearer secret
 * is rejected with 401 BEFORE any operation runs; the DB is never touched by
 * an unauthenticated caller. "Never unauthenticated" (issue 049 Scope).
 */
export async function handleDebugRequest(request: DebugApiRequest, deps: DebugApiDeps): Promise<DebugApiResult> {
  if (!request.providedToken) {
    return { status: 401, error: { reason: 'missing_token', message: 'A debug token is required.' } }
  }
  if (!tokensMatch(request.providedToken, deps.expectedToken)) {
    return { status: 401, error: { reason: 'invalid_token', message: 'The provided debug token is invalid.' } }
  }

  const { operation } = request

  if (operation.kind === 'counts') {
    const data = await countsOperation(deps.executor)
    return { status: 200, data }
  }

  if (operation.kind === 'rows') {
    const result = await rowsOperation(deps.executor, operation.table, operation.limit)
    if (!result.ok) return { status: 400, error: { reason: result.reason, message: result.message } }
    return { status: 200, data: result.rows }
  }

  // operation.kind === 'query'
  const result = await queryOperation(deps.executor, operation.sql)
  if (!result.ok) return { status: 400, error: { reason: result.reason, message: result.message } }
  return { status: 200, data: result.rows }
}
