import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import { listProjects } from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { resetProjectsStore, useProjectsStore } from './projects'
import { resetSyncStore, useSyncStore } from './sync'
import type { ShapeStreamFactory, ShapeStreamLike } from '../sync/syncEngine'
import type { ElectricMessage } from '../sync/electricProtocol'
import { SYNCED_TABLES } from '../sync/config'

let db: Awaited<ReturnType<typeof openDatabase>>['db']

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  resetProjectsStore()
  resetSyncStore()
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

// Issue 069 — createProject's bespoke optimistic prepend was the only store
// mutation that wasn't re-entrancy-safe: two overlapping calls each ran their
// own dbCreate insert, landing two distinct uuidv7 rows for the same name
// (verified empirically in the issue's standalone PGlite harness). Every
// sibling mutation re-reads via dbList; createProject must additionally not
// let two concurrent calls both reach dbCreate at all, or the DB itself ends
// up with two real rows no re-read can undo.
describe('createProject re-entrancy safety (issue 069)', () => {
  it('two concurrent createProject calls for the same input do not produce two projects', async () => {
    await Promise.all([
      useProjectsStore.getState().createProject('Tavalo'),
      useProjectsStore.getState().createProject('Tavalo'),
    ])
    expect(useProjectsStore.getState().projects).toHaveLength(1)
    expect(await listProjects(db)).toHaveLength(1)
  })
})

// Issue 070 (fixes #9) — archiving is a durable soft-delete, but nothing ever
// surfaced archived rows beyond the single-slot, session-scoped command-log
// undo. These prove a second, durable read/restore path: archivedProjects +
// loadArchivedProjects() + restoreArchivedProject(), independent of the undo
// stack and of process/store re-init.
describe('archived projects (issue 070)', () => {
  it('archiving two projects then restoring the OLDER one succeeds and leaves the newer archived', async () => {
    await useProjectsStore.getState().createProject('A')
    await useProjectsStore.getState().createProject('B')
    const idA = useProjectsStore.getState().projects.find((p) => p.name === 'A')?.id as string
    const idB = useProjectsStore.getState().projects.find((p) => p.name === 'B')?.id as string

    await useProjectsStore.getState().archiveProject(idA)
    await useProjectsStore.getState().archiveProject(idB)
    await useProjectsStore.getState().loadArchivedProjects()
    expect(
      useProjectsStore
        .getState()
        .archivedProjects.map((p) => p.id)
        .sort(),
    ).toEqual([idA, idB].sort())

    await useProjectsStore.getState().restoreArchivedProject(idA)

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([idA])
    expect(useProjectsStore.getState().archivedProjects.map((p) => p.id)).toEqual([idB])
  })

  it('restoring an archived project is undoable via the command log (undo re-archives it)', async () => {
    await useProjectsStore.getState().createProject('A')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await useProjectsStore.getState().archiveProject(id)
    await useProjectsStore.getState().loadArchivedProjects()

    await useProjectsStore.getState().restoreArchivedProject(id)
    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([id])
    expect(useProjectsStore.getState().archivedProjects).toEqual([])

    await useCommandLogStore.getState().undo()
    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().archivedProjects.map((p) => p.id)).toEqual([id])

    await useCommandLogStore.getState().redo()
    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([id])
    expect(useProjectsStore.getState().archivedProjects).toEqual([])
  })

  it('the archived list survives a store re-init (persisted, not session state)', async () => {
    await useProjectsStore.getState().createProject('A')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await useProjectsStore.getState().archiveProject(id)
    await useProjectsStore.getState().loadArchivedProjects()
    expect(useProjectsStore.getState().archivedProjects).toHaveLength(1)

    resetProjectsStore()
    await useProjectsStore.getState().init(db)
    expect(useProjectsStore.getState().archivedProjects).toEqual([])

    await useProjectsStore.getState().loadArchivedProjects()
    expect(useProjectsStore.getState().archivedProjects.map((p) => p.id)).toEqual([id])
  })
})

