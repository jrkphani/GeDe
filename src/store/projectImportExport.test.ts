import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { addDimension, addParameter } from '../db/mutations'
import { setDatabase } from './database'
import { useProjectsStore, resetProjectsStore } from './projects'
import {
  CorruptedEnvelopeError,
  NewerVersionError,
  NotGeDeExportError,
  parseEnvelope,
} from '../domain/projectEnvelope'

let db: Awaited<ReturnType<typeof openDatabase>>['db']

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  resetProjectsStore()
  await useProjectsStore.getState().init(db)
  setDatabase(db)
})

describe('projects store — export/import (issue 015)', () => {
  it('exportProject returns a named, parseable envelope', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    const d = await addDimension(db, id)
    await addParameter(db, d.id, 'Low')

    const { name, json } = await useProjectsStore.getState().exportProject(id)
    expect(name).toBe('Tavalo')
    const envelope = parseEnvelope(json)
    expect(envelope.tables.projects[0]?.name).toBe('Tavalo')
    expect(envelope.tables.dimensions).toHaveLength(1)
  })

  it('importProject adds a new project and reports stats', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await addDimension(db, id)
    const { json } = await useProjectsStore.getState().exportProject(id)

    const { project, stats } = await useProjectsStore.getState().importProject(json)
    expect(project.id).not.toBe(id)
    expect(project.name).toBe('Tavalo')
    expect(stats.contexts).toBe(0)
    // Both original and clone are in the store now.
    expect(useProjectsStore.getState().projects.filter((p) => p.name === 'Tavalo')).toHaveLength(2)
  })

  it('rejects wrong / newer / corrupt files with typed errors, importing nothing', async () => {
    await expect(useProjectsStore.getState().importProject('nonsense')).rejects.toThrow(
      NotGeDeExportError,
    )
    await expect(
      useProjectsStore.getState().importProject('{"formatVersion":99,"tables":{}}'),
    ).rejects.toThrow(NewerVersionError)
    await expect(
      useProjectsStore.getState().importProject('{"formatVersion":1,"tables":{}}'),
    ).rejects.toThrow(CorruptedEnvelopeError)
    expect(useProjectsStore.getState().projects).toHaveLength(0)
  })
})
