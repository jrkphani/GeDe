// Contract test for PgAcceptStore (issue 080) — proves the transaction/SQL
// wiring WITHOUT a live Postgres (HANDOFF: "no live AWS/Electric/Cognito
// reachable in tests"), mirroring src/server/writeApi/pgWriteStore.contract.test.ts's
// fake-pg-pool technique exactly. A fake `pg`-shaped pool/client records
// every SQL statement issued; the assertions below prove the SECURITY-
// CRITICAL statement sequence and param order this endpoint's whole
// authorization model depends on: `SELECT ... FOR UPDATE` locks/re-validates
// the exact invite row BEFORE the membership upsert and the
// `accepted_at` stamp, all inside one transaction.
import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { Pool } from 'pg'
import { PgAcceptStore, type PendingInvitation } from './store'

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

function invitation(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    id: uuidv7(),
    workspaceId: 'ws-1',
    email: 'invitee@example.com',
    role: 'editor',
    expiresAt: '2026-08-01T00:00:00.000Z',
    acceptedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

describe('PgAcceptStore.findPendingInvitation — query shape', () => {
  it('filters on workspace_id, case-insensitive email, and the full pending-status predicate', async () => {
    const { pool, calls } = fakePool()
    const store = new PgAcceptStore({ pool: asPool(pool) })

    await store.findPendingInvitation('ws-1', 'Invitee@Example.com')

    expect(calls).toHaveLength(1)
    const sql = calls[0]?.text ?? ''
    expect(sql).toContain('FROM invitations')
    expect(sql).toContain('workspace_id = $1')
    expect(sql).toContain('lower(email) = lower($2)')
    expect(sql).toContain('deleted_at IS NULL')
    expect(sql).toContain('accepted_at IS NULL')
    expect(sql).toContain('expires_at > now()')
    expect(calls[0]?.params).toEqual(['ws-1', 'Invitee@Example.com'])
  })
})

describe('PgAcceptStore.findExistingMembership — query shape', () => {
  it('filters on workspace_id, user_sub, and live rows only', async () => {
    const { pool, calls } = fakePool()
    const store = new PgAcceptStore({ pool: asPool(pool) })

    await store.findExistingMembership('ws-1', 'user-42')

    expect(calls).toHaveLength(1)
    const sql = calls[0]?.text ?? ''
    expect(sql).toContain('FROM workspace_members')
    expect(sql).toContain('workspace_id = $1')
    expect(sql).toContain('user_sub = $2')
    expect(sql).toContain('deleted_at IS NULL')
    expect(calls[0]?.params).toEqual(['ws-1', 'user-42'])
  })
})

describe('PgAcceptStore.acceptInvitation — ONE transaction, correct statement sequence (issue 080 core contract)', () => {
  it('BEGIN -> SELECT ... FOR UPDATE (the exact invite, full status predicate) -> INSERT ... ON CONFLICT DO UPDATE -> UPDATE accepted_at -> COMMIT', async () => {
    const { pool, calls } = fakePool({
      // The FOR UPDATE lock query must find the row for the happy path to
      // proceed past it (issue 080 TOCTOU fix — a zero-row result now halts
      // the transaction instead of being ignored).
      'FROM invitations': [{ id: 'inv-1' }],
      workspace_members: [{ id: 'member-1', workspace_id: 'ws-1', user_sub: 'user-42', role: 'editor', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null }],
    })
    const store = new PgAcceptStore({ pool: asPool(pool) })
    const inv = invitation({ id: 'inv-1', workspaceId: 'ws-1', role: 'editor' })

    await store.acceptInvitation(inv, 'user-42')

    const texts = calls.map((c) => c.text)
    expect(texts[0]).toBe('BEGIN')

    expect(texts[1]).toContain('SELECT')
    expect(texts[1]).toContain('FROM invitations')
    expect(texts[1]).toContain('FOR UPDATE')
    expect(texts[1]).toContain('id = $1')
    expect(texts[1]).toContain('deleted_at IS NULL')
    expect(texts[1]).toContain('accepted_at IS NULL')
    expect(texts[1]).toContain('expires_at > now()')
    expect(calls[1]?.params).toEqual(['inv-1'])

    expect(texts[2]).toContain('INSERT INTO workspace_members')
    expect(texts[2]).toContain('ON CONFLICT (workspace_id, user_sub) DO UPDATE');
    expect(texts[2]).toContain('role = $4')
    expect(texts[2]).toContain('deleted_at = NULL')
    expect(texts[2]).toContain('updated_at = now()')
    // params: [new uuidv7 member id, workspaceId, sub, role]
    expect(calls[2]?.params[1]).toBe('ws-1')
    expect(calls[2]?.params[2]).toBe('user-42')
    expect(calls[2]?.params[3]).toBe('editor')

    expect(texts[3]).toContain('UPDATE invitations')
    expect(texts[3]).toContain('accepted_at = now()')
    expect(texts[3]).toContain('WHERE id = $1')
    expect(calls[3]?.params).toEqual(['inv-1'])

    expect(texts[4]).toBe('COMMIT')
    expect(texts).toHaveLength(5)
  })

  it('returns the seated member and the accepted invitation', async () => {
    const { pool } = fakePool({
      'FROM invitations': [{ id: 'inv-1' }],
      workspace_members: [{ id: 'member-1', workspace_id: 'ws-1', user_sub: 'user-42', role: 'viewer', updated_at: '2026-01-01T00:00:00.000Z', deleted_at: null }],
    })
    const store = new PgAcceptStore({ pool: asPool(pool) })
    const inv = invitation({ id: 'inv-1', workspaceId: 'ws-1', role: 'viewer' })

    const result = await store.acceptInvitation(inv, 'user-42')

    expect(result).not.toBeNull()
    expect(result?.member).toMatchObject({ id: 'member-1', workspaceId: 'ws-1', userSub: 'user-42', role: 'viewer' })
    expect(result?.invitation.acceptedAt).not.toBeNull()
  })

  it('rolls back and never issues the membership insert if an error occurs mid-transaction', async () => {
    const calls: RecordedQuery[] = []
    let queryCount = 0
    const client = {
      query: (text: string, params: unknown[] = []) => {
        calls.push({ text, params })
        queryCount++
        if (queryCount === 2) return Promise.reject(new Error('simulated lock failure'))
        return Promise.resolve({ rows: [] })
      },
      release: () => undefined,
    }
    const pool = { connect: () => Promise.resolve(client) }
    const store = new PgAcceptStore({ pool: asPool(pool) })
    const inv = invitation({ id: 'inv-1', workspaceId: 'ws-1' })

    await expect(store.acceptInvitation(inv, 'user-42')).rejects.toThrow('simulated lock failure')
    expect(calls.at(-1)?.text).toBe('ROLLBACK')
    expect(calls.some((c) => c.text.includes('INSERT INTO workspace_members'))).toBe(false)
  })

  it('TOCTOU close: returns null and ROLLBACKs — never issues the membership INSERT or the accepted_at UPDATE — when the FOR UPDATE re-check finds the invite no longer valid (revoked/expired/accepted in the window since findPendingInvitation ran)', async () => {
    // fakePool() with no rowsToReturn entries resolves every query -
    // including the FOR UPDATE lock - to zero rows, simulating the invite
    // having been revoked/accepted/expired between the handler's
    // findPendingInvitation call and this transaction's own lock.
    const { pool, calls } = fakePool()
    const store = new PgAcceptStore({ pool: asPool(pool) })
    const inv = invitation({ id: 'inv-1', workspaceId: 'ws-1' })

    const result = await store.acceptInvitation(inv, 'user-42')

    expect(result).toBeNull()
    const texts = calls.map((c) => c.text)
    expect(texts[0]).toBe('BEGIN')
    expect(texts[1]).toContain('FOR UPDATE')
    expect(texts.some((t) => t.includes('INSERT INTO workspace_members'))).toBe(false)
    expect(texts.some((t) => t.includes('UPDATE invitations'))).toBe(false)
    expect(texts.at(-1)).toBe('ROLLBACK')
  })
})
