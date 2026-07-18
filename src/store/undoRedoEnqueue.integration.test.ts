import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { bindParameter, createContext, createProject } from '../db/mutations'
import { setDatabase } from './database'
import { useCanvasesStore, resetCanvasesStore } from './canvases'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetParametersStore, useParametersStore } from './parameters'
import { resetProjectsStore, useProjectsStore } from './projects'
import { resetSyncStore, useSyncStore } from './sync'
import { resetTier1Store, useTier1Store } from './tier1'
import { resetTier2Store, useTier2Store } from './tier2'

// Issue 094 — the persistence half of the command-log undo/redo. Every store's
// FORWARD mutation enqueues its row-level deltas onto the sync outbox
// (enqueueIfSyncing, issue 073); before this fix the undo/redo closures replayed
// through the local DB but enqueued NOTHING, so in cloud/sync mode a reversal
// reversed local PGlite but never reached the server → the streamed server row
// clobbered it on reload. These tests seed a syncing workspace, run a forward
// mutation, then assert undo enqueues the correct REVERSAL op(s) and redo the
// correct RE-APPLICATION op(s). Watch every one FAIL on pre-094 code (the outbox
// stays empty on undo/redo).

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

// The op-selection rule this whole issue mirrors (issue 073 / 094 / canvases.ts):
//  - a brand-new row → 'upsert' (forward only; the server has never seen the id)
//  - RESURRECTING a soft-deleted row (undo of a remove/delete/archive, redo of
//    an add/create) → 'revive' (094): a plain 'update' can't clear deleted_at
//    server-side, and an 'upsert' would `ON CONFLICT (id) DO NOTHING`. 'revive'
//    un-tombstones the row (or inserts it live if absent).
//  - tombstoning → 'delete'; editing fields / re-sorting a LIVE row → 'update'.

function outboxLen(): number {
  return useSyncStore.getState().queue.entries.length
}

function addedSince(from: number): { table: string; rowId: string; op: string }[] {
  return useSyncStore
    .getState()
    .queue.entries.slice(from)
    .map((e) => ({ table: e.table, rowId: e.rowId, op: e.op }))
}

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  // resetProjectsStore() calls resetDatabase(), so set the DB handle AFTER the
  // resets, not before (else requireDatabase() throws in the store loads below).
  resetProjectsStore()
  resetTier1Store()
  resetTier2Store()
  resetDimensionsStore()
  resetParametersStore()
  resetContextsStore()
  resetCanvasesStore()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  setDatabase(db)
  // Created signed-out so this setup never enqueues; each test enables sync
  // (workspaceId) right before the mutation whose reversal it asserts.
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
})

function enableSync(): void {
  useSyncStore.setState({ workspaceId: 'ws1' })
}

describe('094 dimensions — undo/redo enqueue reversal onto the sync outbox', () => {
  beforeEach(async () => {
    await useDimensionsStore.getState().load(projectId)
  })

  it('add: undo enqueues a delete, redo enqueues a revive (not upsert)', async () => {
    enableSync()
    const row = await useDimensionsStore.getState().add()
    const id = (row as { id: string }).id

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'dimensions', rowId: id, op: 'delete' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'dimensions', rowId: id, op: 'revive' }])
  })

  it('setColor: undo and redo each enqueue an update', async () => {
    const row = await useDimensionsStore.getState().add()
    const id = (row as { id: string }).id
    enableSync()
    await useDimensionsStore.getState().setColor(id, '#123456')

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'dimensions', rowId: id, op: 'update' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'dimensions', rowId: id, op: 'update' }])
  })

  it('reorder: undo and redo enqueue a sort-delta update for every moved row', async () => {
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    const ids = useDimensionsStore.getState().dimensions.map((d) => d.id)
    enableSync()
    await useDimensionsStore.getState().reorder(ids[2] as string, 0)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo.length).toBeGreaterThan(0)
    expect(undo.every((m) => m.table === 'dimensions' && m.op === 'update')).toBe(true)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    const redo = addedSince(at)
    expect(redo.length).toBeGreaterThan(0)
    expect(redo.every((m) => m.table === 'dimensions' && m.op === 'update')).toBe(true)
  })

  it('remove: undo revives the row, redo re-tombstones (delete) it', async () => {
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    const ids = useDimensionsStore.getState().dimensions.map((d) => d.id)
    const middle = ids[1] as string
    enableSync()
    await useDimensionsStore.getState().remove(middle)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo).toContainEqual({ table: 'dimensions', rowId: middle, op: 'revive' })
    expect(undo.some((m) => m.op === 'delete' || m.op === 'upsert')).toBe(false)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    const redo = addedSince(at)
    expect(redo).toContainEqual({ table: 'dimensions', rowId: middle, op: 'delete' })
    expect(redo.some((m) => m.op === 'upsert')).toBe(false)
  })
})

