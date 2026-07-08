// Test-first plan items 1/4/5/6 (issue 049): the debug API's core handler,
// exercised end-to-end (auth gate -> route -> op) against a fake
// QueryExecutor — no live Postgres reachable in tests (HANDOFF).
import { describe, expect, it, vi } from 'vitest'
import { handleDebugRequest, type DebugApiDeps } from './handler'
import type { QueryExecutor } from './operations'

const EXPECTED_TOKEN = 'super-secret-debug-token-0123456789'

function fakeExecutor(handlers: Record<string, Record<string, unknown>[]> = {}): QueryExecutor {
  const query = vi.fn((sql: string) => {
    for (const [pattern, rows] of Object.entries(handlers)) {
      if (sql.includes(pattern)) return Promise.resolve({ rows })
    }
    return Promise.resolve({ rows: [] })
  })
  return { query }
}

function deps(executor: QueryExecutor = fakeExecutor()): DebugApiDeps {
  return { expectedToken: EXPECTED_TOKEN, executor }
}

describe('handleDebugRequest — auth gate (test-first plan item 1, "never unauthenticated")', () => {
  it('rejects with 401 when no token is provided', async () => {
    const result = await handleDebugRequest({ providedToken: undefined, operation: { kind: 'counts' } }, deps())
    expect(result.status).toBe(401)
    if (result.status === 401) expect(result.error.reason).toBe('missing_token')
  })

  it('rejects with 401 when the token is wrong', async () => {
    const result = await handleDebugRequest({ providedToken: 'wrong-token', operation: { kind: 'counts' } }, deps())
    expect(result.status).toBe(401)
    if (result.status === 401) expect(result.error.reason).toBe('invalid_token')
  })

  it('rejects with 401 for a token that is a prefix of the real one (no partial-match leniency)', async () => {
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN.slice(0, -1), operation: { kind: 'counts' } },
      deps(),
    )
    expect(result.status).toBe(401)
  })

  it('never touches the executor when the token is missing or wrong', async () => {
    const executor = fakeExecutor()
    await handleDebugRequest({ providedToken: undefined, operation: { kind: 'counts' } }, deps(executor))
    await handleDebugRequest({ providedToken: 'nope', operation: { kind: 'query' as const, sql: 'SELECT 1' } }, deps(executor))
    expect(executor.query).not.toHaveBeenCalled()
  })

  it('accepts a request with the correct token', async () => {
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN, operation: { kind: 'counts' } },
      deps(fakeExecutor({ pg_tables: [] })),
    )
    expect(result.status).toBe(200)
  })
})

describe('handleDebugRequest — routing', () => {
  it('routes "counts" to countsOperation', async () => {
    const executor = fakeExecutor({
      pg_tables: [{ tablename: 'projects' }],
      'FROM "projects"': [{ count: '2' }],
    })
    const result = await handleDebugRequest({ providedToken: EXPECTED_TOKEN, operation: { kind: 'counts' } }, deps(executor))
    expect(result.status).toBe(200)
    if (result.status === 200) expect(result.data).toEqual({ projects: 2 })
  })

  it('routes "rows" to rowsOperation, rejecting a non-whitelisted table with 400', async () => {
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN, operation: { kind: 'rows', table: 'pg_shadow', limit: 10 } },
      deps(),
    )
    expect(result.status).toBe(400)
    if (result.status === 400) expect(result.error.reason).toBe('not_whitelisted')
  })

  it('routes "rows" to rowsOperation for a whitelisted table', async () => {
    const executor = fakeExecutor({ 'FROM "projects"': [{ id: '1' }] })
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN, operation: { kind: 'rows', table: 'projects', limit: 10 } },
      deps(executor),
    )
    expect(result.status).toBe(200)
    if (result.status === 200) expect(result.data).toEqual([{ id: '1' }])
  })

  it('routes "query" to queryOperation, rejecting a non-SELECT with 400 (never touching the executor)', async () => {
    const executor = fakeExecutor()
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN, operation: { kind: 'query', sql: 'DROP TABLE projects' } },
      deps(executor),
    )
    expect(result.status).toBe(400)
    expect(executor.query).not.toHaveBeenCalled()
  })

  it('routes "query" to queryOperation for a guard-approved SELECT', async () => {
    const executor = fakeExecutor({ _debug_guarded_query: [{ id: '1' }] })
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN, operation: { kind: 'query', sql: 'SELECT * FROM projects' } },
      deps(executor),
    )
    expect(result.status).toBe(200)
    if (result.status === 200) expect(result.data).toEqual([{ id: '1' }])
  })

  it('rejects a `;`-chained query even with a valid token', async () => {
    const executor = fakeExecutor()
    const result = await handleDebugRequest(
      { providedToken: EXPECTED_TOKEN, operation: { kind: 'query', sql: 'SELECT 1; DELETE FROM projects' } },
      deps(executor),
    )
    expect(result.status).toBe(400)
    if (result.status === 400) expect(result.error.reason).toBe('multiple_statements')
    expect(executor.query).not.toHaveBeenCalled()
  })
})
