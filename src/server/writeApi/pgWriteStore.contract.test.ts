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