describe('094 parameters — undo/redo enqueue reversal onto the sync outbox', () => {
  let dimId: string
  beforeEach(async () => {
    await useDimensionsStore.getState().load(projectId)
    const dim = await useDimensionsStore.getState().add()
    dimId = (dim as { id: string }).id
    await useParametersStore.getState().load(dimId)
  })

  it('add: undo enqueues a delete, redo enqueues a revive', async () => {
    enableSync()
    const row = await useParametersStore.getState().add(dimId, 'Comfort')
    const id = (row as { id: string }).id

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'parameters', rowId: id, op: 'delete' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'parameters', rowId: id, op: 'revive' }])
  })

  it('rename: undo and redo each enqueue an update', async () => {
    const row = await useParametersStore.getState().add(dimId, 'Comfort')
    const id = (row as { id: string }).id
    enableSync()
    await useParametersStore.getState().rename(dimId, id, 'Cosy')

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'parameters', rowId: id, op: 'update' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'parameters', rowId: id, op: 'update' }])
  })

  it('reorder: undo and redo enqueue sort-delta updates', async () => {
    await useParametersStore.getState().add(dimId, 'A')
    await useParametersStore.getState().add(dimId, 'B')
    await useParametersStore.getState().add(dimId, 'C')
    const ids = useParametersStore.getState().byDimension[dimId]?.map((p) => p.id) ?? []
    enableSync()
    await useParametersStore.getState().reorder(dimId, ids[2] as string, 0)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo.length).toBeGreaterThan(0)
    expect(undo.every((m) => m.table === 'parameters' && m.op === 'update')).toBe(true)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at).every((m) => m.table === 'parameters' && m.op === 'update')).toBe(true)
  })

  it('remove: undo revives, redo re-tombstones (delete)', async () => {
    await useParametersStore.getState().add(dimId, 'A')
    await useParametersStore.getState().add(dimId, 'B')
    const ids = useParametersStore.getState().byDimension[dimId]?.map((p) => p.id) ?? []
    const first = ids[0] as string
    enableSync()
    await useParametersStore.getState().remove(dimId, first)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo).toContainEqual({ table: 'parameters', rowId: first, op: 'revive' })
    expect(undo.some((m) => m.op === 'delete' || m.op === 'upsert')).toBe(false)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toContainEqual({ table: 'parameters', rowId: first, op: 'delete' })
  })
})

describe('094 tier1 — undo/redo enqueue reversal onto the sync outbox', () => {
  beforeEach(async () => {
    await useTier1Store.getState().load(projectId)
  })

  it('addProp: undo enqueues delete, redo enqueues revive', async () => {
    enableSync()
    const row = await useTier1Store.getState().addProp('Speed')
    const id = (row as { id: string }).id

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'tier1_props', rowId: id, op: 'delete' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'tier1_props', rowId: id, op: 'revive' }])
  })

  it('reorderProp: undo and redo enqueue rank/sort-delta updates', async () => {
    await useTier1Store.getState().addProp('A')
    await useTier1Store.getState().addProp('B')
    await useTier1Store.getState().addProp('C')
    const ids = useTier1Store.getState().props.map((p) => p.id)
    enableSync()
    await useTier1Store.getState().reorderProp(ids[2] as string, 0)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo.length).toBeGreaterThan(0)
    expect(undo.every((m) => m.table === 'tier1_props' && m.op === 'update')).toBe(true)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at).every((m) => m.table === 'tier1_props' && m.op === 'update')).toBe(true)
  })

  it('removeProp: undo revives, redo re-tombstones (delete)', async () => {
    await useTier1Store.getState().addProp('A')
    await useTier1Store.getState().addProp('B')
    const ids = useTier1Store.getState().props.map((p) => p.id)
    const first = ids[0] as string
    enableSync()
    await useTier1Store.getState().removeProp(first)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toContainEqual({ table: 'tier1_props', rowId: first, op: 'revive' })

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toContainEqual({ table: 'tier1_props', rowId: first, op: 'delete' })
  })

  it('setPurpose: undo and redo enqueue an update on the shared tier1_purpose row', async () => {
    enableSync()
    await useTier1Store.getState().setPurpose('Comfort, on demand.')
    const before = outboxLen()

    await useCommandLogStore.getState().undo()
    const undo = addedSince(before)
    expect(undo.length).toBe(1)
    expect(undo[0]).toMatchObject({ table: 'tier1_purpose', op: 'update' })

    const at = outboxLen()
    await useCommandLogStore.getState().redo()
    const redo = addedSince(at)
    expect(redo.length).toBe(1)
    expect(redo[0]).toMatchObject({ table: 'tier1_purpose', op: 'update' })
  })
})

