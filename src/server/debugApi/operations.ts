// The debug/db inspection API's pure op handlers (issue 049). Everything
// here runs over an INJECTED `QueryExecutor` port, so it is fully
// unit-testable without a live Postgres (HANDOFF: "no live AWS/Electric/
// Cognito reachable in tests") — mirrors src/server/writeApi/store.ts's
// `WriteStore` seam (ADR-0010). `albAdapter.ts` is the only file that wires a
// real `pg` connection (and, critically, the read-only-transaction +
// statement_timeout guard #2) behind this interface.
import { guardSelectOnlySql } from './sqlGuard'

export interface QueryExecutor {
  // A property-typed (arrow-shaped) member, not a method-shorthand — callers
  // (including these pure ops and the test fakes) pass this value around
  // and reference it directly (`expect(executor.query).not.toHaveBeenCalled()`),
  // which a method-shorthand declaration would flag as an unbound-method
  // risk. Rows are untyped (`Record<string, unknown>`) at this seam — each
  // op reads the specific fields it expects off a row, exactly like
  // src/server/writeApi/store.ts's `PgWriteStore` does with raw `pg` rows.
  readonly query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>
}

/** Guard #3 (Design brief): every operation is row-capped, regardless of what the caller asked for. */
export const MAX_ROW_LIMIT = 100

/**
 * The tables `rows` is allowed to read — deliberately snake_case, matching
 * src/db/schema.ts's `pgTable(...)` first argument, and deliberately
 * excluding `__migrations` (server bookkeeping, no `updated_at`) and
 * `applied_mutations` (the write-path's idempotency ledger, no `updated_at`
 * either — visible via `counts`, just not `rows`, since "recent rows ordered
 * by updated_at" doesn't apply to it).
 */
export const ROWS_WHITELIST = [
  'workspaces',
  'workspace_members',
  'invitations',
  'projects',
  'tier1_purpose',
  'tier1_props',
  'tier2_tables',
  'tier2_entries',
  'dimensions',
  'parameters',
  'contexts',
  'bindings',
] as const

export type WhitelistedTable = (typeof ROWS_WHITELIST)[number]

const ROWS_WHITELIST_SET: ReadonlySet<string> = new Set(ROWS_WHITELIST)

/** Defensive identifier check — `pg_tables.tablename` is always safe, but never trust that without checking. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * `counts` operation (test-first plan item 4) — `{ table: count }` for every
 * table in the `public` schema. This is the repeatable form of the one-off
 * `scratchpad/qlambda` handler's single `count(*)` (issue 049 motivation) —
 * lifted and hardened: identifier-validated before being interpolated into
 * a per-table `count(*)`, since `pg_tables` names can't be bind-parameterized
 * as a FROM target.
 */
export async function countsOperation(executor: QueryExecutor): Promise<Record<string, number>> {
  const tablesResult = await executor.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  )

  const counts: Record<string, number> = {}
  for (const row of tablesResult.rows) {
    const tablename = row.tablename
    if (typeof tablename !== 'string' || !SAFE_IDENTIFIER.test(tablename)) continue // defense-in-depth; pg_tables names are always safe in practice
    const countResult = await executor.query(`SELECT count(*) AS count FROM "${tablename}"`)
    counts[tablename] = Number(countResult.rows[0]?.count ?? 0)
  }
  return counts
}

export type RowsResult =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly reason: 'not_whitelisted' | 'invalid_limit'; readonly message: string }

/**
 * `rows` operation (test-first plan item 5) — the most recent rows of ONE
 * whitelisted table, ordered by `updated_at desc`, hard-capped at
 * `MAX_ROW_LIMIT` regardless of what `limit` asks for. A non-whitelisted
 * table is rejected outright — never interpolated into SQL.
 */
export async function rowsOperation(
  executor: QueryExecutor,
  table: string,
  limit: number,
): Promise<RowsResult> {
  if (!ROWS_WHITELIST_SET.has(table)) {
    return {
      ok: false,
      reason: 'not_whitelisted',
      message: `"${table}" is not a whitelisted table. Allowed: ${ROWS_WHITELIST.join(', ')}.`,
    }
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return { ok: false, reason: 'invalid_limit', message: 'limit must be a positive integer.' }
  }

  const cappedLimit = Math.min(limit, MAX_ROW_LIMIT)
  // `table` is checked against ROWS_WHITELIST_SET (a fixed, compile-time
  // constant set) immediately above — never raw user input — before being
  // interpolated here; the row cap is bound as a real parameter.
  const result = await executor.query(`SELECT * FROM "${table}" ORDER BY updated_at DESC LIMIT $1`, [cappedLimit])
  return { ok: true, rows: result.rows }
}

export type QueryOperationResult =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | {
      readonly ok: false
      readonly reason: 'empty_statement' | 'not_select' | 'multiple_statements' | 'forbidden_keyword' | 'unterminated_literal'
      readonly message: string
    }

/**
 * `query` operation (test-first plan item 2/6) — the guarded, operator-
 * supplied `SELECT`. Runs `sqlGuard` FIRST; only a guard-approved statement
 * ever reaches `executor.query`, and even then it is wrapped as a subquery
 * with a hard `LIMIT`, so an internal `LIMIT`/lack thereof in the operator's
 * own SQL can never defeat the row cap.
 */
export async function queryOperation(
  executor: QueryExecutor,
  rawSql: string,
  rowCap: number = MAX_ROW_LIMIT,
): Promise<QueryOperationResult> {
  const guarded = guardSelectOnlySql(rawSql)
  if (!guarded.ok) return { ok: false, reason: guarded.reason, message: guarded.message }

  const cappedRowCap = Math.max(1, Math.min(rowCap, MAX_ROW_LIMIT))
  const result = await executor.query(
    `SELECT * FROM (${guarded.sql}) AS _debug_guarded_query LIMIT $1`,
    [cappedRowCap],
  )
  return { ok: true, rows: result.rows }
}
