// Contract test for PgWriteStore (issue 043) — proves the tenant-context /
// transaction wiring WITHOUT a live Postgres (HANDOFF: "no live AWS/Electric/
// Cognito reachable in tests"). A fake `pg`-shaped pool/client records every
// SQL statement issued; the assertions below are the "defense-in-depth"
// half of test-first plan item 2 ("RLS refuses it too") that this repo can
// exercise pre-034: proving the write path ALWAYS sets the tenant-context
// GUCs (`app.current_user_id` / `app.current_workspace_id`) inside the same
// transaction as the actual write, before that write runs — the precondition
// that makes 034's future RLS policies effective. It does not (and cannot,
// without 034's migration + policies + a live database) prove RLS itself
// blocks a cross-tenant row; that half is deferred to issue 034 landing.
import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { Pool } from 'pg'
import { PgWriteStore } from './store'
import type { MutationEnvelope } from '../../domain/mutationProtocol'

/** The fakes below only implement the one `pg.Pool` method PgWriteStore calls. */
function asPool(fake: { connect: () => Promise<unknown> }): Pool {
  return fake as unknown as Pool
}

interface RecordedQuery {
  readonly text: string
  readonly params: readonly unknown[]
}

function fakePool(rowsToReturn: Record<string, unknown[]> = {}) {
  const calls: RecordedQuery[] = []
  const client = {
    query: (text: string, params: unknown[] = []) => {
      calls.push({ text, params })
      const key = Object.keys(rowsToReturn).find((k) => text.includes(k))
      return Promise.resolve({ rows: key ? rowsToReturn[key] : [] })
    },
    release: () => undefined,
  }
  const pool = { connect: () => Promise.resolve(client) }
  return { pool, calls }
}

function envelope(overrides: Partial<MutationEnvelope> = {}): MutationEnvelope {
  return {
    id: uuidv7(),
    workspaceId: 'ws-1',
    table: 'projects',
    op: 'insert',
    entityId: uuidv7(),
    payload: { name: 'New project' },
    clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Pulls the `(col, col, ...)` list out of an `INSERT INTO t (...)` statement. */
function parseInsertColumns(sql: string): string[] {
  const columnList = /INSERT INTO \S+ \(([^)]+)\)/.exec(sql)?.[1]
  if (columnList === undefined) throw new Error(`no INSERT column list found in: ${sql}`)
  return columnList.split(',').map((s) => s.trim())
}

/** Pulls the `($1, $2, ...)` placeholder list out of an `INSERT ... VALUES (...)` statement. */
function parseValuesPlaceholders(sql: string): string[] {
  const valuesList = /VALUES \(([^)]+)\)/.exec(sql)?.[1]
  if (valuesList === undefined) throw new Error(`no VALUES list found in: ${sql}`)
  return valuesList.split(',').map((s) => s.trim())
}

/** Pulls `col = $N` pairs (as `[col, placeholder]`) out of an `UPDATE ... SET ... WHERE` statement. */
function parseSetClause(sql: string): [string, string][] {
  const setList = / SET (.+) WHERE/.exec(sql)?.[1]
  if (setList === undefined) throw new Error(`no SET clause found in: ${sql}`)
  return setList.split(',').map((assignment) => {
    const parts = assignment.split('=').map((s) => s.trim())
    const col = parts[0]
    const placeholder = parts[1]
    if (col === undefined || placeholder === undefined) {
      throw new Error(`malformed SET assignment: ${assignment}`)
    }
    return [col, placeholder]
  })
}

