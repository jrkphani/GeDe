import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { addDimension, createProject, listParameters } from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetParametersStore, useParametersStore } from './parameters'
import { resetSyncStore, useSyncStore } from './sync'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let dimensionId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetParametersStore()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  const dimension = await addDimension(db, project.id)
  dimensionId = dimension.id
})

describe('parameters store — command log (issue 006)', () => {
  it('undo of add removes it (persisted too); redo restores the same id', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    const id = useParametersStore.getState().byDimension[dimensionId]?.[0]?.id as string

    await useCommandLogStore.getState().undo()
    expect(useParametersStore.getState().byDimension[dimensionId]).toEqual([])
    expect(await listParameters(db, dimensionId)).toEqual([])

    await useCommandLogStore.getState().redo()
    expect(useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id)).toEqual([id])
  })

  it('undo of rename restores the previous name; redo re-applies the new one', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    const id = useParametersStore.getState().byDimension[dimensionId]?.[0]?.id as string
    await useParametersStore.getState().rename(dimensionId, id, 'Purchasers')

    await useCommandLogStore.getState().undo()
    expect(useParametersStore.getState().byDimension[dimensionId]?.[0]?.name).toBe('Buyers')

    await useCommandLogStore.getState().redo()
    expect(useParametersStore.getState().byDimension[dimensionId]?.[0]?.name).toBe('Purchasers')
  })

  it('undo of a middle removal restores the exact original order; redo removes it again', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    await useParametersStore.getState().add(dimensionId, 'Maintainer')
    await useParametersStore.getState().add(dimensionId, 'Users')
    const orderedIds = useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id) as string[]
    const middleId = orderedIds[1] as string

    await useParametersStore.getState().remove(dimensionId, middleId)
    expect(useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id)).toEqual([
      orderedIds[0],
      orderedIds[2],
    ])

    await useCommandLogStore.getState().undo()
    expect(useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id)).toEqual(orderedIds)
    expect((await listParameters(db, dimensionId)).map((p) => p.sort)).toEqual([0, 1, 2])

    await useCommandLogStore.getState().redo()
    expect(useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id)).toEqual([
      orderedIds[0],
      orderedIds[2],
    ])
  })

  it('undo of reorder moves it back to its original index', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    await useParametersStore.getState().add(dimensionId, 'Maintainer')
    const orderedIds = useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id) as string[]

    await useParametersStore.getState().reorder(dimensionId, orderedIds[1] as string, 0)
    expect(useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id)).toEqual([
      orderedIds[1],
      orderedIds[0],
    ])

    await useCommandLogStore.getState().undo()
    expect(useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id)).toEqual(orderedIds)
  })
})

// Issue 073 pt2 — parameters.ts was one of the unwired domain-content stores:
// add/rename/reorder/remove wrote to local PGlite + the command log but
// never enqueued to the write outbox. Mirrors dimensions.test.ts's own "sync
// enqueue" describe block.
describe('parameters store — sync enqueue (issue 073 pt2)', () => {
  it('add enqueues a parameters upsert', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    const row = await useParametersStore.getState().add(dimensionId, 'Buyers')
    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'parameters',
      rowId: row?.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('add enqueues nothing when no sync workspace is set (local-only, byte-for-byte unchanged)', async () => {
    await useParametersStore.getState().add(dimensionId, 'Buyers')
    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  it('rename enqueues a parameters update', async () => {
    const row = await useParametersStore.getState().add(dimensionId, 'Buyers')
    const id = (row as { id: string }).id
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useParametersStore.getState().rename(dimensionId, id, 'Purchasers')

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ table: 'parameters', rowId: id, op: 'update', status: 'pending' })
  })

  it('reorder enqueues an update for every row whose sort actually changed (Subtlety B)', async () => {
    await useParametersStore.getState().add(dimensionId, 'A')
    await useParametersStore.getState().add(dimensionId, 'B')
    await useParametersStore.getState().add(dimensionId, 'C')
    const ids = useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id) as string[]
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useParametersStore.getState().reorder(dimensionId, ids[2] as string, 0)

    const queued = useSyncStore.getState().queue.entries
    expect(queued.filter((e) => e.table === 'parameters' && e.op === 'update')).toHaveLength(3)
    expect(queued.map((e) => e.rowId).sort()).toEqual([...ids].sort())
  })

  it('remove enqueues a parameters delete + an update for every shifted sibling', async () => {
    await useParametersStore.getState().add(dimensionId, 'A')
    await useParametersStore.getState().add(dimensionId, 'B')
    await useParametersStore.getState().add(dimensionId, 'C')
    const [aId, bId, cId] = useParametersStore.getState().byDimension[dimensionId]?.map((p) => p.id) as string[]
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useParametersStore.getState().remove(dimensionId, bId as string)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toContainEqual(expect.objectContaining({ table: 'parameters', rowId: bId, op: 'delete' }))
    // C closes the gap (sort 2→1); A stays at 0 — unchanged, not enqueued.
    expect(queued).toContainEqual(expect.objectContaining({ table: 'parameters', rowId: cId, op: 'update' }))
    expect(queued.find((e) => e.rowId === aId)).toBeUndefined()
    expect(queued).toHaveLength(2)
  })
})
