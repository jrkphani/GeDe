import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import {
  addTier2Entry,
  addTier2Table,
  createProject,
  listParameters,
  listParametersBySourceEntries,
  listTier2Entries,
} from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetParametersStore, useParametersStore } from './parameters'
import { resetSyncStore, useSyncStore } from './sync'
import { useStatusStore } from './status'
import { resetTier2Store, useTier2Store } from './tier2'

// Test helper: the store's create actions return `| null` only when no project
// is loaded (never in these tests). Narrow without a non-null assertion.
function nn<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a non-null value')
  return value
}

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetTier2Store()
  resetDimensionsStore()
  resetParametersStore()
  resetSyncStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  await useTier2Store.getState().load(projectId)
})

function tables() {
  return useTier2Store.getState().tables
}
function entriesOf(tableId: string) {
  return useTier2Store.getState().entriesByTable[tableId] ?? []
}

describe('tier2 store — tables & entries', () => {
  it('addTable persists and is one undo step', async () => {
    await useTier2Store.getState().addTable('Stakeholders')
    expect(tables().map((t) => t.name)).toEqual(['Stakeholders'])

    await useCommandLogStore.getState().undo()
    expect(tables()).toEqual([])
    await useCommandLogStore.getState().redo()
    expect(tables().map((t) => t.name)).toEqual(['Stakeholders'])
  })

  it('addEntry nests via parentId', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    await useTier2Store.getState().addEntry(table.id, buyers.id, 'Superstars')
    const entries = entriesOf(table.id)
    expect(entries.map((e) => e.name).sort()).toEqual(['Buyers', 'Superstars'])
    expect(entries.find((e) => e.name === 'Superstars')?.parentId).toBe(buyers.id)
  })
})

// Issue 083 — Cause B. Every add call site (ArchitectureSurface.tsx's
// `void addTable(name)` / `void addEntry(...)`) discards the promise: a
// rejection inside the store action (addTier2Table/addTier2Entry resolving
// their workspaceId via `firstOrThrow`, src/db/util.ts:8, which hard-throws
// on a missing FK-ancestor row) was previously silently swallowed —
// indistinguishable from a no-op. The store action itself must catch and
// announce via useStatusStore (the app's one sanctioned feedback channel),
// never let the rejection escape into a fire-and-forget `void` unheard.
describe('tier2 store — a failed add announces via useStatusStore, never a silent no-op (issue 083 Cause B)', () => {
  beforeEach(() => {
    useStatusStore.setState({ message: null, action: null })
  })

  it('addTable announces a calm status message when the underlying mutation rejects, and does not throw', async () => {
    // A projectId the `projects` table has no row for — dbAddTable's own
    // projectWorkspaceId() (src/db/mutations.ts:38-44) hard-throws
    // "project not found" via firstOrThrow, exactly the FK/NOT-NULL-style
    // rejection the issue diagnoses. The store's own null-projectId guard
    // only screens out `null`, so this reaches the real mutation call.
    useTier2Store.setState({ projectId: 'does-not-exist' })

    await expect(useTier2Store.getState().addTable('Stakeholders')).resolves.toBeNull()

    expect(useStatusStore.getState().message).not.toBeNull()
    expect(useStatusStore.getState().message).toMatch(/could not|failed|couldn.t/i)
  })

  it('addTable returns null (not a thrown rejection) when the mutation fails', async () => {
    useTier2Store.setState({ projectId: 'does-not-exist' })

    const result = await useTier2Store.getState().addTable('Stakeholders')

    expect(result).toBeNull()
  })

  it('a failed addTable never pushes a command-log entry (nothing to undo)', async () => {
    useTier2Store.setState({ projectId: 'does-not-exist' })
    const before = useCommandLogStore.getState().past.length

    await useTier2Store.getState().addTable('Stakeholders')

    expect(useCommandLogStore.getState().past.length).toBe(before)
  })

  it('addEntry announces a calm status message when the underlying mutation rejects (bogus tableId), and does not throw', async () => {
    await expect(useTier2Store.getState().addEntry('does-not-exist', null, 'Buyers')).resolves.toBeNull()

    expect(useStatusStore.getState().message).not.toBeNull()
  })

  it('addEntry returns null when the mutation fails', async () => {
    const result = await useTier2Store.getState().addEntry('does-not-exist', null, 'Buyers')
    expect(result).toBeNull()
  })

  it('a successful addTable announces nothing (the table appearing is itself the confirmation)', async () => {
    await useTier2Store.getState().addTable('Stakeholders')
    expect(useStatusStore.getState().message).toBeNull()
  })
})

