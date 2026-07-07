import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { addDimension, addParameter } from '../db/mutations'
import { createWorkspace } from '../db/workspaces'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { setDatabase } from './database'
import { resetSyncStore, useSyncStore } from './sync'
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
  resetAuthStoreForTests()
  resetSyncStore()
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

// Issue 037 — the local→cloud on-ramp's store seam.
describe('projects store — adoptProject (issue 037)', () => {
  it('moves a local project into a workspace and enqueues its rows onto the sync queue', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    const d = await addDimension(db, id)
    await addParameter(db, d.id, 'Low')
    const cloud = await createWorkspace(db, 'Cloud Workspace')

    const { project, stats, alreadyAdopted } = await useProjectsStore.getState().adoptProject(id, cloud.id)

    expect(alreadyAdopted).toBe(false)
    expect(project.id).not.toBe(id)
    expect(project.workspaceId).toBe(cloud.id)
    expect(stats.contexts).toBe(0)
    // Store re-lists — the source stays visible alongside the new copy.
    const listed = useProjectsStore.getState().projects
    expect(listed.some((p) => p.id === id)).toBe(true)
    expect(listed.some((p) => p.id === project.id)).toBe(true)

    // Every row of the new copy (project + dimension + parameter) queued for
    // the (future) write-path flush — "push through the sync/write-path".
    const queued = useSyncStore.getState().queue.entries
    expect(queued.some((e) => e.table === 'projects' && e.rowId === project.id)).toBe(true)
    expect(queued.some((e) => e.table === 'dimensions')).toBe(true)
    expect(queued.some((e) => e.table === 'parameters')).toBe(true)
    expect(queued.every((e) => e.status === 'pending')).toBe(true)
  })

  it('is idempotent: adopting twice does not double-enqueue or create a second copy', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    const cloud = await createWorkspace(db, 'Cloud Workspace')

    const first = await useProjectsStore.getState().adoptProject(id, cloud.id)
    const queueAfterFirst = useSyncStore.getState().queue.entries.length

    const second = await useProjectsStore.getState().adoptProject(id, cloud.id)

    expect(second.alreadyAdopted).toBe(true)
    expect(second.project.id).toBe(first.project.id)
    // Nothing new queued on the idempotent replay.
    expect(useSyncStore.getState().queue.entries.length).toBe(queueAfterFirst)
    expect(useProjectsStore.getState().projects.filter((p) => p.workspaceId === cloud.id)).toHaveLength(1)
  })
})

describe('projects store — listWorkspaceOptions (issue 037)', () => {
  it('throws when signed out', async () => {
    useAuthStore.setState({ configured: true, status: 'unauthenticated', user: null })
    await expect(useProjectsStore.getState().listWorkspaceOptions()).rejects.toThrow()
  })

  it('ensures a personal workspace exists and returns it', async () => {
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-x', email: null } })
    const options = await useProjectsStore.getState().listWorkspaceOptions()
    expect(options).toHaveLength(1)
    expect(options[0]?.name).toBe('My Workspace')
  })

  it('is idempotent — repeated calls return the same single workspace', async () => {
    useAuthStore.setState({ configured: true, status: 'authenticated', user: { sub: 'sub-x', email: null } })
    const first = await useProjectsStore.getState().listWorkspaceOptions()
    const second = await useProjectsStore.getState().listWorkspaceOptions()
    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id))
    expect(second).toHaveLength(1)
  })
})
