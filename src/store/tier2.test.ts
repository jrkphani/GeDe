import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  addTier2Entry,
  addTier2Table,
  createProject,
  listParameters,
  listParametersBySourceEntries,
  listTier2Entries,
} from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetSyncStore, useSyncStore } from './sync'
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
  resetSyncStore()
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

// Issue 073 pt1 — tier2's mutating actions never reached the write outbox.
// Mirrors tier1.test.ts's own "sync enqueue" describe block: seed a sync
// workspace, assert the shared enqueueIfSyncing() helper (src/store/sync.ts)
// queues the right (table, rowId, op).
describe('tier2 store — sync enqueue (issue 073 pt1)', () => {
  it('addTable enqueues a tier2_tables upsert', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'tier2_tables',
      rowId: table.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('addEntry enqueues a tier2_entries upsert', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    useSyncStore.setState({ workspaceId: 'ws1' })
    const entry = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'tier2_entries',
      rowId: entry.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('promote enqueues an upsert for the created dimension and every created parameter row', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    useSyncStore.setState({ workspaceId: 'ws1' })

    const outcome = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id, users.id], target: { kind: 'new', name: 'Stake' } })

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(3) // 1 created dimension + 2 created parameters
    expect(queued.filter((e) => e.table === 'dimensions' && e.op === 'upsert')).toHaveLength(1)
    expect(queued.find((e) => e.table === 'dimensions')?.rowId).toBe(outcome.dimensionId)
    const paramEntries = queued.filter((e) => e.table === 'parameters' && e.op === 'upsert')
    expect(paramEntries).toHaveLength(2)
    expect(paramEntries.map((e) => e.rowId).sort()).toEqual(
      outcome.createdParameters.map((p) => p.id).sort(),
    )
  })
})

// Issue 075 Part B — tier2.ts was one of the read-path stores with no delta
// subscription: load() ran once per project-open and never re-read PGlite
// afterward. Mirrors 072's projects.ts refresh wiring, scoped to this store's
// combined table signal (src/store/sync.ts's tier2AppliedAt, bumped for
// EITHER tier2_tables or tier2_entries).
describe('tier2 store — refresh on inbound delta (issue 075 Part B)', () => {
  it('a table row written directly to PGlite after load() appears once the tier2 signal bumps', async () => {
    expect(useTier2Store.getState().tables).toEqual([])

    // Simulate a delta landing directly in local PGlite — bypasses the store
    // entirely, exactly like 075A's apply path (src/db/sync.ts) would.
    const streamedIn = await addTier2Table(db, projectId, 'Streamed In')
    expect(useTier2Store.getState().tables.some((t) => t.id === streamedIn.id)).toBe(false)

    useSyncStore.setState({ tier2AppliedAt: Date.now() })

    for (
      let i = 0;
      i < 20 && !useTier2Store.getState().tables.some((t) => t.id === streamedIn.id);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(useTier2Store.getState().tables.map((t) => t.id)).toContain(streamedIn.id)
  })

  it('an entry row written directly to PGlite after load() appears once the tier2 signal bumps', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    expect(useTier2Store.getState().entriesByTable[table.id]).toEqual([])

    const streamedIn = await addTier2Entry(db, table.id, null, 'Streamed In')
    expect(
      useTier2Store.getState().entriesByTable[table.id]?.some((e) => e.id === streamedIn.id),
    ).toBe(false)

    useSyncStore.setState({ tier2AppliedAt: Date.now() })

    for (
      let i = 0;
      i < 20 &&
      !useTier2Store.getState().entriesByTable[table.id]?.some((e) => e.id === streamedIn.id);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(useTier2Store.getState().entriesByTable[table.id]?.map((e) => e.id)).toContain(streamedIn.id)
  })
})
