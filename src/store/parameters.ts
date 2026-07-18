import { create } from 'zustand'
import {
  addParameter as dbAdd,
  listParameters as dbList,
  removeParameter as dbRemove,
  renameParameter as dbRename,
  reorderParameter as dbReorder,
  restoreParameter as dbRestore,
  type ParameterRow,
} from '../db/mutations'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { enqueueIfSyncing, enqueueSortDeltas, useSyncStore } from './sync'

// Issue 075 Part B — the `useSyncStore.parametersAppliedAt` subscription
// below (mirrors src/store/projects.ts's own module-level syncUnsubscribe
// pattern, 072): re-`load()` re-subscribes rather than accumulating a
// duplicate listener per dimension mount.
let syncUnsubscribe: (() => void) | null = null

// Parameters keyed by their owning dimension — m is unbounded and independent
// per dimension (SPEC §2), so unlike dimensions there is no floor to bypass:
// removeParameter is always safe to use directly as undo-of-add. Every
// mutating action pushes its inverse onto the shared command log (issue 006).

interface ParametersState {
  byDimension: Record<string, ParameterRow[]>
  // Per-dimension generation counter (issue 004 fix). ParameterList mounts
  // once per dimension and calls load() on mount; ContextRegister's effect
  // also calls load() for every dimension whenever the dimension list
  // changes. A concurrent load()'s single SELECT can land *between* a
  // mutation's own internal steps (addParameter does SELECT-then-INSERT) and
  // read pre-write state — mutations must always win regardless of DB-level
  // interleaving. Each mutation bumps the generation synchronously before
  // awaiting anything; load() snapshots the generation before its read and
  // discards its result if a mutation started meanwhile (mutations always
  // apply unconditionally — they read-after-write themselves). Undo/redo are
  // mutations too and bump the generation the same way.
  generation: Record<string, number>
  load: (dimensionId: string) => Promise<void>
  add: (dimensionId: string, name: string) => Promise<ParameterRow | null>
  rename: (dimensionId: string, id: string, name: string) => Promise<void>
  reorder: (dimensionId: string, id: string, toIndex: number) => Promise<void>
  remove: (dimensionId: string, id: string) => Promise<void>
}