describe('tier2 store — promote (one undo step, invariant 7)', () => {
  it('promote creates a dimension + parameters and undoes/redoes as a single step', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))

    const outcome = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id, users.id], target: { kind: 'new', name: 'Stake' } })
    expect(await listParameters(db, outcome.dimensionId)).toHaveLength(2)

    // One undo step removes both the dimension and its parameters.
    await useCommandLogStore.getState().undo()
    expect(await listParameters(db, outcome.dimensionId)).toHaveLength(0)

    await useCommandLogStore.getState().redo()
    expect(await listParameters(db, outcome.dimensionId)).toHaveLength(2)
  })

  // Issue 089 D2 — in the co-mount model the Design lane is already mounted and
  // its projectId-keyed load effect never re-fires on this sibling Architecture
  // lane's promote. So promote must refresh useDimensionsStore itself (via the
  // local-apply signal) — the promoted dimension appears in the Design store
  // for its CURRENT canvas (090), with no remount and no reload.
  it('promote refreshes useDimensionsStore for the current canvas (no remount)', async () => {
    // The Design lane loaded its (empty) root canvas at co-mount time.
    await useDimensionsStore.getState().load(projectId)
    expect(useDimensionsStore.getState().dimensions).toHaveLength(0)

    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id], target: { kind: 'new', name: 'Stake' } })

    // The 075B subscription re-reads asynchronously off the bumped signal.
    await vi.waitFor(() => {
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toContain('Stake')
    })
    // Scoped to the canvas the Design store currently has loaded (090 root),
    // not a hardcoded root — the dimension landed on that same canvas.
    expect(useDimensionsStore.getState().canvasId).not.toBeNull()
  })

  it('re-promote extends without duplicating already-linked entries', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const first = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id], target: { kind: 'new', name: 'Stake' } })
    const second = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id], target: { kind: 'existing', dimensionId: first.dimensionId } })
    expect(second.createdParameters).toHaveLength(0)
    expect(await listParameters(db, first.dimensionId)).toHaveLength(1)
  })

  it('linkByEntryId reflects the promoted entry for the source badge', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })
    expect(useTier2Store.getState().linkByEntryId[users.id]?.dimensionName).toBe('Stake')
  })
})

describe('tier2 store — rename propagation (invariant 7)', () => {
  it('renaming a linked entry renames its parameter and reports the count', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const outcome = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    const count = await useTier2Store.getState().renameEntry(table.id, users.id, 'People')
    expect(count).toBe(1)
    expect((await listParameters(db, outcome.dimensionId))[0]?.name).toBe('People')

    // One undo reverts both the entry and the parameter name.
    await useCommandLogStore.getState().undo()
    expect((await listParameters(db, outcome.dimensionId))[0]?.name).toBe('Users')
    expect(entriesOf(table.id).find((e) => e.id === users.id)?.name).toBe('Users')
  })
})

