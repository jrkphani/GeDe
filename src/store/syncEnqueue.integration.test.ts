import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { pendingCount } from '../domain/mutationQueue'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetParametersStore, useParametersStore } from './parameters'
import { resetProjectsStore, useProjectsStore } from './projects'
import { resetSyncStore, useSyncStore } from './sync'
import { resetTier1Store, useTier1Store } from './tier1'
import { resetTier2Store, useTier2Store } from './tier2'

// Issue 073 — the regression test that directly encodes the live e2e symptom
// this whole issue was found via: a 30s-idle diagnostic after editing content
// across every domain-content store (foundation purpose/props, architecture
// tables/entries, dimensions, parameters, contexts, bindings) saw ZERO
// `/write` calls — only the project `insert` ever reached the outbox all
// session. tier1.ts/tier2.ts/contexts.ts were wired in pt1;
// dimensions.ts/parameters.ts/projects.ts's still-unwired actions in pt2. This
// test drives ONE representative mutation through each of the 5
// domain-content stores PLUS renameProject and asserts the write queue gained
// all 6 — the cross-cutting proof that no domain-content store bypasses the
// outbox anymore.

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetProjectsStore()
  resetTier1Store()
  resetTier2Store()
  resetDimensionsStore()
  resetParametersStore()
  resetContextsStore()
  resetSyncStore()
  useCommandLogStore.getState().clear()

  await useProjectsStore.getState().init(db)
  // Created signed-out (no sync workspace yet) so this setup mutation itself
  // enqueues nothing — every entry asserted below belongs to the six
  // mutations under test.
  await useProjectsStore.getState().createProject('Tavalo')
  projectId = useProjectsStore.getState().projects[0]?.id as string

  await useTier1Store.getState().load(projectId)
  await useTier2Store.getState().load(projectId)
  await useDimensionsStore.getState().load(projectId)
  await useContextsStore.getState().load(projectId)
})

describe('sync enqueue — cross-cutting regression (issue 073)', () => {
  it('one mutation through each of the 5 domain-content stores + renameProject all reach the write outbox', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useTier1Store.getState().setPurpose('Comfort, on demand.')
    await useTier2Store.getState().addTable('Personas')
    const dimension = await useDimensionsStore.getState().add()
    const dimensionId = (dimension as { id: string }).id
    await useParametersStore.getState().add(dimensionId, 'Comfort')
    await useContextsStore.getState().create()
    await useProjectsStore.getState().renameProject(projectId, 'Renamed project')

    const queue = useSyncStore.getState().queue
    expect(pendingCount(queue)).toBe(6)
    expect(queue.entries.every((e) => e.status === 'pending')).toBe(true)
    expect(queue.entries.map((e) => e.table).sort()).toEqual(
      ['contexts', 'dimensions', 'parameters', 'projects', 'tier1_purpose', 'tier2_tables'].sort(),
    )
  })

  it('with no sync workspace set, none of the six mutations enqueue anything (local-only, byte-for-byte unchanged)', async () => {
    await useTier1Store.getState().setPurpose('Comfort, on demand.')
    await useTier2Store.getState().addTable('Personas')
    const dimension = await useDimensionsStore.getState().add()
    const dimensionId = (dimension as { id: string }).id
    await useParametersStore.getState().add(dimensionId, 'Comfort')
    await useContextsStore.getState().create()
    await useProjectsStore.getState().renameProject(projectId, 'Renamed project')

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })
})