describe('094 canvases — undo/redo enqueue reversal onto the sync outbox', () => {
  beforeEach(async () => {
    await useCanvasesStore.getState().load(projectId)
  })

  it('rename: undo and redo each enqueue an update (was silently unwired pre-094)', async () => {
    const row = await useCanvasesStore.getState().create('Second')
    const id = (row as { id: string }).id
    enableSync()
    await useCanvasesStore.getState().rename(id, 'Renamed')

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'canvases', rowId: id, op: 'update' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'canvases', rowId: id, op: 'update' }])
  })

  it('reorder: undo and redo enqueue sort-delta updates', async () => {
    await useCanvasesStore.getState().create('B')
    await useCanvasesStore.getState().create('C')
    const ids = useCanvasesStore.getState().canvases.map((c) => c.id)
    enableSync()
    await useCanvasesStore.getState().reorder(ids[ids.length - 1] as string, 0)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo.length).toBeGreaterThan(0)
    expect(undo.every((m) => m.table === 'canvases' && m.op === 'update')).toBe(true)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at).every((m) => m.table === 'canvases' && m.op === 'update')).toBe(true)
  })
})

describe('094 contexts — undo/redo enqueue reversal onto the sync outbox', () => {
  beforeEach(async () => {
    await useContextsStore.getState().load(projectId)
  })

  it('create: undo enqueues a delete, redo enqueues a revive', async () => {
    enableSync()
    const row = await useContextsStore.getState().create()
    const id = (row as { id: string }).id

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'contexts', rowId: id, op: 'delete' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'contexts', rowId: id, op: 'revive' }])
  })

  it('setJustification: undo and redo each enqueue an update', async () => {
    const row = await useContextsStore.getState().create()
    const id = (row as { id: string }).id
    enableSync()
    await useContextsStore.getState().setJustification(id, 'because')

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'contexts', rowId: id, op: 'update' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'contexts', rowId: id, op: 'update' }])
  })

  it('bind: undo tombstones the new binding (delete), redo revives it (revive, not upsert)', async () => {
    await useDimensionsStore.getState().load(projectId)
    const dim = await useDimensionsStore.getState().add()
    const dimId = (dim as { id: string }).id
    await useParametersStore.getState().load(dimId)
    const param = await useParametersStore.getState().add(dimId, 'P1')
    const paramId = (param as { id: string }).id
    const ctx = await useContextsStore.getState().create()
    const ctxId = (ctx as { id: string }).id
    enableSync()
    await useContextsStore.getState().bind(ctxId, dimId, paramId)
    // The forward bind enqueued one 'upsert' for the new binding — grab its rowId.
    const forwardBinding = useSyncStore.getState().queue.entries.find((e) => e.table === 'bindings')
    const rowId = forwardBinding?.rowId as string
    expect(rowId).toBeTruthy()

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'bindings', rowId, op: 'delete' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'bindings', rowId, op: 'revive' }])
  })

  it('unbind: undo revives the binding (revive), redo re-tombstones it (delete)', async () => {
    await useDimensionsStore.getState().load(projectId)
    const dim = await useDimensionsStore.getState().add()
    const dimId = (dim as { id: string }).id
    await useParametersStore.getState().load(dimId)
    const param = await useParametersStore.getState().add(dimId, 'P1')
    const paramId = (param as { id: string }).id
    const ctx = await useContextsStore.getState().create()
    const ctxId = (ctx as { id: string }).id
    await useContextsStore.getState().bind(ctxId, dimId, paramId)
    enableSync()
    await useContextsStore.getState().unbind(ctxId, dimId)
    const forwardDelete = useSyncStore.getState().queue.entries.find((e) => e.table === 'bindings')
    const rowId = forwardDelete?.rowId as string

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'bindings', rowId, op: 'revive' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'bindings', rowId, op: 'delete' }])
  })
})

