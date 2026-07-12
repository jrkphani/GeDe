import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase } from './client'
import { bindings, contexts, dimensions, invitations, projects, workspaceMembers, workspaces } from './schema'
import { applyInboundDeltas } from './sync'
import { listBindings } from './mutations'
import type { RowDelta } from '../domain/syncDelta'

const T0 = '2026-07-07T00:00:00.000Z'
const T1 = '2026-07-07T00:00:01.000Z'
const T2 = '2026-07-07T00:00:02.000Z'

// Issue 034: projects/dimensions/contexts carry a NOT NULL workspace_id FK.
// Every fixture row below references this fixed workspace id; freshDb() seeds
// it directly (bypassing RLS as the table owner — this is test setup, not a
// tenancy assertion, which lives in workspaceRls.test.ts).
const WS = 'ws1'

function row(id: string, updatedAt: string, extra: Record<string, unknown>): RowDelta['row'] {
  return { id, createdAt: T0, updatedAt, deletedAt: null, ...extra }
}

async function freshDb() {
  const { db } = await openDatabase('memory://')
  await db.insert(workspaces).values({ id: WS, name: 'Test Workspace' })
  return db
}

describe('applyInboundDeltas — read-path round-trip (test-first plan #1)', () => {
  it('a fresh project row streams in and is durably applied', async () => {
    const db = await freshDb()
    const delta: RowDelta = {
      table: 'projects',
      id: 'p1',
      updatedAt: T1,
      row: row('p1', T1, { name: 'Tavalo', description: null, workspaceId: WS }),
    }
    await applyInboundDeltas(db, [delta])

    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Tavalo')
  })

  it('a newer delta for the same row updates it (LWW via the SQL WHERE guard)', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T1, row: row('p1', T1, { name: 'v1', description: null, workspaceId: WS }) },
    ])
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T2, row: row('p1', T2, { name: 'v2', description: null, workspaceId: WS }) },
    ])
    const rows = await db.select().from(projects)
    expect(rows[0]?.name).toBe('v2')
  })

  it('an older/stale delta never overwrites a newer row (out-of-order delivery)', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T2, row: row('p1', T2, { name: 'newer', description: null, workspaceId: WS }) },
    ])
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T1, row: row('p1', T1, { name: 'stale', description: null, workspaceId: WS }) },
    ])
    const rows = await db.select().from(projects)
    expect(rows[0]?.name).toBe('newer')
  })

  it('re-applying the identical batch is a no-op (idempotent)', async () => {
    const db = await freshDb()
    const delta: RowDelta = {
      table: 'projects',
      id: 'p1',
      updatedAt: T1,
      row: row('p1', T1, { name: 'Tavalo', description: null, workspaceId: WS }),
    }
    await applyInboundDeltas(db, [delta])
    await applyInboundDeltas(db, [delta])
    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Tavalo')
  })

  it('a soft-delete tombstone (deletedAt set) applies and disappears from live reads', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null, workspaceId: WS }) },
      {
        table: 'dimensions',
        id: 'd1',
        updatedAt: T0,
        row: row('d1', T0, { projectId: 'p1', workspaceId: WS, contextId: null, sourceParamId: null, name: 'Value', color: '#111', sort: 0 }),
      },
      {
        table: 'parameters',
        id: 'pa1',
        updatedAt: T0,
        row: row('pa1', T0, { dimensionId: 'd1', parentParamId: null, sourceEntryId: null, name: 'Comfort', sort: 0 }),
      },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', workspaceId: WS, parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
      {
        table: 'bindings',
        id: 'b1',
        updatedAt: T0,
        row: row('b1', T0, { contextId: 'c1', dimensionId: 'd1', parameterId: 'pa1', tupleHash: 'h1' }),
      },
    ])
    expect(await listBindings(db, 'c1')).toHaveLength(1)

    // The authoritative tombstone (deletedAt set) streams in.
    await applyInboundDeltas(db, [
      {
        table: 'bindings',
        id: 'b1',
        updatedAt: T1,
        row: row('b1', T1, { contextId: 'c1', dimensionId: 'd1', parameterId: 'pa1', tupleHash: 'h1' }),
      },
    ])
    // Still live — this delta didn't set deletedAt. Now tombstone it for real.
    await applyInboundDeltas(db, [
      {
        table: 'bindings',
        id: 'b1',
        updatedAt: T2,
        row: {
          ...row('b1', T2, { contextId: 'c1', dimensionId: 'd1', parameterId: 'pa1', tupleHash: 'h1' }),
          deletedAt: T2,
        },
      },
    ])
    expect(await listBindings(db, 'c1')).toHaveLength(0)
    const raw = await db.select().from(bindings).where(eq(bindings.id, 'b1'))
    // Postgres/PGlite renormalize a timestamptz's textual form on read (not a
    // byte-identical round-trip of the inserted ISO literal) — assert presence.
    expect(raw[0]?.deletedAt).not.toBeNull()
  })
})

