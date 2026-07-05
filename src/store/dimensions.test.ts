import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { createProject, listBindings, listDimensions } from '../db/mutations'
import { documentedStatus, isComplete } from '../domain/completeness'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetParametersStore, useParametersStore } from './parameters'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetDimensionsStore()
  resetContextsStore()
  resetParametersStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  await useDimensionsStore.getState().load(projectId)
})

describe('dimensions store — command log (issue 006)', () => {
  it('undo of add removes it (persisted too); redo restores the same id at the tail', async () => {
    await useDimensionsStore.getState().add()
    const id = useDimensionsStore.getState().dimensions[0]?.id as string

    await useCommandLogStore.getState().undo()
    expect(useDimensionsStore.getState().dimensions).toEqual([])
    expect(await listDimensions(db, projectId)).toEqual([])

    await useCommandLogStore.getState().redo()
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([id])
  })

  it('undo of rename restores the previous name; redo re-applies the new one', async () => {
    await useDimensionsStore.getState().add()
    const id = useDimensionsStore.getState().dimensions[0]?.id as string
    await useDimensionsStore.getState().rename(id, 'Stake')

    await useCommandLogStore.getState().undo()
    expect(useDimensionsStore.getState().dimensions[0]?.name).toBe('Dimension 1')

    await useCommandLogStore.getState().redo()
    expect(useDimensionsStore.getState().dimensions[0]?.name).toBe('Stake')
  })

  it('undo of setColor restores the previous color', async () => {
    await useDimensionsStore.getState().add()
    const id = useDimensionsStore.getState().dimensions[0]?.id as string
    const originalColor = useDimensionsStore.getState().dimensions[0]?.color as string
    await useDimensionsStore.getState().setColor(id, '#123456')

    await useCommandLogStore.getState().undo()
    expect(useDimensionsStore.getState().dimensions[0]?.color).toBe(originalColor)

    await useCommandLogStore.getState().redo()
    expect(useDimensionsStore.getState().dimensions[0]?.color).toBe('#123456')
  })

  it('undo of reorder moves it back to its original index; redo moves it again', async () => {
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    const orderedIds = useDimensionsStore.getState().dimensions.map((d) => d.id)
    const lastId = orderedIds[2] as string

    await useDimensionsStore.getState().reorder(lastId, 0)
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([
      lastId,
      orderedIds[0],
      orderedIds[1],
    ])

    await useCommandLogStore.getState().undo()
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual(orderedIds)

    await useCommandLogStore.getState().redo()
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([
      lastId,
      orderedIds[0],
      orderedIds[1],
    ])
  })

  it('undo of a middle removal restores the exact original order; redo removes it again', async () => {
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    const orderedIds = useDimensionsStore.getState().dimensions.map((d) => d.id)
    const middleId = orderedIds[1] as string

    await useDimensionsStore.getState().remove(middleId)
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([orderedIds[0], orderedIds[2]])

    await useCommandLogStore.getState().undo()
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual(orderedIds)
    expect((await listDimensions(db, projectId)).map((d) => d.sort)).toEqual([0, 1, 2])

    await useCommandLogStore.getState().redo()
    expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([orderedIds[0], orderedIds[2]])
  })

  it('a removal rejected by the n=2 floor never pushes a command', async () => {
    await useDimensionsStore.getState().add()
    await useDimensionsStore.getState().add()
    const id = useDimensionsStore.getState().dimensions[0]?.id as string
    const pastLengthBefore = useCommandLogStore.getState().past.length
    const result = await useDimensionsStore.getState().remove(id)
    expect(result.ok).toBe(false)
    expect(useCommandLogStore.getState().past).toHaveLength(pastLengthBefore)
  })

  // issue 007: removal cascades into the contexts store's bindingsByContext,
  // and undo/redo of the single command must round-trip both the dimension
  // row and every binding it cascaded away (DB + in-memory).
  describe('remove() binding cascade (issue 007)', () => {
    async function boundCanvas() {
      const value = await useDimensionsStore.getState().add()
      const stake = await useDimensionsStore.getState().add()
      const risk = await useDimensionsStore.getState().add()
      const valueId = (value as { id: string }).id
      const stakeId = (stake as { id: string }).id
      const riskId = (risk as { id: string }).id
      const comfort = await useParametersStore.getState().add(valueId, 'Comfort')
      const users = await useParametersStore.getState().add(stakeId, 'Users')
      const low = await useParametersStore.getState().add(riskId, 'Low')
      await useContextsStore.getState().load(projectId)
      const ctx = await useContextsStore.getState().create()
      const ctxId = (ctx as { id: string }).id
      await useContextsStore.getState().bind(ctxId, valueId, (comfort as { id: string }).id)
      await useContextsStore.getState().bind(ctxId, stakeId, (users as { id: string }).id)
      await useContextsStore.getState().bind(ctxId, riskId, (low as { id: string }).id)
      useCommandLogStore.getState().clear() // setup isn't part of the gesture under test
      return { valueId, stakeId, riskId, ctxId, comfortId: (comfort as { id: string }).id, lowId: (low as { id: string }).id }
    }

    it('drops the binding from bindingsByContext and the DB in one undo step; undo/redo round-trip both', async () => {
      const { stakeId, ctxId, valueId, riskId } = await boundCanvas()

      const result = await useDimensionsStore.getState().remove(stakeId)
      expect(result.ok).toBe(true)
      expect(useContextsStore.getState().bindingsByContext[ctxId]?.[stakeId]).toBeUndefined()
      expect((await listBindings(db, ctxId)).map((r) => r.dimensionId).sort()).toEqual(
        [valueId, riskId].sort(),
      )
      expect(useCommandLogStore.getState().past).toHaveLength(1)

      await useCommandLogStore.getState().undo()
      expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([
        valueId,
        stakeId,
        riskId,
      ])
      expect(useContextsStore.getState().bindingsByContext[ctxId]?.[stakeId]).toBe(
        (await listBindings(db, ctxId)).find((r) => r.dimensionId === stakeId)?.parameterId,
      )
      expect((await listBindings(db, ctxId))).toHaveLength(3)

      await useCommandLogStore.getState().redo()
      expect(useDimensionsStore.getState().dimensions.map((d) => d.id)).toEqual([valueId, riskId])
      expect(useContextsStore.getState().bindingsByContext[ctxId]?.[stakeId]).toBeUndefined()
      expect((await listBindings(db, ctxId)).map((r) => r.dimensionId).sort()).toEqual(
        [valueId, riskId].sort(),
      )
    })
  })

  // issue 007, test-first plan item 1: add-dimension demotion is emergent —
  // isComplete()/documentedStatus() (issue 004/005) always evaluate against
  // the *current* live dimension list, so a context that was documented over
  // n dimensions is automatically a draft the instant an (n+1)th is added,
  // with no separate "demote" mutation required. This proves the composition
  // holds through the real store update, not just the pure function alone.
  describe('add() demotes previously-complete contexts to draft (issue 007)', () => {
    it('a documented context becomes draft once a new dimension is added, unbound', async () => {
      const value = await useDimensionsStore.getState().add()
      const stake = await useDimensionsStore.getState().add()
      const valueId = (value as { id: string }).id
      const stakeId = (stake as { id: string }).id
      const comfort = await useParametersStore.getState().add(valueId, 'Comfort')
      const users = await useParametersStore.getState().add(stakeId, 'Users')
      await useContextsStore.getState().load(projectId)
      const ctx = await useContextsStore.getState().create()
      const ctxId = (ctx as { id: string }).id
      await useContextsStore.getState().bind(ctxId, valueId, (comfort as { id: string }).id)
      await useContextsStore.getState().bind(ctxId, stakeId, (users as { id: string }).id)
      await useContextsStore.getState().setJustification(ctxId, 'Comfort matters most to Users')

      const boundBefore = new Set(Object.keys(useContextsStore.getState().bindingsByContext[ctxId] ?? {}))
      const dimIdsBefore = useDimensionsStore.getState().dimensions.map((d) => d.id)
      expect(isComplete(dimIdsBefore, boundBefore)).toBe(true)
      const justificationBefore = useContextsStore.getState().contexts.find((c) => c.id === ctxId)
        ?.justification
      expect(documentedStatus(true, justificationBefore)).toBe('documented')

      await useDimensionsStore.getState().add()

      const dimIdsAfter = useDimensionsStore.getState().dimensions.map((d) => d.id)
      const boundAfter = new Set(Object.keys(useContextsStore.getState().bindingsByContext[ctxId] ?? {}))
      expect(dimIdsAfter).toHaveLength(3)
      expect(isComplete(dimIdsAfter, boundAfter)).toBe(false)
      expect(documentedStatus(isComplete(dimIdsAfter, boundAfter), justificationBefore)).toBe('draft')
    })
  })
})
