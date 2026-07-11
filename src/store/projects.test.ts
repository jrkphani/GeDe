import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import { listProjects } from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { resetProjectsStore, useProjectsStore } from './projects'
import { resetSyncStore, useSyncStore } from './sync'
import type { ShapeStreamFactory, ShapeStreamLike } from '../sync/syncEngine'
import { SYNCED_TABLES } from '../sync/config'

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

// Issue 068 (Bonus trap) — refreshProjects()'s own read-path restart used to
// be gated `if (sync.enabled)`, but 063's resetSyncStore() (the sign-out
// path) sets `enabled: false` — so calling refreshProjects() from the NEW
// signIn()/hydrate() rehydration (068, Defect A) would re-list an (empty)
// snapshot and never actually restart the engine. sync.start()/stop() are
// internally safe to call unconditionally (their own guards are env/config
// based, src/store/sync.ts's own doc comment) — the gate here must be
// loosened, not just given a new caller.
describe('refreshProjects restarts sync even after a prior sign-out reset (issue 068)', () => {
  afterEach(() => {
    resetSyncStore()
    vi.unstubAllEnvs()
  })

  it('calls sync.start() (and its injected streamFactory fires again) even though sync.enabled was left false by a prior reset', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    let factoryCalls = 0
    const factory: ShapeStreamFactory = (): ShapeStreamLike => {
      factoryCalls++
      return { subscribe: () => () => {} }
    }
    // Intercept every sync.start() call so it always carries this
    // test-injected streamFactory — production refreshProjects() itself
    // calls sync.start(db) with no options at all (068's fix relies on
    // sync.ts defaulting getAuthToken internally, out of scope for this
    // store-level test) — this proves the call actually reaches
    // startSync/ShapeStream by counting the factory firing, not just that a
    // JS method got invoked.
    const realStart = useSyncStore.getState().start
    vi.spyOn(useSyncStore.getState(), 'start').mockImplementation((database, options) => {
      realStart(database, { ...options, streamFactory: factory })
    })

    // First start (mirrors init()) establishes the engine — one factory
    // call per synced table (startSync subscribes one shape per table).
    useSyncStore.getState().start(db)
    expect(useSyncStore.getState().enabled).toBe(true)
    expect(factoryCalls).toBe(SYNCED_TABLES.length)

    // A sign-out resets it back to disabled, exactly like resetSyncStore()
    // (063) does — simulating the post-sign-out state a subsequent sign-in's
    // refreshProjects() call must recover from.
    resetSyncStore()
    expect(useSyncStore.getState().enabled).toBe(false)

    await useProjectsStore.getState().refreshProjects()

    expect(useSyncStore.getState().enabled).toBe(true)
    expect(factoryCalls).toBe(SYNCED_TABLES.length * 2)
  })
})