describe('applyInboundDeltas — FK-cycle apply order (issue 015/032)', () => {
  it('a child context delivered before its not-yet-existing parent survives (NULL-then-restore)', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null, workspaceId: WS }) },
      // child FIRST, parent SECOND, in the same batch — the deadlock 015 solved for import.
      {
        table: 'contexts',
        id: 'c2',
        updatedAt: T0,
        row: row('c2', T0, { projectId: 'p1', workspaceId: WS, parentId: 'c1', symbol: 'α1', name: null, justification: null, sort: 0 }),
      },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', workspaceId: WS, parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
    ])
    const rows = await db.select().from(contexts).where(eq(contexts.id, 'c2'))
    expect(rows[0]?.parentId).toBe('c1')
  })

  it('a child-canvas dimension delivered before its source parameter survives', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null, workspaceId: WS }) },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', workspaceId: WS, parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
      // child-canvas dimension referencing a parameter that arrives AFTER it
      // in the same batch (dimensions.sourceParamId cross-cycle, issue 011).
      {
        table: 'dimensions',
        id: 'd2',
        updatedAt: T0,
        row: row('d2', T0, { projectId: 'p1', workspaceId: WS, contextId: 'c1', sourceParamId: 'pa1', name: 'Comfort', color: '#111', sort: 0 }),
      },
      {
        table: 'dimensions',
        id: 'd1',
        updatedAt: T0,
        row: row('d1', T0, { projectId: 'p1', workspaceId: WS, contextId: null, sourceParamId: null, name: 'Value', color: '#222', sort: 0 }),
      },
      {
        table: 'parameters',
        id: 'pa1',
        updatedAt: T0,
        row: row('pa1', T0, { dimensionId: 'd1', parentParamId: null, sourceEntryId: null, name: 'Comfort', sort: 0 }),
      },
    ])
    const rows = await db.select().from(dimensions).where(eq(dimensions.id, 'd2'))
    expect(rows[0]?.sourceParamId).toBe('pa1')
  })

  it('a stale (rejected) row never has its deferred FK column clobbered by the second pass', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null, workspaceId: WS }) },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', workspaceId: WS, parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
      {
        table: 'contexts',
        id: 'c2',
        updatedAt: T2,
        row: row('c2', T2, { projectId: 'p1', workspaceId: WS, parentId: 'c1', symbol: 'α1', name: null, justification: null, sort: 0 }),
      },
    ])
    // A stale re-delivery of c2 with an OLDER updatedAt and a different
    // (bogus) parentId — the guard must reject the whole row, including its
    // deferred column, not just silently re-null it.
    await applyInboundDeltas(db, [
      {
        table: 'contexts',
        id: 'c2',
        updatedAt: T1,
        row: row('c2', T1, { projectId: 'p1', workspaceId: WS, parentId: null, symbol: 'stale', name: null, justification: null, sort: 0 }),
      },
    ])
    const rows = await db.select().from(contexts).where(eq(contexts.id, 'c2'))
    expect(rows[0]?.symbol).toBe('α1')
    expect(rows[0]?.parentId).toBe('c1')
  })
})