describe('PgWriteStore.applyIfNew — tenant-context wiring (defense-in-depth, test-first plan item 2)', () => {
  it('sets the user + workspace GUCs, in a BEGIN...COMMIT, before the ledger insert or the actual write', async () => {
    const { pool, calls } = fakePool({ applied_mutations: [{ mutation_id: 'x' }] })
    const store = new PgWriteStore({ pool: asPool(pool) })

    await store.applyIfNew(envelope(), 'user-42')

    const texts = calls.map((c) => c.text)
    expect(texts[0]).toBe('BEGIN')
    expect(texts[1]).toContain('set_config')
    expect(calls[1]?.params).toEqual(['app.current_user_id', 'user-42'])
    expect(texts[2]).toContain('set_config')
    expect(calls[2]?.params).toEqual(['app.current_workspace_id', 'ws-1'])
    expect(texts[3]).toContain('applied_mutations')
    expect(texts[4]).toContain('INSERT INTO projects')
    expect(texts[5]).toBe('COMMIT')
  })

  it('rolls back and never issues the actual write if an error occurs mid-transaction', async () => {
    const calls: RecordedQuery[] = []
    let queryCount = 0
    const client = {
      query: (text: string, params: unknown[] = []) => {
        calls.push({ text, params })
        queryCount++
        if (queryCount === 4) return Promise.reject(new Error('simulated ledger failure'))
        return Promise.resolve({ rows: [] })
      },
      release: () => undefined,
    }
    const pool = { connect: () => Promise.resolve(client) }
    const store = new PgWriteStore({ pool: asPool(pool) })

    await expect(store.applyIfNew(envelope(), 'user-42')).rejects.toThrow('simulated ledger failure')
    expect(calls.at(-1)?.text).toBe('ROLLBACK')
    expect(calls.some((c) => c.text.includes('INSERT INTO projects'))).toBe(false)
  })

  it('skips the actual write (but still commits) when the ledger says the mutation already applied', async () => {
    // `INSERT ... ON CONFLICT (mutation_id) DO NOTHING RETURNING` yields no
    // row when the mutation id was already recorded — simulate that by
    // always returning an empty row set for the ledger insert.
    const calls: RecordedQuery[] = []
    const client = {
      query: (text: string, params: unknown[] = []) => {
        calls.push({ text, params })
        return Promise.resolve({ rows: [] })
      },
      release: () => undefined,
    }
    const pool = { connect: () => Promise.resolve(client) }
    const store = new PgWriteStore({ pool: asPool(pool) })

    const applied = await store.applyIfNew(envelope(), 'user-42')
    expect(applied).toBe(false)
    expect(calls.some((c) => c.text.includes('INSERT INTO projects'))).toBe(false)
    expect(calls.at(-1)?.text).toBe('COMMIT') // still commits — the ledger check itself is part of the transaction
  })
})

