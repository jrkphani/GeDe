import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  createProject,
  listParameters,
  listParametersBySourceEntries,
  listTier2Entries,
} from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetTier2Store, useTier2Store } from './tier2'

// Test helper: the store's create actions return `| null` only when no project
// is loaded (never in these tests). Narrow without a non-null assertion.
function nn<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a non-null value')
  return value
}

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier2Store()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  await useTier2Store.getState().load(projectId)
})

function tables() {
  return useTier2Store.getState().tables
}
function entriesOf(tableId: string) {
  return useTier2Store.getState().entriesByTable[tableId] ?? []
}

describe('tier2 store — tables & entries', () => {
  it('addTable persists and is one undo step', async () => {
    await useTier2Store.getState().addTable('Stakeholders')
    expect(tables().map((t) => t.name)).toEqual(['Stakeholders'])

    await useCommandLogStore.getState().undo()
    expect(tables()).toEqual([])
    await useCommandLogStore.getState().redo()
    expect(tables().map((t) => t.name)).toEqual(['Stakeholders'])
  })

  it('addEntry nests via parentId', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    await useTier2Store.getState().addEntry(table.id, buyers.id, 'Superstars')
    const entries = entriesOf(table.id)
    expect(entries.map((e) => e.name).sort()).toEqual(['Buyers', 'Superstars'])
    expect(entries.find((e) => e.name === 'Superstars')?.parentId).toBe(buyers.id)
  })
})

describe('tier2 store — promote (one undo step, invariant 7)', () => {
  it('promote creates a dimension + parameters and undoes/redoes as a single step', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))

    const outcome = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id, users.id], target: { kind: 'new', name: 'Stake' } })
    expect(await listParameters(db, outcome.dimensionId)).toHaveLength(2)

    // One undo step removes both the dimension and its parameters.
    await useCommandLogStore.getState().undo()
    expect(await listParameters(db, outcome.dimensionId)).toHaveLength(0)

    await useCommandLogStore.getState().redo()
    expect(await listParameters(db, outcome.dimensionId)).toHaveLength(2)
  })

  it('re-promote extends without duplicating already-linked entries', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const first = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id], target: { kind: 'new', name: 'Stake' } })
    const second = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id], target: { kind: 'existing', dimensionId: first.dimensionId } })
    expect(second.createdParameters).toHaveLength(0)
    expect(await listParameters(db, first.dimensionId)).toHaveLength(1)
  })

  it('linkByEntryId reflects the promoted entry for the source badge', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })
    expect(useTier2Store.getState().linkByEntryId[users.id]?.dimensionName).toBe('Stake')
  })
})

describe('tier2 store — rename propagation (invariant 7)', () => {
  it('renaming a linked entry renames its parameter and reports the count', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const outcome = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    const count = await useTier2Store.getState().renameEntry(table.id, users.id, 'People')
    expect(count).toBe(1)
    expect((await listParameters(db, outcome.dimensionId))[0]?.name).toBe('People')

    // One undo reverts both the entry and the parameter name.
    await useCommandLogStore.getState().undo()
    expect((await listParameters(db, outcome.dimensionId))[0]?.name).toBe('Users')
    expect(entriesOf(table.id).find((e) => e.id === users.id)?.name).toBe('Users')
  })
})

describe('tier2 store — delete with linked parameter surfaces a typed resolution', () => {
  it('removeEntry on an unlinked entry deletes it directly', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const result = await useTier2Store.getState().removeEntry(table.id, buyers.id)
    expect(result.kind).toBe('removed')
    expect(entriesOf(table.id)).toEqual([])
  })

  it('removeEntry on a linked entry returns needs-resolution and does NOT delete', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    const result = await useTier2Store.getState().removeEntry(table.id, users.id)
    expect(result.kind).toBe('needs-resolution')
    if (result.kind === 'needs-resolution') {
      expect(result.links).toHaveLength(1)
      expect(result.links[0]?.parameterName).toBe('Users')
    }
    // Nothing deleted yet — resolution is required first (no silent cascade).
    expect(entriesOf(table.id).map((e) => e.name)).toEqual(['Users'])
  })

  it('resolveKeep deletes the entry but keeps the parameter unlinked (no orphan)', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const { dimensionId } = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    await useTier2Store.getState().resolveKeep(table.id, users.id)
    expect(entriesOf(table.id)).toEqual([])
    const params = await listParameters(db, dimensionId)
    expect(params).toHaveLength(1)
    expect(params[0]?.sourceEntryId).toBeNull()
    expect(await listParametersBySourceEntries(db, [users.id])).toHaveLength(0)
  })

  it('resolveDeleteParams deletes both the entry and its parameter', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const { dimensionId } = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    await useTier2Store.getState().resolveDeleteParams(table.id, users.id)
    expect(entriesOf(table.id)).toEqual([])
    expect(await listParameters(db, dimensionId)).toHaveLength(0)
    expect(await listTier2Entries(db, table.id)).toEqual([])
  })
})