// Issue 056 (055's Cause 2 fix, test-first plan item 3) — `invitations` and
// `workspace_members` join the inbound-apply switch's guarded-upsert shape,
// exactly like the original nine tables. Neither has a self/cross-referential
// FK (both `workspaceId`s point OUTWARD at `workspaces`, never inward), so
// neither needs the DEFERRED_FK_COLUMN two-pass strategy — confirmed against
// src/db/schema.ts:31-45,59-75 before writing this.
describe('applyInboundDeltas — invitations / workspace_members (issue 056)', () => {
  it('a fresh invitations row streams in and is durably applied, with the LWW guard honored', async () => {
    const db = await freshDb()
    const fresh: RowDelta = {
      table: 'invitations',
      id: 'inv1',
      updatedAt: T1,
      row: row('inv1', T1, {
        workspaceId: WS,
        email: 'invitee@example.com',
        role: 'viewer',
        invitedBySub: 'sub-owner',
        expiresAt: '2026-08-01T00:00:00.000Z',
        acceptedAt: null,
      }),
    }
    await applyInboundDeltas(db, [fresh])

    const rows = await db.select().from(invitations)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe('invitee@example.com')

    // A stale re-delivery must not overwrite the newer row (same LWW guard as
    // every other table).
    await applyInboundDeltas(db, [
      { ...fresh, updatedAt: T0, row: row('inv1', T0, { ...fresh.row, role: 'editor' }) },
    ])
    const stillFresh = await db.select().from(invitations)
    expect(stillFresh[0]?.role).toBe('viewer')

    // A newer delta DOES apply.
    await applyInboundDeltas(db, [
      { ...fresh, updatedAt: T2, row: row('inv1', T2, { ...fresh.row, role: 'editor' }) },
    ])
    const updated = await db.select().from(invitations)
    expect(updated[0]?.role).toBe('editor')
  })

  it('a fresh workspace_members row streams in and is durably applied, with the LWW guard honored', async () => {
    const db = await freshDb()
    const fresh: RowDelta = {
      table: 'workspace_members',
      id: 'mem1',
      updatedAt: T1,
      row: row('mem1', T1, { workspaceId: WS, userSub: 'sub-x', role: 'viewer' }),
    }
    await applyInboundDeltas(db, [fresh])

    const rows = await db.select().from(workspaceMembers)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe('viewer')

    await applyInboundDeltas(db, [
      { ...fresh, updatedAt: T0, row: row('mem1', T0, { ...fresh.row, role: 'editor' }) },
    ])
    expect((await db.select().from(workspaceMembers))[0]?.role).toBe('viewer')

    await applyInboundDeltas(db, [
      { ...fresh, updatedAt: T2, row: row('mem1', T2, { ...fresh.row, role: 'editor' }) },
    ])
    expect((await db.select().from(workspaceMembers))[0]?.role).toBe('editor')
  })

  it('a soft-delete tombstone on an invitation applies and is reflected in deletedAt', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      {
        table: 'invitations',
        id: 'inv1',
        updatedAt: T0,
        row: row('inv1', T0, {
          workspaceId: WS,
          email: 'invitee@example.com',
          role: 'viewer',
          invitedBySub: 'sub-owner',
          expiresAt: '2026-08-01T00:00:00.000Z',
          acceptedAt: null,
        }),
      },
    ])
    await applyInboundDeltas(db, [
      {
        table: 'invitations',
        id: 'inv1',
        updatedAt: T1,
        row: {
          ...row('inv1', T1, {
            workspaceId: WS,
            email: 'invitee@example.com',
            role: 'viewer',
            invitedBySub: 'sub-owner',
            expiresAt: '2026-08-01T00:00:00.000Z',
            acceptedAt: null,
          }),
          deletedAt: T1,
        },
      },
    ])
    const raw = await db.select().from(invitations).where(eq(invitations.id, 'inv1'))
    expect(raw).toHaveLength(1)
    expect(raw[0]?.deletedAt).not.toBeNull()
  })
})

