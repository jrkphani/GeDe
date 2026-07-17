import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  addDimension,
  addParameter,
  bindParameter,
  createContext,
  createProject,
  resolveReadCanvasId,
} from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetSyncStore, useSyncStore } from './sync'

function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`)
  return value
}

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string
let stakeId: string
let usersId: string
let buyersId: string
let alphaId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetContextsStore()
  resetDimensionsStore()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  const value = await addDimension(db, projectId)
  const stake = await addDimension(db, projectId)
  stakeId = stake.id
  const comfort = await addParameter(db, value.id, 'Comfort')
  usersId = (await addParameter(db, stake.id, 'Users')).id
  buyersId = (await addParameter(db, stake.id, 'Buyers')).id
  const alpha = await createContext(db, projectId)
  alphaId = alpha.id
  await bindParameter(db, alpha.id, value.id, comfort.id)
  await bindParameter(db, alpha.id, stake.id, usersId)
})

describe('contexts store — child canvas (issue 011)', () => {
  it('load scopes contexts to the canvas; create() makes children of the current parent', async () => {
    // Drill into α: seed + load its child canvas.
    const stale = await useContextsStore.getState().openChildCanvas(alphaId)
    expect(stale).toEqual([])
    const alphaCanvasId = must(await resolveReadCanvasId(db, projectId, alphaId), 'alpha child canvas')
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    await useContextsStore.getState().load(projectId, alphaCanvasId, alphaId)

    expect(useDimensionsStore.getState().dimensions).toHaveLength(2)
    expect(useContextsStore.getState().contexts).toEqual([]) // no children yet

    const child = must(await useContextsStore.getState().create())
    expect(child.symbol).toBe('α1')
    expect(useContextsStore.getState().contexts.map((c) => c.symbol)).toEqual(['α1'])

    // Back to root: α is unchanged and now shows a child count of 1.
    await useContextsStore.getState().load(projectId, null)
    expect(useContextsStore.getState().contexts.map((c) => c.symbol)).toEqual(['α'])
    expect(useContextsStore.getState().childCountByContext[alphaId]).toBe(1)
  })

  it('stale parent re-bind surfaces an event; revertStale restores the child dimension + sub-bindings', async () => {
    await useContextsStore.getState().openChildCanvas(alphaId)
    const alphaCanvasId = must(await resolveReadCanvasId(db, projectId, alphaId), 'alpha child canvas')
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    const usersDim = must(
      useDimensionsStore.getState().dimensions.find((d) => d.sourceParamId === usersId),
    )
    const inner = await addParameter(db, usersDim.id, 'Inner', usersId)
    await useContextsStore.getState().load(projectId, alphaCanvasId, alphaId)
    const child = must(await useContextsStore.getState().create())
    await useContextsStore.getState().bind(child.id, usersDim.id, inner.id)

    // Parent re-binds Users → Buyers, then we re-open the child canvas.
    await bindParameter(db, alphaId, stakeId, buyersId)
    const stale = await useContextsStore.getState().openChildCanvas(alphaId)
    expect(stale).toHaveLength(1)
    const event = must(stale[0])
    expect(event.toName).toBe('Buyers')

    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    await useContextsStore.getState().load(projectId, alphaCanvasId, alphaId)
    // Child dimension followed the new parameter; sub-binding retired.
    expect(useDimensionsStore.getState().dimensions.find((d) => d.id === usersDim.id)?.name).toBe('Buyers')
    expect(useContextsStore.getState().bindingsByContext[child.id]?.[usersDim.id]).toBeUndefined()

    // Banner Undo.
    await useContextsStore.getState().revertStale(event)
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    expect(useDimensionsStore.getState().dimensions.find((d) => d.id === usersDim.id)?.name).toBe('Users')
    expect(useContextsStore.getState().bindingsByContext[child.id]?.[usersDim.id]).toBe(inner.id)
  })
})

// Issue 073 pt2 — openChildCanvas seeds/reconciles child-canvas `dimensions`
// rows (and, on a stale re-bind, hard-deletes the child's own retired
// `bindings`), and revertStale's Undo reverts the child dimension's own
// sourceParamId/name back — none of that reached the write outbox before.
describe('contexts store — child canvas sync enqueue (issue 073 pt2)', () => {
  it('openChildCanvas enqueues a dimensions upsert for every newly seeded child dimension', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useContextsStore.getState().openChildCanvas(alphaId)
    const alphaCanvasId = must(await resolveReadCanvasId(db, projectId, alphaId), 'alpha child canvas')
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    const childIds = useDimensionsStore.getState().dimensions.map((d) => d.id)
    expect(childIds).toHaveLength(2)

    const queued = useSyncStore.getState().queue.entries
    expect(queued.filter((e) => e.table === 'dimensions' && e.op === 'upsert')).toHaveLength(2)
    expect(queued.map((e) => e.rowId).sort()).toEqual([...childIds].sort())
  })

  it('a re-open with nothing changed enqueues nothing (idempotent reconcile)', async () => {
    await useContextsStore.getState().openChildCanvas(alphaId)
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useContextsStore.getState().openChildCanvas(alphaId)

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  it('a stale parent re-bind enqueues a dimensions update + a bindings delete for the retired sub-binding', async () => {
    await useContextsStore.getState().openChildCanvas(alphaId)
    const alphaCanvasId = must(await resolveReadCanvasId(db, projectId, alphaId), 'alpha child canvas')
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    const usersDim = must(
      useDimensionsStore.getState().dimensions.find((d) => d.sourceParamId === usersId),
    )
    const inner = await addParameter(db, usersDim.id, 'Inner', usersId)
    await useContextsStore.getState().load(projectId, alphaCanvasId, alphaId)
    const child = must(await useContextsStore.getState().create())
    await useContextsStore.getState().bind(child.id, usersDim.id, inner.id)

    // Parent re-binds Users → Buyers, then we re-open the child canvas.
    await bindParameter(db, alphaId, stakeId, buyersId)
    useSyncStore.setState({ workspaceId: 'ws1' })

    const stale = await useContextsStore.getState().openChildCanvas(alphaId)
    expect(stale).toHaveLength(1)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toContainEqual(
      expect.objectContaining({ table: 'dimensions', rowId: usersDim.id, op: 'update' }),
    )
    const bindingDeletes = queued.filter((e) => e.table === 'bindings' && e.op === 'delete')
    expect(bindingDeletes).toHaveLength(1)
  })

  it('revertStale enqueues an update for the reverted dimensions row + an update for each restored binding', async () => {
    await useContextsStore.getState().openChildCanvas(alphaId)
    const alphaCanvasId = must(await resolveReadCanvasId(db, projectId, alphaId), 'alpha child canvas')
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    const usersDim = must(
      useDimensionsStore.getState().dimensions.find((d) => d.sourceParamId === usersId),
    )
    const inner = await addParameter(db, usersDim.id, 'Inner', usersId)
    await useContextsStore.getState().load(projectId, alphaCanvasId, alphaId)
    const child = must(await useContextsStore.getState().create())
    await useContextsStore.getState().bind(child.id, usersDim.id, inner.id)

    await bindParameter(db, alphaId, stakeId, buyersId)
    const stale = await useContextsStore.getState().openChildCanvas(alphaId)
    const event = must(stale[0])
    await useDimensionsStore.getState().load(projectId, alphaCanvasId, true)
    await useContextsStore.getState().load(projectId, alphaCanvasId, alphaId)

    useSyncStore.setState({ workspaceId: 'ws1' })
    await useContextsStore.getState().revertStale(event)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toContainEqual(
      expect.objectContaining({ table: 'dimensions', rowId: usersDim.id, op: 'update' }),
    )
    const bindingUpdates = queued.filter((e) => e.table === 'bindings' && e.op === 'update')
    expect(bindingUpdates).toHaveLength(1)
    expect(bindingUpdates[0]?.rowId).toBe(event.retiredBindings[0]?.id)
  })
})
