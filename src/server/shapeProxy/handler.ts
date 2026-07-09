// The ElectricSQL shape-proxy's pure decision core (issue 058). This is the
// read-path's analogue of src/server/writeApi/handler.ts's checkTenancy: the
// browser NEVER talks to Electric directly (node_modules/@electric-sql/
// client/skills/electric-proxy-auth's own "CRITICAL: Calling Electric
// directly from production client" — Electric's HTTP API is public by
// default with no per-request auth of its own). Instead the browser calls
// THIS proxy (routed through the same ALB/CloudFront `/sync*` path 030/047
// already established for the other server-side APIs), which:
//
//   1. verifies the caller's Cognito JWT (reusing src/server/writeApi/jwt.ts
//      — the exact same validation the write-path already performs),
//   2. resolves which workspaces that verified `sub` is currently a member
//      of (057's model: own + shared, via a `workspace_members` lookup — the
//      read-path's counterpart to `checkTenancy`'s `isMember` check),
//   3. builds a workspace-scoped WHERE clause (src/domain/syncScope.ts) for
//      the requested table, and
//   4. returns the fully-formed URL to Electric's REAL, VPC-private shape
//      endpoint — the caller (src/server/shapeProxy/albAdapter.ts) then
//      performs the actual forwarding fetch and relays the response.
//
// The client NEVER supplies `table`'s scope, `where`, or `params` — per
// electric-proxy-auth's documented pattern ("Only forward
// ELECTRIC_PROTOCOL_QUERY_PARAMS... forwarding all params lets the client
// control table/where/columns, accessing any Postgres table"), only
// Electric's own protocol pagination params (offset/handle/live/cursor/
// cache-buster) pass through untouched.
import { verifyBearerToken, type JwtVerifierConfig } from '../writeApi/jwt'
import { scopeToWorkspaces, SYNCED_TABLES } from '../../domain/syncScope'
import type { TableName } from '../../domain/syncDelta'

// ElectricSQL's own reserved shape-protocol query params (see
// node_modules/@electric-sql/client/dist/index.d.ts's
// ELECTRIC_PROTOCOL_QUERY_PARAMS / OFFSET_QUERY_PARAM / SHAPE_HANDLE_
// QUERY_PARAM / LIVE_QUERY_PARAM / LIVE_CACHE_BUSTER_QUERY_PARAM /
// CACHE_BUSTER_QUERY_PARAM) — named as string literals here rather than
// imported, since importing the real client package into server code would
// pull in a browser-oriented dependency this Lambda doesn't otherwise need.
const FORWARDABLE_PARAMS = ['offset', 'handle', 'live', 'cursor', 'cache-buster'] as const

export interface ShapeProxyDeps {
  readonly jwt: JwtVerifierConfig
  /** Every workspace id `sub` currently has a live (non-tombstoned) `workspace_members` row for — own + shared, per 057's membership model. */
  readonly listWorkspaceIdsForSub: (sub: string) => Promise<string[]>
  /** Electric's own shape endpoint base — a VPC-private address (Cloud Map DNS), never reachable from the internet directly (see api-stack.ts). */
  readonly electricBaseUrl: string
  /** Required in production (Electric refuses `/v1/shape` without it unless ELECTRIC_INSECURE=true — never set here). */
  readonly electricSecret: string
}

export interface ShapeProxyRequest {
  readonly authorizationHeader: string | undefined
  readonly table: string | undefined
  /** The incoming request's raw query params — only FORWARDABLE_PARAMS entries are read; everything else (including any client-supplied `where`/`params`) is ignored. */
  readonly query: Readonly<Record<string, string | undefined>>
}

export type ShapeProxyResolution =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly status: 400 | 401 | 403; readonly error: string }

function isSyncedTable(value: string): value is TableName {
  return (SYNCED_TABLES as readonly string[]).includes(value)
}

/**
 * Resolves an incoming shape request into a fully-formed, workspace-scoped
 * URL to forward to Electric's real (VPC-private) `/v1/shape` endpoint.
 * Test-first plan item 2 (058's own acceptance criterion): "a passing-but-
 * unscoped shape [is] a FAILING test even if data happens to come back
 * correctly" — this function is what makes that assertion checkable without
 * a live Electric server: every `ok: true` resolution's URL carries a
 * `where`/`params[1]` pair scoped to the verified caller's actual
 * memberships, never a bare `table=` with no scope at all.
 */
export async function resolveShapeRequest(
  request: ShapeProxyRequest,
  deps: ShapeProxyDeps,
): Promise<ShapeProxyResolution> {
  const auth = await verifyBearerToken(request.authorizationHeader, deps.jwt)
  if (!auth.ok) {
    // missing_token -> no credential presented at all (401); every other
    // reason (invalid/expired/missing_claims) means a credential WAS
    // presented but didn't verify (403) — mirrors handler.ts's own
    // status-code split for the write-path's identical AuthResult union.
    const status = auth.reason === 'missing_token' ? 401 : 403
    return { ok: false, status, error: auth.reason }
  }

  if (!request.table || !isSyncedTable(request.table)) {
    return { ok: false, status: 400, error: 'unknown_table' }
  }

  const workspaceIds = await deps.listWorkspaceIdsForSub(auth.claims.sub)
  // Issue 062 — the invitations-only email scope. `auth.claims.email` comes
  // straight off the VERIFIED JWT payload (src/server/writeApi/jwt.ts) —
  // never from `request.query`, which is never even read for anything but
  // FORWARDABLE_PARAMS below. scopeToWorkspaces ignores this argument for
  // every table except `invitations` (src/domain/syncScope.ts), so passing
  // it unconditionally here is safe for the other nine.
  const scope = scopeToWorkspaces(request.table, workspaceIds, auth.claims.email)

  const url = new URL('/v1/shape', deps.electricBaseUrl)
  url.searchParams.set('table', request.table)
  url.searchParams.set('where', scope.where)
  scope.params.forEach((value, index) => {
    url.searchParams.set(`params[${index + 1}]`, value)
  })
  url.searchParams.set('secret', deps.electricSecret)
  for (const param of FORWARDABLE_PARAMS) {
    const value = request.query[param]
    if (value !== undefined) url.searchParams.set(param, value)
  }

  return { ok: true, url: url.toString() }
}