// Issue 075 Part A — the confirmed root cause: syncEngine.ts opens one
// INDEPENDENT ShapeStream per table, each applying its own batch the instant
// THAT table's network response resolves, with no cross-table ordering. A
// forward FK to a SIBLING synced table (parameters.dimension_id, unlike the
// self/cross-referential columns DEFERRED_FK_COLUMN already protects) is NOT
// deferred here, so if the `parameters` shape resolves before `dimensions`
// has committed locally, this call must still throw/roll back — that
// atomicity is exactly what makes 032's convergence property safe, and it is
// NOT weakened by 075's fix (the retry orchestration lives one layer up, in
// syncEngine.ts, and re-calls this same function once the parent has landed).
// This test pins that invariant directly: applyInboundDeltas alone, given a
// `parameters` delta whose `dimensions` parent was never seeded, must reject.
describe('applyInboundDeltas — cross-table forward-FK race (issue 075 Part A root cause)', () => {
  it('a parameters delta whose dimensions parent is not yet local throws (no cross-table ordering at this layer)', async () => {
    const db = await freshDb()
    const delta: RowDelta = {
      table: 'parameters',
      id: 'pa1',
      updatedAt: T0,
      row: row('pa1', T0, { dimensionId: 'd-not-yet-local', parentParamId: null, sourceEntryId: null, name: 'Comfort', sort: 0 }),
    }
    await expect(applyInboundDeltas(db, [delta])).rejects.toThrow()
    const rows = await db.select().from(dimensions)
    expect(rows).toHaveLength(0)
  })
})

// Issue 072 — the client-side mirror of 071. `projects.workspace_id` carries
// a real, enforced FK (migration 0008), but `workspaces` is NOT itself an
// Electric-synced table (src/domain/syncScope.ts) — the only other local
// writer of a workspace row is createProject's ensureWorkspaceRow. After
// 063's clear-on-sign-out wipes local PGlite, a fresh sign-in's local DB has
// no workspaces row at all, so a streamed project is the FIRST thing this
// fresh DB has ever heard about its workspace. Deliberately does NOT use
// freshDb() (which pre-seeds WS) — every other describe block in this file
// relies on that pre-seed; these two prove the apply path is durable even
// when it's missing.
describe('applyInboundDeltas — projects delta with a not-yet-known local workspace (072)', () => {
  it('a projects insert whose workspace_id was never seeded locally still applies durably', async () => {
    const { db } = await openDatabase('memory://')
    const delta: RowDelta = {
      table: 'projects',
      id: 'p1',
      updatedAt: T1,
      row: row('p1', T1, { name: 'Tavalo', description: null, workspaceId: 'ws-unseen' }),
    }

    await expect(applyInboundDeltas(db, [delta])).resolves.toBeUndefined()

    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Tavalo')
    expect(rows[0]?.workspaceId).toBe('ws-unseen')
  })

  it('a batch with a projects(unknown-workspace) delta + a delta for an already-known table both apply (no full-batch rollback)', async () => {
    // WS is already known locally (freshDb seeds it) — the invitations delta
    // below targets it, standing in for "an already-known table" in the same
    // batch as a projects delta whose OWN workspace ('ws-unseen') has never
    // been seen locally. Before the fix, the projects insert's FK violation
    // rolled back the whole transaction, taking the invitation down with it.
    const db = await freshDb()
    await applyInboundDeltas(db, [
      {
        table: 'projects',
        id: 'p2',
        updatedAt: T1,
        row: row('p2', T1, { name: 'New Project', description: null, workspaceId: 'ws-unseen' }),
      },
      {
        table: 'invitations',
        id: 'inv1',
        updatedAt: T1,
        row: row('inv1', T1, {
          workspaceId: WS,
          email: 'invitee@example.com',
          role: 'viewer',
          invitedBySub: 'sub-owner',
          expiresAt: '2026-08-01T00:00:00.000Z',
          acceptedAt: null,
        }),
      },
    ])

    const projectRows = await db.select().from(projects).where(eq(projects.id, 'p2'))
    expect(projectRows).toHaveLength(1)
    const invitationRows = await db.select().from(invitations).where(eq(invitations.id, 'inv1'))
    expect(invitationRows).toHaveLength(1)
  })
})
