import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  addDimension,
  addParameter,
  bindParameter,
  createContext,
  createProject,
  listCanvases,
  listContexts,
  listDimensions,
} from '../db/mutations'
import { setDatabase } from './database'
import { resetCanvasesStore, useCanvasesStore } from './canvases'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetSyncStore, useSyncStore } from './sync'
import { useStatusStore } from './status'

function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`)
  return value
}

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetCanvasesStore()
  resetContextsStore()
  resetDimensionsStore()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  useStatusStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
})

describe('canvases store — create / undo (issue 090 Phase 4b)', () => {
  it('load seeds selectedCanvasId to the first canvas; create appends + relists + selects it', async () => {
    await useCanvasesStore.getState().load(projectId)
    expect(useCanvasesStore.getState().canvases.map((c) => c.name)).toEqual(['Canvas 1'])
    const first = must(useCanvasesStore.getState().selectedCanvasId)

    const row = must(await useCanvasesStore.getState().create('Explorations'))
    expect(useCanvasesStore.getState().canvases.map((c) => c.name)).toEqual(['Canvas 1', 'Explorations'])
    expect(useCanvasesStore.getState().selectedCanvasId).toBe(row.id)
    expect(row.id).not.toBe(first)
  })

  it('create enqueues an upsert; undo archives + enqueues a delete (073 op-selection)', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    await useCanvasesStore.getState().load(projectId)

    const row = must(await useCanvasesStore.getState().create('Explorations'))
    expect(useSyncStore.getState().queue.entries).toContainEqual(
      expect.objectContaining({ table: 'canvases', rowId: row.id, op: 'upsert' }),
    )

    await useCommandLogStore.getState().undo()
    expect(useCanvasesStore.getState().canvases.map((c) => c.name)).toEqual(['Canvas 1'])
    expect(await listCanvases(db, projectId)).toHaveLength(1)
    const deletes = useSyncStore
      .getState()
      .queue.entries.filter((e) => e.table === 'canvases' && e.op === 'delete')
    expect(deletes.map((e) => e.rowId)).toContain(row.id)

    // redo restores + enqueues update (restore of an already-synced row)
    await useCommandLogStore.getState().redo()
    expect(useCanvasesStore.getState().canvases.map((c) => c.name)).toEqual(['Canvas 1', 'Explorations'])
    expect(useSyncStore.getState().queue.entries).toContainEqual(
      expect.objectContaining({ table: 'canvases', rowId: row.id, op: 'update' }),
    )
  })
})

describe('canvases store — rename / reorder (op update)', () => {
  it('rename updates the name and enqueues an update', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    await useCanvasesStore.getState().load(projectId)
    const only = must(useCanvasesStore.getState().canvases[0]).id

    await useCanvasesStore.getState().rename(only, 'Renamed')
    expect(useCanvasesStore.getState().canvases[0]?.name).toBe('Renamed')
    expect(useSyncStore.getState().queue.entries).toContainEqual(
      expect.objectContaining({ table: 'canvases', rowId: only, op: 'update' }),
    )

    await useCommandLogStore.getState().undo()
    expect(useCanvasesStore.getState().canvases[0]?.name).toBe('Canvas 1')
  })

  it('reorder rewrites sort and enqueues an update for every moved row', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    await useCanvasesStore.getState().load(projectId)
    const a = must(useCanvasesStore.getState().canvases[0]).id
    const b = must(await useCanvasesStore.getState().create('B')).id
    const c = must(await useCanvasesStore.getState().create('C')).id

    await useCanvasesStore.getState().reorder(c, 0)
    expect(useCanvasesStore.getState().canvases.map((x) => x.id)).toEqual([c, a, b])
    const updates = useSyncStore
      .getState()
      .queue.entries.filter((e) => e.table === 'canvases' && e.op === 'update')
    expect(updates.length).toBeGreaterThan(0)

    await useCommandLogStore.getState().undo()
    expect(useCanvasesStore.getState().canvases.map((x) => x.id)).toEqual([a, b, c])
  })
})

describe('canvases store — archive cascade + no-modal Undo (090)', () => {
  it('archive cascades dimensions/contexts/bindings, enqueues deletes, and the announced Undo restores + re-enqueues updates', async () => {
    await useCanvasesStore.getState().load(projectId)
    const c1 = must(useCanvasesStore.getState().canvases[0]).id
    const c2 = must(await useCanvasesStore.getState().create('Two')).id

    // Content that lives ON c2 — must cascade.
    const dim = await addDimension(db, projectId, 'D', c2)
    const param = await addParameter(db, dim.id, 'P')
    const ctx = await createContext(db, projectId, null, c2)
    await bindParameter(db, ctx.id, dim.id, param.id)

    // Turn sync on only now, so only the archive + undo enqueues are asserted.
    useSyncStore.setState({ workspaceId: 'ws1' })
    await useCanvasesStore.getState().archive(c2)

    // no-modal destructive idiom: status announce with an inline Undo action.
    expect(useStatusStore.getState().message).toBe('Deleted "Two"')
    expect(useStatusStore.getState().action?.label).toBe('Undo')

    // c2 + its rows are tombstoned; c1 survives and is selected.
    expect((await listCanvases(db, projectId)).map((c) => c.id)).toEqual([c1])
    expect(useCanvasesStore.getState().selectedCanvasId).toBe(c1)
    expect(await listDimensions(db, projectId, c2)).toEqual([])
    expect(await listContexts(db, projectId, c2)).toEqual([])

    const del = useSyncStore.getState().queue.entries.filter((e) => e.op === 'delete')
    expect(del).toContainEqual(expect.objectContaining({ table: 'canvases', rowId: c2 }))
    expect(del).toContainEqual(expect.objectContaining({ table: 'dimensions', rowId: dim.id }))
    expect(del).toContainEqual(expect.objectContaining({ table: 'contexts', rowId: ctx.id }))
    expect(del.filter((e) => e.table === 'bindings')).toHaveLength(1)

    // Run the announced Undo — restores the whole cascade and re-enqueues updates.
    await must(useStatusStore.getState().action).run()
    expect((await listCanvases(db, projectId)).map((c) => c.id).sort()).toEqual([c1, c2].sort())
    expect(await listDimensions(db, projectId, c2)).toHaveLength(1)

    const upd = useSyncStore.getState().queue.entries.filter((e) => e.op === 'update')
    expect(upd).toContainEqual(expect.objectContaining({ table: 'canvases', rowId: c2 }))
    expect(upd).toContainEqual(expect.objectContaining({ table: 'dimensions', rowId: dim.id }))
    expect(upd).toContainEqual(expect.objectContaining({ table: 'contexts', rowId: ctx.id }))
    expect(upd.filter((e) => e.table === 'bindings')).toHaveLength(1)
  })

  it('archiving the last root canvas is floor-guarded — announces, no delete, no command pushed', async () => {
    await useCanvasesStore.getState().load(projectId)
    const only = must(useCanvasesStore.getState().canvases[0]).id

    await useCanvasesStore.getState().archive(only)

    expect(useStatusStore.getState().message).toBe('A project needs at least one design canvas')
    expect((await listCanvases(db, projectId)).map((c) => c.id)).toEqual([only])
    expect(useCommandLogStore.getState().past).toHaveLength(0)
  })
})

describe('canvases — two canvases hold independent dimension/context sets through the store', () => {
  it('dimensions and contexts added on one canvas never leak into the other', async () => {
    await useCanvasesStore.getState().load(projectId)
    const canvas1 = must(useCanvasesStore.getState().selectedCanvasId)
    const canvas2 = must(await useCanvasesStore.getState().create('Two')).id

    // Dimensions — add through the store, scoped by canvasId.
    await useDimensionsStore.getState().load(projectId, canvas1, false)
    await useDimensionsStore.getState().add('Value')
    await useDimensionsStore.getState().load(projectId, canvas2, false)
    await useDimensionsStore.getState().add('Stake')

    await useDimensionsStore.getState().load(projectId, canvas1, false)
    expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toEqual(['Value'])
    await useDimensionsStore.getState().load(projectId, canvas2, false)
    expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toEqual(['Stake'])

    // Contexts — independent symbol namespaces (both re-use α).
    await useContextsStore.getState().load(projectId, canvas1, null)
    const a1 = must(await useContextsStore.getState().create())
    expect(a1.symbol).toBe('α')
    await useContextsStore.getState().load(projectId, canvas2, null)
    expect(useContextsStore.getState().contexts).toEqual([])
    const a2 = must(await useContextsStore.getState().create())
    expect(a2.symbol).toBe('α')

    await useContextsStore.getState().load(projectId, canvas1, null)
    expect(useContextsStore.getState().contexts.map((c) => c.symbol)).toEqual(['α'])
  })
})