describe('tier2 store — delete with linked parameter surfaces a typed resolution', () => {
  it('removeEntry on an unlinked entry deletes it directly', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const result = await useTier2Store.getState().removeEntry(table.id, buyers.id)
    expect(result.kind).toBe('removed')
    expect(entriesOf(table.id)).toEqual([])
  })

  it('removeEntry on a linked entry returns needs-resolution and does NOT delete', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    const result = await useTier2Store.getState().removeEntry(table.id, users.id)
    expect(result.kind).toBe('needs-resolution')
    if (result.kind === 'needs-resolution') {
      expect(result.links).toHaveLength(1)
      expect(result.links[0]?.parameterName).toBe('Users')
    }
    // Nothing deleted yet — resolution is required first (no silent cascade).
    expect(entriesOf(table.id).map((e) => e.name)).toEqual(['Users'])
  })

  it('resolveKeep deletes the entry but keeps the parameter unlinked (no orphan)', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const { dimensionId } = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    await useTier2Store.getState().resolveKeep(table.id, users.id)
    expect(entriesOf(table.id)).toEqual([])
    const params = await listParameters(db, dimensionId)
    expect(params).toHaveLength(1)
    expect(params[0]?.sourceEntryId).toBeNull()
    expect(await listParametersBySourceEntries(db, [users.id])).toHaveLength(0)
  })

  it('resolveDeleteParams deletes both the entry and its parameter', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const { dimensionId } = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    await useTier2Store.getState().resolveDeleteParams(table.id, users.id)
    expect(entriesOf(table.id)).toEqual([])
    expect(await listParameters(db, dimensionId)).toHaveLength(0)
    expect(await listTier2Entries(db, table.id)).toEqual([])
  })
})

// Issue 073 pt1 — tier2's mutating actions never reached the write outbox.
// Mirrors tier1.test.ts's own "sync enqueue" describe block: seed a sync
// workspace, assert the shared enqueueIfSyncing() helper (src/store/sync.ts)
// queues the right (table, rowId, op).
describe('tier2 store — sync enqueue (issue 073 pt1)', () => {
  it('addTable enqueues a tier2_tables upsert', async () => {
    useSyncStore.setState({ workspaceId: 'ws1' })
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'tier2_tables',
      rowId: table.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('addEntry enqueues a tier2_entries upsert', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    useSyncStore.setState({ workspaceId: 'ws1' })
    const entry = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'tier2_entries',
      rowId: entry.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('promote enqueues an upsert for the created dimension and every created parameter row', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    useSyncStore.setState({ workspaceId: 'ws1' })

    const outcome = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id, users.id], target: { kind: 'new', name: 'Stake' } })

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(3) // 1 created dimension + 2 created parameters
    expect(queued.filter((e) => e.table === 'dimensions' && e.op === 'upsert')).toHaveLength(1)
    expect(queued.find((e) => e.table === 'dimensions')?.rowId).toBe(outcome.dimensionId)
    const paramEntries = queued.filter((e) => e.table === 'parameters' && e.op === 'upsert')
    expect(paramEntries).toHaveLength(2)
    expect(paramEntries.map((e) => e.rowId).sort()).toEqual(
      outcome.createdParameters.map((p) => p.id).sort(),
    )
  })
})

