// Read-path workspace scoping (issue 058) — the analogue of 057's
// `checkTenancy` on the write side: a shape subscription for a given table
// must be scoped to the caller's authorized workspace id(s), never
// table-global (design brief: "never an unscoped SELECT * that would leak
// cross-tenant rows over the read-path the way 057 closes the gap on the
// write-path").
//
// Pure/injectable — no Electric client, DB driver, or Vite import — so it is
// reachable from BOTH the browser bundle (src/sync/config.ts re-exports
// SYNCED_TABLES from here, the single source of truth for "which tables does
// this app sync") and server code (src/server/shapeProxy/handler.ts, the
// actual enforcement point). See that module's header for why the WHERE
// clause is built SERVER-SIDE, from the verified JWT's resolved workspace
// memberships, never from a client-supplied parameter — ElectricSQL's own
// documented security model (node_modules/@electric-sql/client/skills/
// electric-proxy-auth) is explicit that a client must never control a shape's
// `table`/`where`/`params`, since Electric's HTTP API has no per-request
// authorization of its own.
import type { TableName } from './syncDelta'

// Every base table this app syncs, in a stable order. Not an FK-apply-order
// requirement (src/db/sync.ts's two-pass strategy tolerates any order within
// a batch) — just the fixed list of shapes the read-path subscribes to.
// `workspace_members` is deliberately NOT included (056's own scope note:
// the shape-proxy resolves a caller's memberships by querying
// `workspace_members` directly server-side instead, see
// src/server/shapeProxy/albAdapter.ts — streaming it to clients isn't needed
// for that). `invitations` WAS excluded for the same reason until issue 062:
// a fresh, not-yet-member invitee has no membership row to resolve FROM, so
// there is no other delivery path for their own pending invite — see this
// table's email-scoped predicate below (`scopeToWorkspaces`'s `callerEmail`
// param), the one exception to "every shape is membership-scoped only".
export const SYNCED_TABLES: readonly TableName[] = [
  'projects',
  'tier1_purpose',
  'tier1_props',
  'tier2_tables',
  'tier2_entries',
  'dimensions',
  'parameters',
  'contexts',
  'bindings',
  'invitations',
]

// Six of the nine synced tables carry `workspace_id` directly (schema.ts);
// three (`tier2_entries`, `parameters`, `bindings`) don't — their workspace
// is reachable only by walking the FK chain to a workspace_id-bearing
// ancestor (tier2_entries -> tier2_tables, parameters -> dimensions,
// bindings -> contexts). This is the EXACT same FK-chain migration
// 0008_workspaces_rls.sql's RLS policies already walk for these three tables
// (see that file's `tier2_entries_select`/`parameters_select`/
// `bindings_select` policies) — this map is the read-path's mirror of that
// already-proven scoping logic, not a new invention.
//
// ElectricSQL's shape WHERE clause only supports subqueries behind an
// explicit opt-in (`ELECTRIC_FEATURE_FLAGS=allow_subqueries` — see
// deploy/cdk/lib/api-stack.ts's Electric task definition, which sets it
// deliberately for exactly this reason, and node_modules/@electric-sql/
// client/skills/electric-shapes/references/where-clause.md's "Unsupported"
// section: "Subqueries (experimental, requires ELECTRIC_FEATURE_FLAGS=
// allow_subqueries)"). Without that flag, `tier2_entries`/`parameters`/
// `bindings` could not be correctly scoped at all — flagged prominently in
// this issue's report as a deliberate, monitored risk (experimental Electric
// feature), not a silent gap.
const WORKSPACE_SCOPE_SQL: Readonly<Record<TableName, string>> = {
  projects: 'workspace_id = ANY($1::text[])',
  tier1_purpose: 'workspace_id = ANY($1::text[])',
  tier1_props: 'workspace_id = ANY($1::text[])',
  tier2_tables: 'workspace_id = ANY($1::text[])',
  dimensions: 'workspace_id = ANY($1::text[])',
  contexts: 'workspace_id = ANY($1::text[])',
  tier2_entries: 'table_id IN (SELECT id FROM tier2_tables WHERE workspace_id = ANY($1::text[]))',
  parameters: 'dimension_id IN (SELECT id FROM dimensions WHERE workspace_id = ANY($1::text[]))',
  bindings: 'context_id IN (SELECT id FROM contexts WHERE workspace_id = ANY($1::text[]))',
  // `invitations`' base (membership-only) predicate — the fallback used when
  // no caller email is available (see scopeToWorkspaces below for the real,
  // email-OR-membership predicate issue 062 actually ships for this table).
  invitations: 'workspace_id = ANY($1::text[])',
  // Not in SYNCED_TABLES (see above) — included for exhaustiveness
  // (TableName is a superset, mirrors electricProtocol.ts's own
  // forward-compatible SQL_TO_JS_COLUMNS map) so a future SYNCED_TABLES
  // addition can't silently ship unscoped.
  workspace_members: 'workspace_id = ANY($1::text[])',
}

