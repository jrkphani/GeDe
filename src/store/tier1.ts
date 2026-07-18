import { create } from 'zustand'
import {
  addTier1Prop as dbAdd,
  getTier1Purpose as dbGetPurpose,
  listTier1Props as dbList,
  removeTier1Prop as dbRemove,
  renameTier1Prop as dbRename,
  reorderTier1Prop as dbReorder,
  restoreTier1Prop as dbRestore,
  setTier1ExistingScenario as dbSetExistingScenario,
  setTier1PropDescription as dbSetDescription,
  setTier1Purpose as dbSetPurpose,
  type Tier1PropRow,
} from '../db/mutations'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { enqueueIfSyncing, useSyncStore } from './sync'
import { useStatusStore } from './status'

// Issue 075 Part B — the `useSyncStore.tier1AppliedAt` subscription below
// (mirrors src/store/projects.ts's own module-level syncUnsubscribe pattern,
// 072): re-`load()` re-subscribes rather than accumulating a duplicate
// listener per project-open.
let syncUnsubscribe: (() => void) | null = null

// Issue 073 Subtlety B / 094 — the sibling re-rank cascade: tier1 props carry
// BOTH `sort` and a 1-based `rank` (rank === index + 1). Enqueue an 'update' for
// every prop PRESENT in `before` whose position actually moved. The ONE cascade
// the forward reorder/remove paths AND their undo/redo reversals (094) both
// call, so the two can never drift. A row ABSENT from `before` is SKIPPED, not
// treated as moved — the only such row is the principal a undo revives, whose
// revive the closure enqueues explicitly (mirrors enqueueSortDeltas's contract).
function enqueuePropDeltas(before: readonly Tier1PropRow[], after: readonly Tier1PropRow[]): void {
  const beforeById = new Map(before.map((p) => [p.id, p]))
  after.forEach((row, index) => {
    const prev = beforeById.get(row.id)
    if (prev && (prev.sort !== index || prev.rank !== index + 1)) {
      enqueueIfSyncing('tier1_props', row.id, 'update', row)
    }
  })
}

// 1st Tier Foundation state for the currently open project (issue 013): one
// purpose body + a table of ranked value propositions. Every mutating action
// pushes its inverse onto the shared command log (issue 006) — one gesture,
// one call, one undo step (a re-rank included).

interface Tier1State {
  projectId: string | null
  // The single purpose body; '' when the project has none yet.
  purpose: string
  // Issue 081 — shares tier1_purpose's one row with `purpose`; null when the
  // field has never been written (a legitimate terminal state). A
  // JSON-stringified Lexical EditorState, never HTML.
  existingScenario: string | null
  props: Tier1PropRow[]
  // Mirrors the per-scope generation guard used by contexts.ts (issue 004/007
  // CI race): Foundation's mount effect calls load(projectId) once, but a
  // mutation can complete before that initial SELECT resolves. Every mutating
  // action bumps this synchronously before awaiting; load() discards a stale
  // result if the generation moved while it was in flight.
  generation: number
  load: (projectId: string) => Promise<void>
  setPurpose: (body: string) => Promise<void>
  setExistingScenario: (existingScenario: string | null) => Promise<void>
  addProp: (name: string) => Promise<Tier1PropRow | null>
  renameProp: (id: string, name: string) => Promise<void>
  setDescription: (id: string, description: string) => Promise<void>
  reorderProp: (id: string, toIndex: number) => Promise<void>
  removeProp: (id: string) => Promise<void>
}

