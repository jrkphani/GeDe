// Test-first plan items 2/4/5/6 (issue 049): the pure op handlers, exercised
// against a fake `QueryExecutor` — no live Postgres reachable in tests
// (HANDOFF). The fake records exactly what SQL/params each operation issued,
// so these tests double as a proof that `rows`/`query` never string-concat
// anything caller-controlled into the executed SQL beyond what the
// whitelist/guard already approved.
import { describe, expect, it, vi } from 'vitest'
import { countsOperation, MAX_ROW_LIMIT, queryOperation, ROWS_WHITELIST, rowsOperation, type QueryExecutor } from './operations'

interface RecordedCall {
  readonly sql: string
  readonly params: readonly unknown[] | undefined
}

function fakeExecutor(handlers: Record<string, Record<string, unknown>[]>): QueryExecutor & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const query = vi.fn((sql: string, params?: readonly unknown[]) => {
    calls.push({ sql, params })
    for (const [pattern, rows] of Object.entries(handlers)) {
      if (sql.includes(pattern)) return Promise.resolve({ rows })
    }
    return Promise.resolve({ rows: [] })
  })
  return { calls, query }
}

/** Non-null helper for `executor.calls[n]` under `noUncheckedIndexedAccess` — throws (failing the test) if the call was never made. */
function callAt(calls: readonly RecordedCall[], index: number): RecordedCall {
  const call = calls[index]
  if (!call) throw new Error(`Expected a recorded call at index ${index}, but only ${calls.length} were made.`)
  return call
}

describe('countsOperation (test-first plan item 4)', () => {
  it('returns { table: count } for every public table', async () => {
    const executor = fakeExecutor({
      'pg_tables': [{ tablename: 'projects' }, { tablename: 'dimensions' }],
      'FROM "projects"': [{ count: '3' }],
      'FROM "dimensions"': [{ count: '0' }],
    })
    const result = await countsOperation(executor)
    expect(result).toEqual({ projects: 3, dimensions: 0 })
  })

  it('returns an empty object when the public schema has no tables', async () => {
    const executor = fakeExecutor({ pg_tables: [] })
    const result = await countsOperation(executor)
    expect(result).toEqual({})
  })

  it('never interpolates a tablename that fails the safe-identifier check', async () => {
    const executor = fakeExecutor({ pg_tables: [{ tablename: 'evil"; DROP TABLE projects; --' }] })
    const result = await countsOperation(executor)
    expect(result).toEqual({})
    // Only the pg_tables lookup itself was issued — the unsafe name was
    // never interpolated into a second query.
    expect(executor.calls).toHaveLength(1)
  })
})

describe('rowsOperation (test-first plan item 5)', () => {
  it('returns rows for a whitelisted table, ordered by updated_at desc', async () => {
    const executor = fakeExecutor({ 'FROM "projects"': [{ id: '1' }, { id: '2' }] })
    const result = await rowsOperation(executor, 'projects', 10)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rows).toHaveLength(2)
    expect(callAt(executor.calls, 0).sql).toContain('ORDER BY updated_at DESC')
  })

  it('rejects a non-whitelisted table without ever querying it', async () => {
    const executor = fakeExecutor({})
    const result = await rowsOperation(executor, 'pg_shadow', 10)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_whitelisted')
    expect(executor.calls).toHaveLength(0)
  })

  it('rejects a table name that is not in ROWS_WHITELIST even if it is a real public table (e.g. applied_mutations, no updated_at)', async () => {
    const executor = fakeExecutor({})
    const result = await rowsOperation(executor, 'applied_mutations', 10)
    expect(result.ok).toBe(false)
  })

  it('caps limit at MAX_ROW_LIMIT even when a larger limit is requested', async () => {
    const executor = fakeExecutor({ 'FROM "projects"': [] })
    await rowsOperation(executor, 'projects', 100_000)
    expect(callAt(executor.calls, 0).params).toEqual([MAX_ROW_LIMIT])
  })

  it('rejects a zero or negative limit', async () => {
    const executor = fakeExecutor({})
    expect((await rowsOperation(executor, 'projects', 0)).ok).toBe(false)
    expect((await rowsOperation(executor, 'projects', -5)).ok).toBe(false)
  })

  it('every table in ROWS_WHITELIST is accepted', async () => {
    for (const table of ROWS_WHITELIST) {
      const executor = fakeExecutor({ [`FROM "${table}"`]: [] })
      const result = await rowsOperation(executor, table, 5)
      expect(result.ok).toBe(true)
    }
  })
})

describe('queryOperation (test-first plan items 2/6)', () => {
  it('runs a guard-approved SELECT, wrapped and row-capped', async () => {
    const executor = fakeExecutor({ '_debug_guarded_query': [{ id: '1' }] })
    const result = await queryOperation(executor, 'SELECT * FROM projects')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rows).toEqual([{ id: '1' }])
    expect(callAt(executor.calls, 0).sql).toContain('LIMIT $1')
    expect(callAt(executor.calls, 0).params).toEqual([MAX_ROW_LIMIT])
  })

  it('never reaches the executor for a rejected statement', async () => {
    const executor = fakeExecutor({})
    const result = await queryOperation(executor, 'DROP TABLE projects')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_select')
    expect(executor.calls).toHaveLength(0)
  })

  it('never reaches the executor for a `;`-chained multi-statement', async () => {
    const executor = fakeExecutor({})
    const result = await queryOperation(executor, 'SELECT 1; DELETE FROM projects')
    expect(result.ok).toBe(false)
    expect(executor.calls).toHaveLength(0)
  })

  it('caps a custom rowCap to MAX_ROW_LIMIT', async () => {
    const executor = fakeExecutor({ '_debug_guarded_query': [] })
    await queryOperation(executor, 'SELECT * FROM projects', 10_000)
    expect(callAt(executor.calls, 0).params).toEqual([MAX_ROW_LIMIT])
  })
})