// Issue 062 — the invitations-only email predicate: an invitee who is NOT
// YET a member of the inviting workspace (the common case — that is the
// whole point of an invitation) has no membership row `WORKSPACE_SCOPE_SQL`
// could ever match. This ORs in a second, by-VERIFIED-email clause so their
// own pending invite still streams to their device. `$2` is a plain scalar
// (not an array) — Electric's shape params are just a positional map, same
// mechanism as `$1`, so no new protocol capability is needed here.
const INVITATIONS_EMAIL_SCOPE_SQL = '(workspace_id = ANY($1::text[]) OR lower(email) = lower($2))'

export interface ShapeScope {
  readonly where: string
  /**
   * Positional params for the WHERE clause above. Every table except
   * `invitations` (with a caller email) carries exactly one: a Postgres
   * text[] array literal for `$1`. `invitations`, when scoped by email, adds
   * a second, plain-string `$2` — the caller's own verified email, NEVER a
   * client-supplied one (src/server/shapeProxy/handler.ts is what enforces
   * that boundary).
   */
  readonly params: readonly string[]
}

export class UnknownSyncTableError extends Error {
  constructor(table: string) {
    super(`"${table}" is not a synced table — refusing to build a shape scope for it`)
    this.name = 'UnknownSyncTableError'
  }
}

// Builds the workspace-scoped WHERE clause for one table's shape request,
// given the caller's authorized workspace id set (057's membership model —
// own + shared, never all workspaces). An EMPTY set scopes to `false` —
// matches nothing — rather than omitting the clause entirely: a caller with
// no known memberships (yet) gets an inert shape, never an unscoped one.
// This is the read-path's fail-closed default, mirroring 057's checkTenancy
// default-deny posture ("rejects any mutation... unless a real, seeded
// membership row" — the read-side has no membership row to check against
// here, so it defaults to nothing rather than everything).
// `callerEmail` (issue 062) is meaningful ONLY for `table === 'invitations'`
// — every other table ignores it entirely, keeping their single-param shape
// byte-for-byte unchanged (see syncScope.test.ts's "every OTHER SYNCED_TABLES
// table ignores a passed-in callerEmail" guard). When invitations IS scoped
// by a real caller email, the empty-membership fail-closed shortcut below is
// deliberately skipped: a not-yet-member invitee (workspaceIds = []) with a
// real email must still get a live, matches-by-email shape, never `false`
// (that would be the exact bug 062 exists to fix).
export function scopeToWorkspaces(
  table: TableName,
  workspaceIds: readonly string[],
  callerEmail?: string | null,
): ShapeScope {
  const predicate = WORKSPACE_SCOPE_SQL[table]
  if (!predicate) throw new UnknownSyncTableError(table)
  if (table === 'invitations' && callerEmail) {
    return { where: INVITATIONS_EMAIL_SCOPE_SQL, params: [toPgTextArrayLiteral(workspaceIds), callerEmail] }
  }
  if (workspaceIds.length === 0) return { where: 'false', params: [''] }
  return { where: predicate, params: [toPgTextArrayLiteral(workspaceIds)] }
}

// Postgres text[] array literal syntax: `{"id-a","id-b"}`. Defensively
// escapes backslashes/quotes even though workspace ids are UUIDv7s in
// practice (never containing these characters) — this must never assume its
// input is pre-sanitized (CLAUDE.md: no unchecked trust boundaries).
function toPgTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  return `{${escaped.join(',')}}`
}
