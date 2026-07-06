import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  addDimension,
  addParameter,
  bindParameter,
  createContext,
  createProject,
} from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'

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
    await useDimensionsStore.getState().load(projectId, alphaId)
    await useContextsStore.getState().load(projectId, alphaId)

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
    await useDimensionsStore.getState().load(projectId, alphaId)
    const usersDim = must(
      useDimensionsStore.getState().dimensions.find((d) => d.sourceParamId === usersId),
    )
    const inner = await addParameter(db, usersDim.id, 'Inner', usersId)
    await useContextsStore.getState().load(projectId, alphaId)
    const child = must(await useContextsStore.getState().create())
    await useContextsStore.getState().bind(child.id, usersDim.id, inner.id)

    // Parent re-binds Users → Buyers, then we re-open the child canvas.
    await bindParameter(db, alphaId, stakeId, buyersId)
    const stale = await useContextsStore.getState().openChildCanvas(alphaId)
    expect(stale).toHaveLength(1)
    const event = must(stale[0])
    expect(event.toName).toBe('Buyers')

    await useDimensionsStore.getState().load(projectId, alphaId)
    await useContextsStore.getState().load(projectId, alphaId)
    // Child dimension followed the new parameter; sub-binding retired.
    expect(useDimensionsStore.getState().dimensions.find((d) => d.id === usersDim.id)?.name).toBe('Buyers')
    expect(useContextsStore.getState().bindingsByContext[child.id]?.[usersDim.id]).toBeUndefined()

    // Banner Undo.
    await useContextsStore.getState().revertStale(event)
    await useDimensionsStore.getState().load(projectId, alphaId)
    expect(useDimensionsStore.getState().dimensions.find((d) => d.id === usersDim.id)?.name).toBe('Users')
    expect(useContextsStore.getState().bindingsByContext[child.id]?.[usersDim.id]).toBe(inner.id)
  })
})
