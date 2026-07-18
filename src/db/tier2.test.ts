import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addTier2Entry,
  addTier2Table,
  bindParameter,
  countBindingsForParameter,
  createContext,
  createProject,
  deleteParametersUnbinding,
  listParameters,
  listParametersBySourceEntries,
  listTier2Entries,
  listTier2Tables,
  moveTier2Entry,
  promoteEntries,
  removeTier2EntrySubtree,
  renameTier2Entry,
  renameTier2Table,
  reorderTier2Table,
  unlinkParametersFromEntries,
} from './mutations'

function nn<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a non-null value')
  return value
}

async function freshProject() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  return { db, projectId: project.id }
}

describe('tier2 tables', () => {
  it('addTier2Table appends contiguous sort; rename updates the name', async () => {
    const { db, projectId } = await freshProject()
    await addTier2Table(db, projectId, 'Value')
    const stake = await addTier2Table(db, projectId, 'Stakeholders')
    await addTier2Table(db, projectId, 'Process')

    let tables = await listTier2Tables(db, projectId)
    expect(tables.map((t) => t.name)).toEqual(['Value', 'Stakeholders', 'Process'])
    expect(tables.map((t) => t.sort)).toEqual([0, 1, 2])

    await renameTier2Table(db, stake.id, 'Stake')
    tables = await listTier2Tables(db, projectId)
    expect(tables.map((t) => t.name)).toEqual(['Value', 'Stake', 'Process'])
  })

  // 089-D3 P3.4 — a table node dragged up/down its lane persists a NEW `sort`
  // via this mutation (mirrors reorderDimension / reorderCanvas). Only `sort`
  // is ever rewritten, and it is kept DENSE (0..n-1) — position stays derived,
  // never persisted.
  it('reorderTier2Table moves a table and rewrites sort densely (0..n-1)', async () => {
    const { db, projectId } = await freshProject()
    const alpha = await addTier2Table(db, projectId, 'Alpha')
    await addTier2Table(db, projectId, 'Beta')
    await addTier2Table(db, projectId, 'Gamma')

    // Drag Alpha (sort 0) down to the bottom (index 2).
    const after = await reorderTier2Table(db, projectId, alpha.id, 2)
    expect(after.map((t) => t.name)).toEqual(['Beta', 'Gamma', 'Alpha'])
    expect(after.map((t) => t.sort)).toEqual([0, 1, 2]) // dense, no gaps

    // Drag it back to the top (index 0) — inverse restores the original order.
    const back = await reorderTier2Table(db, projectId, alpha.id, 0)
    expect(back.map((t) => t.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(back.map((t) => t.sort)).toEqual([0, 1, 2])
  })

  it('reorderTier2Table is a no-op copy for an unknown id and clamps an out-of-range index', async () => {
    const { db, projectId } = await freshProject()
    const alpha = await addTier2Table(db, projectId, 'Alpha')
    await addTier2Table(db, projectId, 'Beta')

    const unknown = await reorderTier2Table(db, projectId, 'nope', 1)
    expect(unknown.map((t) => t.name)).toEqual(['Alpha', 'Beta'])

    // toIndex past the end clamps to the last slot.
    const clamped = await reorderTier2Table(db, projectId, alpha.id, 99)
    expect(clamped.map((t) => t.name)).toEqual(['Beta', 'Alpha'])
    expect(clamped.map((t) => t.sort)).toEqual([0, 1])
  })
})

describe('tier2 entries (arbitrary nesting)', () => {
  it('entries round-trip at arbitrary depth via parent_id', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, null, 'Maintainer')
    const superstars = await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    await addTier2Entry(db, table.id, superstars.id, 'Whales')

    const entries = await listTier2Entries(db, table.id)
    expect(entries).toHaveLength(4)
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('Superstars')?.parentId).toBe(buyers.id)
    expect(byName.get('Whales')?.parentId).toBe(superstars.id)
    // Siblings under a parent get contiguous sort.
    expect(byName.get('Buyers')?.sort).toBe(0)
    expect(byName.get('Maintainer')?.sort).toBe(1)
  })

  it('moveTier2Entry keeps the subtree intact (children follow their parent)', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    const child = await addTier2Entry(db, table.id, buyers.id, 'Superstars')

    // Re-parent Buyers under Users; Superstars must remain Buyers' child.
    await moveTier2Entry(db, table.id, buyers.id, users.id, 0)
    const entries = await listTier2Entries(db, table.id)
    const byId = new Map(entries.map((e) => [e.id, e]))
    expect(byId.get(buyers.id)?.parentId).toBe(users.id)
    expect(byId.get(child.id)?.parentId).toBe(buyers.id) // subtree intact
  })

  it('removeTier2EntrySubtree soft-deletes the whole subtree', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    await addTier2Entry(db, table.id, buyers.id, 'Superstars')
    await addTier2Entry(db, table.id, null, 'Users')

    const { entries, removedIds } = await removeTier2EntrySubtree(db, table.id, buyers.id)
    expect(removedIds).toHaveLength(2) // Buyers + Superstars
    expect(entries.map((e) => e.name)).toEqual(['Users'])
    expect(entries[0]?.sort).toBe(0) // sibling gap closed
  })
})