export const useTier1Store = create<Tier1State>()((set, get) => ({
  projectId: null,
  purpose: '',
  existingScenario: null,
  props: [],
  generation: 0,

  async load(projectId) {
    // Set the scope synchronously, before any await — a mutation firing right
    // after mount must not see a null projectId (HANDOFF race gotcha).
    const startGen = get().generation
    set({ projectId })
    const db = requireDatabase()
    const [purpose, props] = await Promise.all([dbGetPurpose(db, projectId), dbList(db, projectId)])
    if (get().generation !== startGen) return // a mutation landed mid-load; it already set fresh state
    set({ purpose: purpose?.body ?? '', existingScenario: purpose?.existingScenario ?? null, props })

    // Issue 075 Part B — load() only ever ran once per project-open, so a
    // tier1_purpose OR tier1_props delta that streamed in (or that 075A's own
    // FK-retry landed) AFTER this resolved never rendered without a remount.
    // Re-read off this store's own ground-truth signal instead, mirroring
    // 062/067/072's own refresh wiring. Reuses the SAME generation guard
    // load() itself relies on, so an in-progress local mutation always wins.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (state.tier1AppliedAt === prevState.tier1AppliedAt) return
      const { projectId: currentProjectId } = get()
      if (currentProjectId === null) return
      const genAtStart = get().generation
      const freshDb = requireDatabase()
      void Promise.all([dbGetPurpose(freshDb, currentProjectId), dbList(freshDb, currentProjectId)]).then(
        ([freshPurpose, freshProps]) => {
          if (get().generation !== genAtStart) return
          set({
            purpose: freshPurpose?.body ?? '',
            existingScenario: freshPurpose?.existingScenario ?? null,
            props: freshProps,
          })
        },
      )
    })
  },

  async setPurpose(body) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().purpose
    // Issue 081 — Purpose and Existing Scenario SHARE one tier1_purpose row
    // (same Subtlety-A-class nuance 073 originally flagged, widened for the
    // second field): the upsert/update determination must key off whether
    // ANY tier1_purpose row already existed before this edit, not just
    // whether `purpose` itself was previously empty — a project whose only
    // prior write was setExistingScenario already has a row, so this edit
    // must be 'update', or the server's `ON CONFLICT (id) DO NOTHING`
    // silently no-ops it (the 066-class bug).
    const rowExistedBefore = get().purpose !== '' || get().existingScenario !== null
    set((s) => ({ generation: s.generation + 1 }))
    const row = await dbSetPurpose(db, projectId, body)
    set({ purpose: row?.body ?? body })
    if (row) enqueueIfSyncing('tier1_purpose', row.id, rowExistedBefore ? 'update' : 'upsert', row)
    useCommandLogStore.getState().push({
      label: 'edit purpose',
      async undo() {
        const r = await dbSetPurpose(db, projectId, previous)
        set({ purpose: r?.body ?? previous })
        // Issue 094 — by undo time the row always exists (the forward edit
        // created/updated it), so reviving the prior body is an 'update'.
        if (r) enqueueIfSyncing('tier1_purpose', r.id, 'update', r)
      },
      async redo() {
        const r = await dbSetPurpose(db, projectId, body)
        set({ purpose: r?.body ?? body })
        if (r) enqueueIfSyncing('tier1_purpose', r.id, 'update', r)
      },
    })
  },

  // Issue 081 — mirrors setPurpose's own upsert/update subtlety, but Purpose
  // and Existing Scenario SHARE one tier1_purpose row: the enqueued op must
  // be 'upsert' only when NO tier1_purpose row existed before this edit
  // (both purpose === '' AND existingScenario === null), else 'update' — a
  // check on THIS field alone (existingScenario === null) would wrongly
  // enqueue 'upsert' for a row that already exists because Purpose was
  // written first, which the server's ON CONFLICT (id) DO NOTHING would
  // silently no-op (the 066-class bug).
  async setExistingScenario(existingScenario) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().existingScenario
    const rowExistedBefore = get().purpose !== '' || get().existingScenario !== null
    set((s) => ({ generation: s.generation + 1 }))
    const row = await dbSetExistingScenario(db, projectId, existingScenario)
    set({ existingScenario: row?.existingScenario ?? existingScenario })
    if (row) enqueueIfSyncing('tier1_purpose', row.id, rowExistedBefore ? 'update' : 'upsert', row)
    useCommandLogStore.getState().push({
      label: 'edit existing scenario',
      async undo() {
        const r = await dbSetExistingScenario(db, projectId, previous)
        set({ existingScenario: r?.existingScenario ?? previous })
        // Issue 094 — the shared tier1_purpose row already exists by undo time
        // (see setPurpose's undo) → 'update'.
        if (r) enqueueIfSyncing('tier1_purpose', r.id, 'update', r)
      },
      async redo() {
        const r = await dbSetExistingScenario(db, projectId, existingScenario)
        set({ existingScenario: r?.existingScenario ?? existingScenario })
        if (r) enqueueIfSyncing('tier1_purpose', r.id, 'update', r)
      },
    })
  },

  async addProp(name) {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set((s) => ({ generation: s.generation + 1 }))
    // Issue 083 Cause B — FoundationSurface.tsx's `onCreate: (name) => void
    // addProp(name)` discards this promise entirely: a rejection here
    // (dbAdd's own workspaceId resolution, db/mutations.ts's
    // projectWorkspaceId, hard-throws via firstOrThrow on a missing
    // FK-ancestor row) would otherwise vanish into the void, indistinguishable
    // from a silent no-op. Catch it here — the one place guaranteed to run
    // regardless of how the caller awaits — and announce via useStatusStore,
    // the app's one sanctioned feedback channel (mirrors tier2.ts's own
    // addTable/addEntry handling and workspace.ts's acceptInvitation).
    let row: Tier1PropRow
    try {
      row = await dbAdd(db, projectId, name)
    } catch {
      useStatusStore.getState().announce(`Couldn't add "${name}" — please try again.`)
      return null
    }
    set({ props: await dbList(db, projectId) })
    enqueueIfSyncing('tier1_props', row.id, 'upsert', row)
    const orderedIdsAfterAdd = get().props.map((p) => p.id)
    useCommandLogStore.getState().push({
      label: `add value proposition "${name}"`,
      async undo() {
        const before = get().props
        const after = await dbRemove(db, projectId, row.id)
        set({ props: after })
        // Issue 094 — reversal of the forward add's 'upsert': soft-delete the
        // row (→ 'delete') + close the sibling rank/sort gap (→ 'update' each).
        enqueueIfSyncing('tier1_props', row.id, 'delete', row)
        enqueuePropDeltas(before, after)
      },
      async redo() {
        const before = get().props
        const after = await dbRestore(db, projectId, row.id, orderedIdsAfterAdd)
        set({ props: after })
        // Issue 094 — redo re-inserts the row the undo tombstoned → 'revive'
        // (un-tombstones server-side; a plain 'update' can't clear deleted_at,
        // and an 'upsert' would `ON CONFLICT (id) DO NOTHING` — the 066-class no-op).
        const restored = after.find((p) => p.id === row.id)
        if (restored) enqueueIfSyncing('tier1_props', restored.id, 'revive', restored)
        enqueuePropDeltas(before, after)
      },
    })
    return row
  },

  async renameProp(id, name) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().props.find((p) => p.id === id)?.name ?? name
    set((s) => ({ generation: s.generation + 1 }))
    const renamed = await dbRename(db, id, name)
    set({ props: await dbList(db, projectId) })
    enqueueIfSyncing('tier1_props', renamed.id, 'update', renamed)
    useCommandLogStore.getState().push({
      label: `rename value proposition to "${name}"`,
      async undo() {
        const reverted = await dbRename(db, id, previous)
        set({ props: await dbList(db, projectId) })
        // Issue 094 — an edit of an already-synced row → 'update'.
        enqueueIfSyncing('tier1_props', reverted.id, 'update', reverted)
      },
      async redo() {
        const reapplied = await dbRename(db, id, name)
        set({ props: await dbList(db, projectId) })
        enqueueIfSyncing('tier1_props', reapplied.id, 'update', reapplied)
      },
    })
  },

  async setDescription(id, description) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previous = get().props.find((p) => p.id === id)?.description ?? ''
    set((s) => ({ generation: s.generation + 1 }))
    const updated = await dbSetDescription(db, id, description)
    set({ props: await dbList(db, projectId) })
    enqueueIfSyncing('tier1_props', updated.id, 'update', updated)
    useCommandLogStore.getState().push({
      label: 'edit value-proposition description',
      async undo() {
        const reverted = await dbSetDescription(db, id, previous)
        set({ props: await dbList(db, projectId) })
        // Issue 094 — an edit of an already-synced row → 'update'.
        enqueueIfSyncing('tier1_props', reverted.id, 'update', reverted)
      },
      async redo() {
        const reapplied = await dbSetDescription(db, id, description)
        set({ props: await dbList(db, projectId) })
        enqueueIfSyncing('tier1_props', reapplied.id, 'update', reapplied)
      },
    })
  },

  async reorderProp(id, toIndex) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().props
    const fromIndex = before.findIndex((p) => p.id === id)
    set((s) => ({ generation: s.generation + 1 }))
    const after = await dbReorder(db, projectId, id, toIndex)
    set({ props: after })
    // Issue 073 Subtlety B — reorderTier1Prop's rewriteTier1PropRanks rewrites
    // sort/rank on EVERY row whose position actually moved, not just the one
    // the user dragged (db/mutations.ts:939-953). `after` is already in the
    // new sort order, so each row's index IS its new sort/rank — enqueue an
    // 'update' for every row whose previous sort/rank disagrees with it,
    // else sibling drift never reaches the server.
    enqueuePropDeltas(before, after)
    useCommandLogStore.getState().push({
      label: 're-rank value proposition',
      async undo() {
        const beforeUndo = get().props
        const afterUndo = await dbReorder(db, projectId, id, fromIndex)
        set({ props: afterUndo })
        // Issue 094 — re-rank back; enqueue an 'update' per moved prop.
        enqueuePropDeltas(beforeUndo, afterUndo)
      },
      async redo() {
        const beforeRedo = get().props
        const afterRedo = await dbReorder(db, projectId, id, toIndex)
        set({ props: afterRedo })
        enqueuePropDeltas(beforeRedo, afterRedo)
      },
    })
  },

  async removeProp(id) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().props
    const orderedIds = before.map((p) => p.id)
    const removedRow = before.find((p) => p.id === id)
    const removedName = removedRow?.name ?? ''
    set((s) => ({ generation: s.generation + 1 }))
    const after = await dbRemove(db, projectId, id)
    set({ props: after })
    // Issue 073 — the removed row is a soft-delete tombstone; removeTier1Prop
    // ALSO rewrites sort/rank on every surviving sibling to close the gap
    // (same rewriteTier1PropRanks cascade as reorderProp — Subtlety B), so
    // enqueue an 'update' for every one of those, not just the delete.
    if (removedRow) enqueueIfSyncing('tier1_props', id, 'delete', removedRow)
    enqueuePropDeltas(before, after)
    useCommandLogStore.getState().push({
      label: `remove value proposition "${removedName}"`,
      async undo() {
        const beforeUndo = get().props
        const restored = await dbRestore(db, projectId, id, orderedIds)
        set({ props: restored })
        // Issue 094 — reversal of the forward remove: revive the row (→ 'revive',
        // un-tombstones the soft-deleted row) + re-open the sibling rank/sort gap
        // (→ 'update' each moved sibling — those stayed live). A plain 'update'
        // on the removed row can't clear deleted_at server-side — the 094 bug.
        const revived = restored.find((p) => p.id === id)
        if (revived) enqueueIfSyncing('tier1_props', revived.id, 'revive', revived)
        enqueuePropDeltas(beforeUndo, restored)
      },
      async redo() {
        const beforeRedo = get().props
        const afterRedo = await dbRemove(db, projectId, id)
        set({ props: afterRedo })
        // Issue 094 — re-do the forward remove's enqueues.
        if (removedRow) enqueueIfSyncing('tier1_props', id, 'delete', removedRow)
        enqueuePropDeltas(beforeRedo, afterRedo)
      },
    })
  },
}))

export function resetTier1Store(): void {
  syncUnsubscribe?.()
  syncUnsubscribe = null
  useTier1Store.setState({ projectId: null, purpose: '', existingScenario: null, props: [], generation: 0 })
}