describe('094 tier2 — undo/redo enqueue reversal onto the sync outbox', () => {
  beforeEach(async () => {
    await useTier2Store.getState().load(projectId)
  })

  it('addTable: undo enqueues a delete, redo enqueues a revive', async () => {
    enableSync()
    const row = await useTier2Store.getState().addTable('Personas')
    const id = (row as { id: string }).id

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'tier2_tables', rowId: id, op: 'delete' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'tier2_tables', rowId: id, op: 'revive' }])
  })

  it('reorderTable: undo and redo enqueue sort-delta updates', async () => {
    await useTier2Store.getState().addTable('A')
    await useTier2Store.getState().addTable('B')
    await useTier2Store.getState().addTable('C')
    const ids = useTier2Store.getState().tables.map((t) => t.id)
    enableSync()
    await useTier2Store.getState().reorderTable(ids[2] as string, 0)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo.length).toBeGreaterThan(0)
    expect(undo.every((m) => m.table === 'tier2_tables' && m.op === 'update')).toBe(true)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at).every((m) => m.table === 'tier2_tables' && m.op === 'update')).toBe(true)
  })

  it('removeEntry: undo revives the entry (revive), redo re-tombstones it (delete)', async () => {
    const table = await useTier2Store.getState().addTable('T')
    const tableId = (table as { id: string }).id
    const entry = await useTier2Store.getState().addEntry(tableId, null, 'E1')
    const entryId = (entry as { id: string }).id
    enableSync()
    await useTier2Store.getState().removeEntry(tableId, entryId)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toContainEqual({ table: 'tier2_entries', rowId: entryId, op: 'revive' })

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toContainEqual({ table: 'tier2_entries', rowId: entryId, op: 'delete' })
  })

  it('promote: undo tombstones the created dimension+parameter (delete), redo revives them (revive)', async () => {
    const table = await useTier2Store.getState().addTable('T')
    const tableId = (table as { id: string }).id
    const entry = await useTier2Store.getState().addEntry(tableId, null, 'E1')
    const entryId = (entry as { id: string }).id
    enableSync()
    const outcome = await useTier2Store.getState().promote({
      projectId,
      entryIds: [entryId],
      target: { kind: 'new', name: 'Value' },
    })
    const dimId = outcome.createdDimension?.id as string
    const paramId = outcome.createdParameters[0]?.id as string
    expect(dimId).toBeTruthy()
    expect(paramId).toBeTruthy()

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo).toContainEqual({ table: 'dimensions', rowId: dimId, op: 'delete' })
    expect(undo).toContainEqual({ table: 'parameters', rowId: paramId, op: 'delete' })
    expect(undo.some((m) => m.op === 'upsert')).toBe(false)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    const redo = addedSince(at)
    expect(redo).toContainEqual({ table: 'dimensions', rowId: dimId, op: 'revive' })
    expect(redo).toContainEqual({ table: 'parameters', rowId: paramId, op: 'revive' })
    expect(redo.some((m) => m.op === 'upsert')).toBe(false)
  })

  // Issue 094 — the highest-risk asymmetric-tombstone cascade: a promoted entry
  // links a parameter that a context has bound. resolveDeleteParams soft-deletes
  // that parameter, HARD-deletes its binding, and removes the entry subtree, all
  // in one command-log step. Its undo must resurrect every tombstoned row —
  // parameter, binding AND entry — as 'revive' (a plain 'update' can't clear
  // deleted_at server-side; checkTenancy rejects a tombstoned target as
  // unknown_entity), and its redo must re-tombstone them as 'delete'. Seed the
  // whole promoted-entry-with-binding chain, then assert the exact reversal ops.
  it('resolveDeleteParams: undo revives the params + bindings + entry (revive), redo re-tombstones (delete)', async () => {
    const table = await useTier2Store.getState().addTable('T')
    const tableId = (table as { id: string }).id
    const entry = await useTier2Store.getState().addEntry(tableId, null, 'E1')
    const entryId = (entry as { id: string }).id
    const outcome = await useTier2Store.getState().promote({
      projectId,
      entryIds: [entryId],
      target: { kind: 'new', name: 'Value' },
    })
    const dimId = outcome.dimensionId
    const paramId = outcome.createdParameters[0]?.id as string
    expect(paramId).toBeTruthy()
    // Bind the promoted parameter to a context so resolveDeleteParams has a live
    // binding to hard-delete (and its undo a row to resurrect).
    const ctx = await createContext(db, projectId)
    const boundRows = await bindParameter(db, ctx.id, dimId, paramId)
    const bindingId = boundRows.find((r) => r.dimensionId === dimId)?.id as string
    expect(bindingId).toBeTruthy()

    enableSync()
    await useTier2Store.getState().resolveDeleteParams(tableId, entryId)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo).toContainEqual({ table: 'parameters', rowId: paramId, op: 'revive' })
    expect(undo).toContainEqual({ table: 'bindings', rowId: bindingId, op: 'revive' })
    expect(undo).toContainEqual({ table: 'tier2_entries', rowId: entryId, op: 'revive' })
    // Never re-add a tombstoned row via 'upsert' (ON CONFLICT DO NOTHING no-op).
    expect(undo.some((m) => m.op === 'upsert')).toBe(false)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    const redo = addedSince(at)
    expect(redo).toContainEqual({ table: 'parameters', rowId: paramId, op: 'delete' })
    expect(redo).toContainEqual({ table: 'bindings', rowId: bindingId, op: 'delete' })
    expect(redo).toContainEqual({ table: 'tier2_entries', rowId: entryId, op: 'delete' })
    expect(redo.some((m) => m.op === 'upsert' || m.op === 'revive')).toBe(false)
  })

  // Issue 094 — resolveKeep's sibling cascade: it KEEPS the promoted parameters
  // (only unlinking sourceEntryId → a field edit → 'update', never a tombstone)
  // while removing the entry subtree (→ 'delete'). So its undo revives the entry
  // subtree (→ 'revive') and re-links the params (→ 'update', NOT 'revive'), and
  // its redo re-unlinks the params (→ 'update') and re-removes the entry
  // (→ 'delete'). Guards against the params ever being mis-enqueued as a
  // tombstone-class op on this branch.
  it('resolveKeep: undo revives the entry (revive) + re-links params (update), redo re-tombstones the entry', async () => {
    const table = await useTier2Store.getState().addTable('T')
    const tableId = (table as { id: string }).id
    const entry = await useTier2Store.getState().addEntry(tableId, null, 'E1')
    const entryId = (entry as { id: string }).id
    const outcome = await useTier2Store.getState().promote({
      projectId,
      entryIds: [entryId],
      target: { kind: 'new', name: 'Value' },
    })
    const paramId = outcome.createdParameters[0]?.id as string
    expect(paramId).toBeTruthy()

    enableSync()
    await useTier2Store.getState().resolveKeep(tableId, entryId)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    const undo = addedSince(at)
    expect(undo).toContainEqual({ table: 'tier2_entries', rowId: entryId, op: 'revive' })
    expect(undo).toContainEqual({ table: 'parameters', rowId: paramId, op: 'update' })
    // The kept params stayed live throughout — they must never be tombstone-class.
    expect(undo.filter((m) => m.table === 'parameters').every((m) => m.op === 'update')).toBe(true)

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    const redo = addedSince(at)
    expect(redo).toContainEqual({ table: 'parameters', rowId: paramId, op: 'update' })
    expect(redo).toContainEqual({ table: 'tier2_entries', rowId: entryId, op: 'delete' })
    expect(redo.filter((m) => m.table === 'parameters').every((m) => m.op === 'update')).toBe(true)
  })
})

describe('094 projects — undo/redo enqueue reversal onto the sync outbox', () => {
  beforeEach(async () => {
    await useProjectsStore.getState().init(db)
  })

  it('renameProject: undo and redo each enqueue an update', async () => {
    enableSync()
    await useProjectsStore.getState().renameProject(projectId, 'Renamed')

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'projects', rowId: projectId, op: 'update' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'projects', rowId: projectId, op: 'update' }])
  })

  it('archiveProject: undo revives, redo re-tombstones (delete)', async () => {
    enableSync()
    await useProjectsStore.getState().archiveProject(projectId)

    let at = outboxLen()
    await useCommandLogStore.getState().undo()
    expect(addedSince(at)).toEqual([{ table: 'projects', rowId: projectId, op: 'revive' }])

    at = outboxLen()
    await useCommandLogStore.getState().redo()
    expect(addedSince(at)).toEqual([{ table: 'projects', rowId: projectId, op: 'delete' }])
  })
})