// Regression coverage for the two SQL bugs that shipped because no test in
// this repo ever parsed the SQL `PgWriteStore` generates (the tests above
// only assert transaction/GUC *ordering* against a fake client that echoes
// whatever text it's given). Both bugs surfaced only in the live 050
// end-to-end write test, against a real Postgres:
//
//   1. Duplicate `id` (Postgres 42701 "column \"id\" specified more than
//      once"): the INSERT was built as `(id, updated_at, <every payload
//      key>)`, and a realistic client payload ALSO carries `id` (Drizzle
//      echoes the entity's own id back in the payload) — so `id` appeared
//      twice in the column list.
//   2. camelCase vs snake_case (Postgres 42703 "column \"workspaceid\" does
//      not exist"): client payloads use Drizzle's camelCase JS field names
//      (`workspaceId`); the DB columns are snake_case (`workspace_id`). The
//      store used to splice payload keys into the SQL verbatim.
//
// `store.ts`'s `applyIfNew` now runs every payload key through `toSqlColumn`
// (camel -> snake) and drops a `SERVER_STAMPED` set (`id`, `updated_at`,
// `deleted_at`) AFTER conversion, so the payload's own echoed `id`/`updatedAt`
// never re-enters the column list. These tests parse the SQL text/params the
// fake client captures and assert on it directly, closing the gap.
describe('PgWriteStore.applyIfNew — SQL column mapping (regression: bugs 053/054)', () => {
  it('insert: snake_cases camelCase payload keys and emits `id` exactly once', async () => {
    const { pool, calls } = fakePool({ applied_mutations: [{ mutation_id: 'x' }] })
    const store = new PgWriteStore({ pool: asPool(pool) })
    const entityId = uuidv7()
    const clientUpdatedAt = '2026-01-01T00:00:00.000Z'
    const mutation = envelope({
      entityId,
      clientUpdatedAt,
      payload: {
        // A realistic client payload echoes the entity's own id (bug 053's
        // trigger) and uses Drizzle's camelCase JS field names (bug 054's).
        id: entityId,
        name: 'Acme Rollout',
        workspaceId: 'ws-1',
        createdAt: '2025-12-31T00:00:00.000Z',
      },
    })

    await store.applyIfNew(mutation, 'user-42')

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO projects'))
    if (!insertCall) throw new Error('no INSERT INTO projects call was captured')
    const sql = insertCall.text
    const columns = parseInsertColumns(sql)

    // Bug 054: camelCase keys must be converted to snake_case column names.
    expect(columns).toContain('workspace_id')
    expect(columns).toContain('created_at')
    expect(columns).not.toContain('workspaceId')
    expect(columns).not.toContain('createdAt')

    // Bug 053: `id` must appear exactly once — the explicit `(id, ...)`
    // prefix column — never re-added from the payload's own echoed `id` key.
    expect(columns.filter((c) => c === 'id')).toHaveLength(1)
    expect(columns[0]).toBe('id')
    expect(columns[1]).toBe('updated_at')

    // Server-stamped columns must never be re-appended from the payload.
    const appended = columns.slice(2)
    expect(appended).not.toContain('id')
    expect(appended).not.toContain('updated_at')
    expect(appended).not.toContain('deleted_at')
    expect(appended).toEqual(['name', 'workspace_id', 'created_at'])

    // Placeholders line up 1:1 with the column list, and params line up
    // with the placeholders in the same order.
    const placeholders = parseValuesPlaceholders(sql)
    expect(placeholders).toEqual(columns.map((_, i) => `$${i + 1}`))
    expect(insertCall.params).toEqual([
      entityId, // $1 — id
      clientUpdatedAt, // $2 — updated_at
      'Acme Rollout', // $3 — name
      'ws-1', // $4 — workspace_id
      '2025-12-31T00:00:00.000Z', // $5 — created_at
    ])
  })

  it('update: snake_cases camelCase payload keys and never re-adds `id`/`updated_at`/`deleted_at` to the SET clause', async () => {
    const { pool, calls } = fakePool({ applied_mutations: [{ mutation_id: 'x' }] })
    const store = new PgWriteStore({ pool: asPool(pool) })
    const entityId = uuidv7()
    const clientUpdatedAt = '2026-02-02T00:00:00.000Z'
    const mutation = envelope({
      op: 'update',
      entityId,
      clientUpdatedAt,
      payload: {
        id: entityId, // echoed by the client, same as the insert case
        name: 'Renamed Project',
        workspaceId: 'ws-2',
        deletedAt: null, // must not leak into the SET clause either
      },
    })

    await store.applyIfNew(mutation, 'user-42')

    const updateCall = calls.find((c) => c.text.includes('UPDATE projects'))
    if (!updateCall) throw new Error('no UPDATE projects call was captured')
    const sql = updateCall.text
    const assignments = parseSetClause(sql)
    const setColumns = assignments.map(([col]) => col)

    // Bug 054: camelCase keys must be converted to snake_case column names.
    expect(setColumns).toContain('workspace_id')
    expect(setColumns).not.toContain('workspaceId')
    expect(setColumns).not.toContain('deletedAt')

    // Bug 053 (applies to UPDATE's shared column-building code too): the
    // payload's echoed `id` must never appear in the SET clause, and
    // `updated_at`/`deleted_at` must appear at most once (server-stamped).
    expect(setColumns).not.toContain('id')
    expect(setColumns.filter((c) => c === 'updated_at')).toHaveLength(1)
    expect(setColumns.filter((c) => c === 'deleted_at')).toHaveLength(0)
    expect(setColumns).toEqual(['name', 'workspace_id', 'updated_at'])

    // Each `col = $N` placeholder must resolve to the correct bound param.
    const paramsByPlaceholder = new Map(
      assignments.map(([, placeholder]) => [placeholder, updateCall.params[Number(placeholder.slice(1)) - 1]]),
    )
    expect(paramsByPlaceholder.get('$3')).toBe('Renamed Project') // name
    expect(paramsByPlaceholder.get('$4')).toBe('ws-2') // workspace_id
    expect(paramsByPlaceholder.get('$2')).toBe(clientUpdatedAt) // updated_at
    expect(updateCall.params[0]).toBe(entityId) // WHERE id = $1
  })

  // Issue 056 (055's Cause 2 fix, test-first plan item 5) — extends this same
  // SQL-parsing regression discipline (bugs 053/054, commit 3b92dd0) to the
  // two new tables: the fake `pg` client never parses SQL, so a duplicate-`id`
  // column or a camelCase leak on `invitations`/`workspace_members` could
  // ship undetected exactly like it did for `projects` if only asserted via
  // the fake client's echo behavior.
  it('insert: an invitations mutation snake_cases its camelCase payload keys onto `invitations`, `id` exactly once', async () => {
    const { pool, calls } = fakePool({ applied_mutations: [{ mutation_id: 'x' }] })
    const store = new PgWriteStore({ pool: asPool(pool) })
    const entityId = uuidv7()
    const clientUpdatedAt = '2026-01-01T00:00:00.000Z'
    const mutation = envelope({
      table: 'invitations',
      entityId,
      clientUpdatedAt,
      payload: {
        id: entityId, // echoed by the client, same trigger as bug 053
        workspaceId: 'ws-1',
        email: 'invitee@example.com',
        role: 'viewer',
        invitedBySub: 'user-1',
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
    })

    await store.applyIfNew(mutation, 'user-42')

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO invitations'))
    if (!insertCall) throw new Error('no INSERT INTO invitations call was captured')
    const columns = parseInsertColumns(insertCall.text)

    // Bug 054 class: camelCase keys converted to snake_case column names.
    expect(columns).toContain('workspace_id')
    expect(columns).toContain('invited_by_sub')
    expect(columns).toContain('expires_at')
    expect(columns).not.toContain('workspaceId')
    expect(columns).not.toContain('invitedBySub')
    expect(columns).not.toContain('expiresAt')

    // Bug 053 class: `id` appears exactly once (the explicit prefix column),
    // never re-added from the payload's own echoed `id`.
    expect(columns.filter((c) => c === 'id')).toHaveLength(1)
    expect(columns[0]).toBe('id')
    expect(columns[1]).toBe('updated_at')
    expect(columns.slice(2)).not.toContain('id')
    expect(columns.slice(2)).not.toContain('updated_at')
  })

  it('insert: a workspaceMembers mutation snake_cases its camelCase payload keys onto `workspace_members`, `id` exactly once', async () => {
    const { pool, calls } = fakePool({ applied_mutations: [{ mutation_id: 'x' }] })
    const store = new PgWriteStore({ pool: asPool(pool) })
    const entityId = uuidv7()
    const clientUpdatedAt = '2026-01-01T00:00:00.000Z'
    const mutation = envelope({
      table: 'workspaceMembers',
      entityId,
      clientUpdatedAt,
      payload: {
        id: entityId,
        workspaceId: 'ws-1',
        userSub: 'user-2',
        role: 'editor',
      },
    })

    await store.applyIfNew(mutation, 'user-42')

    const insertCall = calls.find((c) => c.text.includes('INSERT INTO workspace_members'))
    if (!insertCall) throw new Error('no INSERT INTO workspace_members call was captured')
    const columns = parseInsertColumns(insertCall.text)

    expect(columns).toContain('workspace_id')
    expect(columns).toContain('user_sub')
    expect(columns).not.toContain('workspaceId')
    expect(columns).not.toContain('userSub')
    expect(columns.filter((c) => c === 'id')).toHaveLength(1)
    expect(columns[0]).toBe('id')
    expect(columns[1]).toBe('updated_at')
  })
})
