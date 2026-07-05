import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { createProject, getTier1Purpose, listTier1Props } from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetTier1Store, useTier1Store } from './tier1'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier1Store()
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
