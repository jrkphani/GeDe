import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { addDimension, createProject, listParameters } from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetParametersStore, useParametersStore } from './parameters'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let dimensionId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetParametersStore()
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