// Issue 073 pt2 — renameProject/archiveProject/restoreArchivedProject were the
// still-unwired projects.ts actions (createProject/adoptProject were already
// wired, issue 050/037): they wrote to local PGlite + the command log but
// never enqueued to the write outbox. importProject's whole-tree enqueue is
// covered separately in projectImportExport.test.ts, alongside its sibling
// adoptProject test.
describe('projects store — sync enqueue (issue 073 pt2)', () => {
  it('renameProject enqueues a projects update', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useProjectsStore.getState().renameProject(id, 'New name')

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ table: 'projects', rowId: id, op: 'update', status: 'pending' })
  })

  it('archiveProject enqueues a projects delete', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useProjectsStore.getState().archiveProject(id)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ table: 'projects', rowId: id, op: 'delete', status: 'pending' })
  })

  it('restoreArchivedProject enqueues a projects revive carrying deletedAt: null', async () => {
    await useProjectsStore.getState().createProject('Tavalo')
    const id = useProjectsStore.getState().projects[0]?.id as string
    await useProjectsStore.getState().archiveProject(id)
    resetSyncStore()
    useSyncStore.setState({ workspaceId: 'ws1' })

    await useProjectsStore.getState().restoreArchivedProject(id)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    // Issue 094 — un-tombstoning a soft-deleted row is a 'revive', not 'update'
    // (a plain 'update' can't clear deleted_at server-side; the 070 cloud bug).
    expect(queued[0]).toMatchObject({ table: 'projects', rowId: id, op: 'revive', status: 'pending' })
    expect((queued[0]?.row as { deletedAt: string | null }).deletedAt).toBeNull()
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
    const startSpy = vi.spyOn(useSyncStore.getState(), 'start').mockImplementation((database, options) => {
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

    // Issue 072 fix (test hygiene) — resetSyncStore()'s own setState merge
    // preserves whatever the `start` property currently holds (it isn't part
    // of the reset payload), so an un-restored spy here silently survives
    // into every later test in this file, hijacking their own real start()
    // calls with THIS test's closure-captured `factory`/`realStart`. Mirrors
    // auth.test.ts/contexts.test.ts's own explicit mockRestore() convention.
    startSpy.mockRestore()
  })
})

// Issue 072 (Defect 2) — `refreshProjects` snapshots `dbList(db)` once
// BEFORE the read-path engine streams anything (068's restart-safety
// design), so even a successfully-applied, late-arriving `projects` delta
// never re-rendered the list without a manual refresh. The projects store
// must instead re-list itself off its OWN ground-truth signal
// (`useSyncStore`'s `projectsAppliedAt`, bumped in onApplied — see
// store/sync.test.ts) rather than trusting global sync status, mirroring how
// 062/067 refresh PendingInvitations/Members off their own per-table signal.
describe('projects store — re-lists on an inbound projects delta (issue 072)', () => {
  afterEach(() => {
    resetSyncStore()
    vi.unstubAllEnvs()
  })

  it('a projects row that streams in AFTER the initial dbList snapshot becomes visible without a manual refreshProjects()', async () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'true')
    expect(useProjectsStore.getState().projects).toEqual([])

    const box: { deliver: ((messages: readonly ElectricMessage[]) => void) | null } = { deliver: null }
    const factory: ShapeStreamFactory = (table): ShapeStreamLike => ({
      subscribe: (callback) => {
        if (table === 'projects') box.deliver = (messages) => void callback(messages)
        return () => {
          box.deliver = null
        }
      },
    })
    // Simulates the read-path engine (re)starting mid-session, exactly as
    // init()/refreshProjects() do in production — the initial dbList
    // snapshot (beforeEach's init(db) above) has already settled with an
    // empty list before this delta streams in.
    useSyncStore.getState().start(db, { streamFactory: factory })

    box.deliver?.([
      {
        key: '"public"."projects"/"p1"',
        value: {
          id: 'p1',
          workspace_id: 'ws-unseen',
          name: 'Streamed In',
          description: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:01.000Z',
          deleted_at: null,
        },
        headers: { operation: 'insert' },
      },
    ])
    // Poll rather than a single fixed setTimeout(0): the delta must flush
    // THROUGH two chained async hops — applyInboundDeltas' own transaction,
    // then the projects store's own follow-up dbList() re-read triggered by
    // its projectsAppliedAt subscription — each a real PGlite round trip, not
    // a single microtask (bounded so a genuine regression still fails fast).
    for (let i = 0; i < 20 && !useProjectsStore.getState().projects.some((p) => p.name === 'Streamed In'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(useProjectsStore.getState().projects.map((p) => p.name)).toContain('Streamed In')
  })
})