// Issue 075 Part B — tier2.ts was one of the read-path stores with no delta
// subscription: load() ran once per project-open and never re-read PGlite
// afterward. Mirrors 072's projects.ts refresh wiring, scoped to this store's
// combined table signal (src/store/sync.ts's tier2AppliedAt, bumped for
// EITHER tier2_tables or tier2_entries).
describe('tier2 store — refresh on inbound delta (issue 075 Part B)', () => {
  it('a table row written directly to PGlite after load() appears once the tier2 signal bumps', async () => {
    expect(useTier2Store.getState().tables).toEqual([])

    // Simulate a delta landing directly in local PGlite — bypasses the store
    // entirely, exactly like 075A's apply path (src/db/sync.ts) would.
    const streamedIn = await addTier2Table(db, projectId, 'Streamed In')
    expect(useTier2Store.getState().tables.some((t) => t.id === streamedIn.id)).toBe(false)

    useSyncStore.setState({ tier2AppliedAt: Date.now() })

    for (
      let i = 0;
      i < 20 && !useTier2Store.getState().tables.some((t) => t.id === streamedIn.id);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(useTier2Store.getState().tables.map((t) => t.id)).toContain(streamedIn.id)
  })

  it('an entry row written directly to PGlite after load() appears once the tier2 signal bumps', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    expect(useTier2Store.getState().entriesByTable[table.id]).toEqual([])

    const streamedIn = await addTier2Entry(db, table.id, null, 'Streamed In')
    expect(
      useTier2Store.getState().entriesByTable[table.id]?.some((e) => e.id === streamedIn.id),
    ).toBe(false)

    useSyncStore.setState({ tier2AppliedAt: Date.now() })

    for (
      let i = 0;
      i < 20 &&
      !useTier2Store.getState().entriesByTable[table.id]?.some((e) => e.id === streamedIn.id);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(useTier2Store.getState().entriesByTable[table.id]?.map((e) => e.id)).toContain(streamedIn.id)
  })
})

// Issue 092 — 089 D2 fixed the FORWARD cross-tier paths (promote /
// rename-propagate / resolve) to wake the co-mounted Design lane via
// notifyLocalApply, but the undo/redo command-log closures of those same ops
// were left untouched: undoing/redoing a cross-tier write writes to PGlite but
// never bumps the *AppliedAt signals, so the already-mounted Design lane stays
// stale until a reload. These mirror the forward-path assertion style (the
// 089 D2 "promote refreshes useDimensionsStore" test above), asserting the
// register re-reads for its CURRENT canvas/dimension with no remount.
describe('tier2 store — undo/redo of a cross-tier op refreshes the co-mounted sibling lane (issue 092)', () => {
  it('undo AND redo of a promote refresh useDimensionsStore for the current canvas (no remount)', async () => {
    // The Design lane loaded its (empty) root canvas at co-mount time.
    await useDimensionsStore.getState().load(projectId)
    expect(useDimensionsStore.getState().dimensions).toHaveLength(0)

    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const buyers = nn(await useTier2Store.getState().addEntry(table.id, null, 'Buyers'))
    await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [buyers.id], target: { kind: 'new', name: 'Stake' } })

    // Forward path (089 D2) already refreshes.
    await vi.waitFor(() => {
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toContain('Stake')
    })

    // Undo of the promote must ALSO wake the co-mounted Design lane (092): the
    // dimension drops out of the register live, without a reload.
    await useCommandLogStore.getState().undo()
    await vi.waitFor(() => {
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).not.toContain('Stake')
    })

    // Redo restores it live too.
    await useCommandLogStore.getState().redo()
    await vi.waitFor(() => {
      expect(useDimensionsStore.getState().dimensions.map((d) => d.name)).toContain('Stake')
    })
  })

  it('undo of a resolveDeleteParams refreshes useParametersStore for the current dimension (no remount)', async () => {
    const table = nn(await useTier2Store.getState().addTable('Stakeholders'))
    const users = nn(await useTier2Store.getState().addEntry(table.id, null, 'Users'))
    const { dimensionId } = await useTier2Store
      .getState()
      .promote({ projectId, entryIds: [users.id], target: { kind: 'new', name: 'Stake' } })

    // The Design lane's ContextRegister loaded this dimension's parameters.
    await useParametersStore.getState().load(dimensionId)
    expect(useParametersStore.getState().byDimension[dimensionId]).toHaveLength(1)

    // Forward path (089 D2) already refreshes the parameter out of the register.
    await useTier2Store.getState().resolveDeleteParams(table.id, users.id)
    await vi.waitFor(() => {
      expect(useParametersStore.getState().byDimension[dimensionId] ?? []).toHaveLength(0)
    })

    // Undo restores the parameter — the co-mounted Design lane's register must
    // reflect it live (092), no remount.
    await useCommandLogStore.getState().undo()
    await vi.waitFor(() => {
      expect(useParametersStore.getState().byDimension[dimensionId] ?? []).toHaveLength(1)
    })
  })
})
