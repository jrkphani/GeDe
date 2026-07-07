import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase } from './client'
import { bindings, contexts, dimensions, projects } from './schema'
import { applyInboundDeltas } from './sync'
import { listBindings } from './mutations'
import type { RowDelta } from '../domain/syncDelta'

const T0 = '2026-07-07T00:00:00.000Z'
const T1 = '2026-07-07T00:00:01.000Z'
const T2 = '2026-07-07T00:00:02.000Z'

function row(id: string, updatedAt: string, extra: Record<string, unknown>): RowDelta['row'] {
  return { id, createdAt: T0, updatedAt, deletedAt: null, ...extra }
}

async function freshDb() {
  const { db } = await openDatabase('memory://')
  return db
}

describe('applyInboundDeltas — read-path round-trip (test-first plan #1)', () => {
  it('a fresh project row streams in and is durably applied', async () => {
    const db = await freshDb()
    const delta: RowDelta = {
      table: 'projects',
      id: 'p1',
      updatedAt: T1,
      row: row('p1', T1, { name: 'Tavalo', description: null }),
    }
    await applyInboundDeltas(db, [delta])

    const rows = await db.select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Tavalo')
  })

  it('a newer delta for the same row updates it (LWW via the SQL WHERE guard)', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T1, row: row('p1', T1, { name: 'v1', description: null }) },
    ])
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T2, row: row('p1', T2, { name: 'v2', description: null }) },
    ])
    const rows = await db.select().from(projects)
    expect(rows[0]?.name).toBe('v2')
  })

  it('an older/stale delta never overwrites a newer row (out-of-order delivery)', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T2, row: row('p1', T2, { name: 'newer', description: null }) },
    ])
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T1, row: row('p1', T1, { name: 'stale', description: null }) },
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
      row: row('p1', T1, { name: 'Tavalo', description: null }),
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
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null }) },
      {
        table: 'dimensions',
        id: 'd1',
        updatedAt: T0,
        row: row('d1', T0, { projectId: 'p1', contextId: null, sourceParamId: null, name: 'Value', color: '#111', sort: 0 }),
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
        row: row('c1', T0, { projectId: 'p1', parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
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
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null }) },
      // child FIRST, parent SECOND, in the same batch — the deadlock 015 solved for import.
      {
        table: 'contexts',
        id: 'c2',
        updatedAt: T0,
        row: row('c2', T0, { projectId: 'p1', parentId: 'c1', symbol: 'α1', name: null, justification: null, sort: 0 }),
      },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
    ])
    const rows = await db.select().from(contexts).where(eq(contexts.id, 'c2'))
    expect(rows[0]?.parentId).toBe('c1')
  })

  it('a child-canvas dimension delivered before its source parameter survives', async () => {
    const db = await freshDb()
    await applyInboundDeltas(db, [
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null }) },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
      // child-canvas dimension referencing a parameter that arrives AFTER it
      // in the same batch (dimensions.sourceParamId cross-cycle, issue 011).
      {
        table: 'dimensions',
        id: 'd2',
        updatedAt: T0,
        row: row('d2', T0, { projectId: 'p1', contextId: 'c1', sourceParamId: 'pa1', name: 'Comfort', color: '#111', sort: 0 }),
      },
      {
        table: 'dimensions',
        id: 'd1',
        updatedAt: T0,
        row: row('d1', T0, { projectId: 'p1', contextId: null, sourceParamId: null, name: 'Value', color: '#222', sort: 0 }),
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
      { table: 'projects', id: 'p1', updatedAt: T0, row: row('p1', T0, { name: 'Tavalo', description: null }) },
      {
        table: 'contexts',
        id: 'c1',
        updatedAt: T0,
        row: row('c1', T0, { projectId: 'p1', parentId: null, symbol: 'α', name: null, justification: null, sort: 0 }),
      },
      {
        table: 'contexts',
        id: 'c2',
        updatedAt: T2,
        row: row('c2', T2, { projectId: 'p1', parentId: 'c1', symbol: 'α1', name: null, justification: null, sort: 0 }),
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
        row: row('c2', T1, { projectId: 'p1', parentId: null, symbol: 'stale', name: null, justification: null, sort: 0 }),
      },
    ])
    const rows = await db.select().from(contexts).where(eq(contexts.id, 'c2'))
    expect(rows[0]?.symbol).toBe('α1')
    expect(rows[0]?.parentId).toBe('c1')
  })
})