describe('promote entries to a dimension (invariant 7)', () => {
  it('creates a new dimension + one parameter per entry, each linked by source_entry_id', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    const maintainer = await addTier2Entry(db, table.id, null, 'Maintainer')

    const outcome = await promoteEntries(db, {
      projectId,
      entryIds: [buyers.id, maintainer.id],
      target: { kind: 'new', name: 'Stake' },
    })
    expect(outcome.createdDimension?.name).toBe('Stake')
    expect(outcome.createdParameters.map((p) => p.name)).toEqual(['Buyers', 'Maintainer'])
    expect(outcome.createdParameters.map((p) => p.sourceEntryId)).toEqual([buyers.id, maintainer.id])

    const params = await listParameters(db, outcome.dimensionId)
    expect(params.map((p) => p.name)).toEqual(['Buyers', 'Maintainer'])
  })

  it('re-promote extends the dimension without duplicating already-linked entries', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const buyers = await addTier2Entry(db, table.id, null, 'Buyers')
    const users = await addTier2Entry(db, table.id, null, 'Users')

    const first = await promoteEntries(db, {
      projectId,
      entryIds: [buyers.id],
      target: { kind: 'new', name: 'Stake' },
    })
    const second = await promoteEntries(db, {
      projectId,
      entryIds: [buyers.id, users.id], // Buyers already linked
      target: { kind: 'existing', dimensionId: first.dimensionId },
    })
    expect(second.createdParameters.map((p) => p.name)).toEqual(['Users'])
    expect(second.skippedEntryIds).toEqual([buyers.id])
    expect(await listParameters(db, first.dimensionId)).toHaveLength(2)
  })
})

describe('linked-parameter resolution (delete requires resolution, invariant 7)', () => {
  it('listParametersBySourceEntries finds the parameters linked to a subtree', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    const { dimensionId } = await promoteEntries(db, {
      projectId,
      entryIds: [users.id],
      target: { kind: 'new', name: 'Stake' },
    })
    const linked = await listParametersBySourceEntries(db, [users.id])
    expect(linked).toHaveLength(1)
    expect(linked[0]?.dimensionId).toBe(dimensionId)
  })

  it('unlinkParametersFromEntries keeps the parameter but clears source_entry_id (no orphan)', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    const { dimensionId } = await promoteEntries(db, {
      projectId,
      entryIds: [users.id],
      target: { kind: 'new', name: 'Stake' },
    })
    const param = nn((await listParameters(db, dimensionId))[0])
    await unlinkParametersFromEntries(db, [param.id])
    const after = await listParameters(db, dimensionId)
    expect(after).toHaveLength(1)
    expect(after[0]?.sourceEntryId).toBeNull()
    // No live parameter references the (about-to-be-deleted) entry.
    expect(await listParametersBySourceEntries(db, [users.id])).toHaveLength(0)
  })

  it('deleteParametersUnbinding removes the parameter and unbinds its contexts', async () => {
    const { db, projectId } = await freshProject()
    // Two dimensions so a context can be complete enough to bind Stake.
    const other = await addTier2Table(db, projectId, 'Value')
    const v = await addTier2Entry(db, other.id, null, 'Comfort')
    await promoteEntries(db, { projectId, entryIds: [v.id], target: { kind: 'new', name: 'Value' } })

    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    const { dimensionId } = await promoteEntries(db, {
      projectId,
      entryIds: [users.id],
      target: { kind: 'new', name: 'Stake' },
    })
    const param = nn((await listParameters(db, dimensionId))[0])
    const ctx = await createContext(db, projectId)
    await bindParameter(db, ctx.id, dimensionId, param.id)
    expect(await countBindingsForParameter(db, param.id)).toBe(1)

    const { affectedContextIds } = await deleteParametersUnbinding(db, [param.id])
    expect(affectedContextIds).toContain(ctx.id)
    expect(await listParameters(db, dimensionId)).toHaveLength(0)
    expect(await countBindingsForParameter(db, param.id)).toBe(0)
  })
})

describe('integrity — no orphan source_entry_id', () => {
  it('after deleting a linked entry (keep path), no parameter points at a dead entry', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    const { dimensionId } = await promoteEntries(db, {
      projectId,
      entryIds: [users.id],
      target: { kind: 'new', name: 'Stake' },
    })
    const param = nn((await listParameters(db, dimensionId))[0])
    // Keep-as-unlinked-copy, then remove the entry.
    await unlinkParametersFromEntries(db, [param.id])
    await removeTier2EntrySubtree(db, table.id, users.id)

    const liveEntryIds = new Set((await listTier2Entries(db, table.id)).map((e) => e.id))
    const params = await listParameters(db, dimensionId)
    for (const p of params) {
      if (p.sourceEntryId !== null) expect(liveEntryIds.has(p.sourceEntryId)).toBe(true)
    }
  })

  it('rename entry does not touch its linked parameter at the mutation layer (store propagates)', async () => {
    const { db, projectId } = await freshProject()
    const table = await addTier2Table(db, projectId, 'Stakeholders')
    const users = await addTier2Entry(db, table.id, null, 'Users')
    await promoteEntries(db, {
      projectId,
      entryIds: [users.id],
      target: { kind: 'new', name: 'Stake' },
    })
    const renamed = await renameTier2Entry(db, users.id, 'People')
    expect(renamed.name).toBe('People')
    // The linkage is intact; propagation of the name is the store's job.
    expect(await listParametersBySourceEntries(db, [users.id])).toHaveLength(1)
  })
})