export const useParametersStore = create<ParametersState>()((set, get) => ({
  byDimension: {},
  generation: {},

  async load(dimensionId) {
    const db = requireDatabase()
    const gen = get().generation[dimensionId] ?? 0
    const rows = await dbList(db, dimensionId)
    if ((get().generation[dimensionId] ?? 0) !== gen) return
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })

    // Issue 075 Part B — load() only ever ran once per dimension mount, so a
    // parameters delta that streamed in (or that 075A's own FK-retry landed)
    // AFTER this resolved never rendered without a remount. Re-read off this
    // store's own ground-truth signal instead, mirroring 062/067/072's own
    // refresh wiring — every currently-tracked dimension re-reads (this store
    // is keyed per-dimension), each still guarded by ITS OWN generation
    // counter so an in-progress local mutation for that dimension always
    // wins over a delta-triggered reload that started before it.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (state.parametersAppliedAt === prevState.parametersAppliedAt) return
      const freshDb = requireDatabase()
      for (const id of Object.keys(get().byDimension)) {
        const genAtStart = get().generation[id] ?? 0
        void dbList(freshDb, id).then((freshRows) => {
          if ((get().generation[id] ?? 0) !== genAtStart) return
          set({ byDimension: { ...get().byDimension, [id]: freshRows } })
        })
      }
    })
  },

  async add(dimensionId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const db = requireDatabase()
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const row = await dbAdd(db, dimensionId, trimmed)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
    enqueueIfSyncing('parameters', row.id, 'upsert', row)
    const orderedIdsAfterAdd = get().byDimension[dimensionId]?.map((p) => p.id) ?? [row.id]
    useCommandLogStore.getState().push({
      label: `add parameter "${row.name}"`,
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const before = get().byDimension[dimensionId] ?? []
        const after = await dbRemove(db, dimensionId, row.id)
        set({ byDimension: { ...get().byDimension, [dimensionId]: after } })
        // Issue 094 — reversal of the forward add's 'upsert': soft-delete the
        // row (→ 'delete') + close the sibling-sort gap (→ 'update' each moved).
        enqueueIfSyncing('parameters', row.id, 'delete', row)
        enqueueSortDeltas('parameters', before, after)
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const before = get().byDimension[dimensionId] ?? []
        const after = await dbRestore(db, dimensionId, row.id, orderedIdsAfterAdd)
        set({ byDimension: { ...get().byDimension, [dimensionId]: after } })
        // Issue 094 — redo re-inserts the row the undo tombstoned → 'revive'
        // (un-tombstones server-side; a plain 'update' can't clear deleted_at,
        // and an 'upsert' would `ON CONFLICT (id) DO NOTHING` — the 066-class no-op).
        const restored = after.find((p) => p.id === row.id)
        if (restored) enqueueIfSyncing('parameters', restored.id, 'revive', restored)
        enqueueSortDeltas('parameters', before, after)
      },
    })
    return row
  },

  async rename(dimensionId, id, name) {
    const db = requireDatabase()
    const previousName = get().byDimension[dimensionId]?.find((p) => p.id === id)?.name ?? name
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const renamed = await dbRename(db, id, name)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
    enqueueIfSyncing('parameters', renamed.id, 'update', renamed)
    useCommandLogStore.getState().push({
      label: `rename parameter to "${name}"`,
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const reverted = await dbRename(db, id, previousName)
        set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
        // Issue 094 — an edit of an already-synced row → 'update'.
        enqueueIfSyncing('parameters', reverted.id, 'update', reverted)
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const reapplied = await dbRename(db, id, name)
        set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
        enqueueIfSyncing('parameters', reapplied.id, 'update', reapplied)
      },
    })
  },

  async reorder(dimensionId, id, toIndex) {
    const db = requireDatabase()
    const before = get().byDimension[dimensionId] ?? []
    const fromIndex = before.findIndex((p) => p.id === id)
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const rows = await dbReorder(db, dimensionId, id, toIndex)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
    // Issue 073 Subtlety B — reorderParameter's rewriteParameterSort rewrites
    // `sort` on EVERY sibling row whose position actually moved, not just the
    // one dragged (db/mutations.ts's rewriteParameterSort). `rows` is already
    // in the new sort order, so each row's index IS its new sort — enqueue an
    // 'update' for every row whose previous sort disagrees with it.
    enqueueSortDeltas('parameters', before, rows)
    useCommandLogStore.getState().push({
      label: 'reorder parameter',
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const beforeUndo = get().byDimension[dimensionId] ?? []
        const reverted = await dbReorder(db, dimensionId, id, fromIndex)
        set({ byDimension: { ...get().byDimension, [dimensionId]: reverted } })
        // Issue 094 — re-sort back; enqueue an 'update' per moved row.
        enqueueSortDeltas('parameters', beforeUndo, reverted)
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const beforeRedo = get().byDimension[dimensionId] ?? []
        const reapplied = await dbReorder(db, dimensionId, id, toIndex)
        set({ byDimension: { ...get().byDimension, [dimensionId]: reapplied } })
        enqueueSortDeltas('parameters', beforeRedo, reapplied)
      },
    })
  },

  async remove(dimensionId, id) {
    const db = requireDatabase()
    const before = get().byDimension[dimensionId] ?? []
    const orderedIds = before.map((p) => p.id)
    const removedRow = before.find((p) => p.id === id)
    const removedName = removedRow?.name ?? ''
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const rows = await dbRemove(db, dimensionId, id)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
    // Issue 073 — the removed row is a soft-delete tombstone; removeParameter
    // ALSO rewrites `sort` on every surviving sibling (Subtlety B, same
    // rewriteParameterSort cascade as reorder) — enqueue an 'update' for each.
    if (removedRow) enqueueIfSyncing('parameters', id, 'delete', removedRow)
    enqueueSortDeltas('parameters', before, rows)
    useCommandLogStore.getState().push({
      label: `remove parameter "${removedName}"`,
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const beforeUndo = get().byDimension[dimensionId] ?? []
        const restored = await dbRestore(db, dimensionId, id, orderedIds)
        set({ byDimension: { ...get().byDimension, [dimensionId]: restored } })
        // Issue 094 — reversal of the forward remove: revive the row (→ 'revive',
        // un-tombstones the soft-deleted row) + re-open the sibling-sort gap
        // (→ 'update' each moved sibling — those stayed live). A plain 'update'
        // on the removed row can't clear deleted_at server-side — the 094 bug.
        const revived = restored.find((p) => p.id === id)
        if (revived) enqueueIfSyncing('parameters', revived.id, 'revive', revived)
        enqueueSortDeltas('parameters', beforeUndo, restored)
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const beforeRedo = get().byDimension[dimensionId] ?? []
        const removed = await dbRemove(db, dimensionId, id)
        set({ byDimension: { ...get().byDimension, [dimensionId]: removed } })
        // Issue 094 — re-do the forward remove's enqueues.
        if (removedRow) enqueueIfSyncing('parameters', id, 'delete', removedRow)
        enqueueSortDeltas('parameters', beforeRedo, removed)
      },
    })
  },
}))

export function resetParametersStore(): void {
  syncUnsubscribe?.()
  syncUnsubscribe = null
  useParametersStore.setState({ byDimension: {}, generation: {} })
}
