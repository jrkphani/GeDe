import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { createProject, listDimensions } from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetDimensionsStore()
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
})
