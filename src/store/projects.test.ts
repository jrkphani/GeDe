import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { listProjects } from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { resetProjectsStore, useProjectsStore } from './projects'

let db: Awaited<ReturnType<typeof openDatabase>>['db']

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  resetProjectsStore()
  await useProjectsStore.getState().init(db)
  useCommandLogStore.getState().clear()
})

describe('projects store — command log (issue 006)', () => {
  it('undo of createProject archives it (in-memory and persisted); redo restores it', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string

    await useCommandLogStore.getState().undo()
    expect(useProjectsStore.getState().projects).toEqual([])
    expect(await listProjects(db)).toEqual([])

    await useCommandLogStore.getState().redo()
    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([id])
    expect((await listProjects(db)).map((p) => p.id)).toEqual([id])
  })

  it('undo of renameProject restores the previous name; redo re-applies the new one', async () => {
    await useProjectsStore.getState().createProject('Old name')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await useProjectsStore.getState().renameProject(id, 'New name')

    await useCommandLogStore.getState().undo()
    expect(useProjectsStore.getState().projects[0]?.name).toBe('Old name')
    expect((await listProjects(db))[0]?.name).toBe('Old name')

    await useCommandLogStore.getState().redo()
    expect(useProjectsStore.getState().projects[0]?.name).toBe('New name')
  })

  it('undo of archiveProject restores it; redo archives it again', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await useProjectsStore.getState().archiveProject(id)
    expect(useProjectsStore.getState().projects).toEqual([])

    await useCommandLogStore.getState().undo()
    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([id])

    await useCommandLogStore.getState().redo()
    expect(useProjectsStore.getState().projects).toEqual([])
    expect(await listProjects(db)).toEqual([])
  })

  it('undoing N actions then redoing N reaches the same end state (deep-equal ids)', async () => {
    await useProjectsStore.getState().createProject('A')
    await useProjectsStore.getState().createProject('B')
    const idA = useProjectsStore.getState().projects.find((p) => p.name === 'A')?.id as string
    await useProjectsStore.getState().renameProject(idA, 'A renamed')
    const finalIds = useProjectsStore
      .getState()
      .projects.map((p) => p.id)
      .sort()

    await useCommandLogStore.getState().undo()
    await useCommandLogStore.getState().undo()
    await useCommandLogStore.getState().undo()
    expect(useProjectsStore.getState().projects).toEqual([])

    await useCommandLogStore.getState().redo()
    await useCommandLogStore.getState().redo()
    await useCommandLogStore.getState().redo()
    expect(
      useProjectsStore
        .getState()
        .projects.map((p) => p.id)
        .sort(),
    ).toEqual(finalIds)
    expect(useProjectsStore.getState().projects.find((p) => p.id === idA)?.name).toBe('A renamed')
  })
})
