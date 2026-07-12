import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { createProject, getTier1Purpose, listTier1Props } from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetSyncStore, useSyncStore } from './sync'
import { resetTier1Store, useTier1Store } from './tier1'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier1Store()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  await useTier1Store.getState().load(projectId)
})

describe('tier1 store — props', () => {
  it('addProp persists and pushes one undoable step', async () => {
    await useTier1Store.getState().addProp('Seating-status comfort')
    expect(useTier1Store.getState().props.map((p) => p.name)).toEqual(['Seating-status comfort'])
    expect(await listTier1Props(db, projectId)).toHaveLength(1)

    await useCommandLogStore.getState().undo()
    expect(useTier1Store.getState().props).toEqual([])
    expect(await listTier1Props(db, projectId)).toEqual([])

    await useCommandLogStore.getState().redo()
    expect(useTier1Store.getState().props.map((p) => p.name)).toEqual(['Seating-status comfort'])
  })

  it('reorderProp is a single undo step that restores the original order', async () => {
    await useTier1Store.getState().addProp('A')
    await useTier1Store.getState().addProp('B')
    await useTier1Store.getState().addProp('C')
    const cId = useTier1Store.getState().props[2]?.id as string

    await useTier1Store.getState().reorderProp(cId, 0)
    expect(useTier1Store.getState().props.map((p) => p.name)).toEqual(['C', 'A', 'B'])
    expect(useTier1Store.getState().props.map((p) => p.rank)).toEqual([1, 2, 3])

    await useCommandLogStore.getState().undo()
    expect(useTier1Store.getState().props.map((p) => p.name)).toEqual(['A', 'B', 'C'])
    expect(useTier1Store.getState().props.map((p) => p.rank)).toEqual([1, 2, 3])
  })

  it('removeProp closes the gap and is undoable to the exact position', async () => {
    await useTier1Store.getState().addProp('A')
    await useTier1Store.getState().addProp('B')
    await useTier1Store.getState().addProp('C')
    const bId = useTier1Store.getState().props[1]?.id as string

    await useTier1Store.getState().removeProp(bId)
    expect(useTier1Store.getState().props.map((p) => p.name)).toEqual(['A', 'C'])

    await useCommandLogStore.getState().undo()
    expect(useTier1Store.getState().props.map((p) => p.name)).toEqual(['A', 'B', 'C'])
  })
})

describe('tier1 store — purpose', () => {
  it('setPurpose autosaves through the mutation layer and is undoable', async () => {
    await useTier1Store.getState().setPurpose('Comfort, on demand.')
    expect(useTier1Store.getState().purpose).toBe('Comfort, on demand.')
    expect((await getTier1Purpose(db, projectId))?.body).toBe('Comfort, on demand.')

    await useTier1Store.getState().setPurpose('A better way to sit together.')
    await useCommandLogStore.getState().undo()
    expect(useTier1Store.getState().purpose).toBe('Comfort, on demand.')
    expect((await getTier1Purpose(db, projectId))?.body).toBe('Comfort, on demand.')
  })
})

// Issue 073 pt1 — domain-content mutations never reached the write outbox
// (only createProject/adoptProject and workspace.ts's 7 actions were wired).
// This closes the gap for tier1: every mutating action must call the shared
// enqueueIfSyncing() helper (src/store/sync.ts) once a sync workspace is set,
// signed-out/sync-off staying byte-for-byte unchanged (no queue growth) —
// mirrors workspace.test.ts's own "sync enqueue" describe block exactly.
describe('tier1 store — sync enqueue (issue 073 pt1)', () => {
  it('setPurpose enqueues an upsert on the first save, an update on the same row thereafter (natural-key subtlety)', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useTier1Store.getState().setPurpose('Comfort, on demand.')
    let queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ table: 'tier1_purpose', op: 'upsert', status: 'pending' })
    const rowId = queued[0]?.rowId

    await useTier1Store.getState().setPurpose('A better way to sit together.')
    queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(2)
    expect(queued[1]).toMatchObject({ table: 'tier1_purpose', rowId, op: 'update', status: 'pending' })
  })

  it('setPurpose enqueues nothing when no sync workspace is set (local-only, byte-for-byte unchanged)', async () => {
    await useTier1Store.getState().setPurpose('Comfort, on demand.')
    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  it('addProp enqueues a tier1_props upsert', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    const row = await useTier1Store.getState().addProp('Seating-status comfort')
    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'tier1_props',
      rowId: row?.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('reorderProp enqueues an update for every row whose sort/rank actually changed', async () => {
    await useTier1Store.getState().addProp('A')
    await useTier1Store.getState().addProp('B')
    await useTier1Store.getState().addProp('C')
    const cId = useTier1Store.getState().props[2]?.id as string
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useTier1Store.getState().reorderProp(cId, 0)

    // C: 2→0, A: 0→1, B: 1→2 — every row's sort/rank moved.
    const queued = useSyncStore.getState().queue.entries
    expect(queued.filter((e) => e.table === 'tier1_props' && e.op === 'update')).toHaveLength(3)
    expect(queued.map((e) => e.rowId).sort()).toEqual(
      useTier1Store.getState().props.map((p) => p.id).sort(),
    )
  })

  it('removeProp enqueues a delete for the removed row and an update for every shifted sibling', async () => {
    await useTier1Store.getState().addProp('A')
    await useTier1Store.getState().addProp('B')
    await useTier1Store.getState().addProp('C')
    const [aId, bId, cId] = useTier1Store.getState().props.map((p) => p.id)
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useTier1Store.getState().removeProp(bId as string)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toContainEqual(expect.objectContaining({ table: 'tier1_props', rowId: bId, op: 'delete' }))
    // C closes the gap (sort 2→1, rank 3→2); A stays at 0/1 — unchanged, not enqueued.
    expect(queued).toContainEqual(expect.objectContaining({ table: 'tier1_props', rowId: cId, op: 'update' }))
    expect(queued.find((e) => e.rowId === aId)).toBeUndefined()
    expect(queued).toHaveLength(2)
  })
})
