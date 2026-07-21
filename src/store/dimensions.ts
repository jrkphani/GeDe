import { create } from 'zustand'
import {
  addDimension as dbAdd,
  DimensionFloorError,
  listDimensions as dbList,
  removeDimension as dbRemove,
  renameDimension as dbRename,
  reorderDimension as dbReorder,
  resolveCanvasScope,
  restoreDimension as dbRestore,
  setDimensionColor as dbSetColor,
  undoAddDimension,
  type BindingRow,
  type DimensionRow,
} from '../db/mutations'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import type { CanvasStores } from './canvasStores'
import { enqueueIfSyncing, enqueueSortDeltas, useSyncStore } from './sync'

// Root-canvas dimensions for the currently open project (child canvases: 011).
// Every mutating action pushes its inverse onto the shared command log
// (issue 006) — one gesture, one call, one undo step.

export interface DimensionsState {
  projectId: string | null
  // Issue 090 Phase 4b — the canvas currently loaded, keyed on the real
  // `canvas_id` FK now (null ⇒ the project's default root canvas, the tolerant
  // pre-090 default). `isChildCanvas` replaces the old "contextId !== null"
  // signal: child-canvas dimensions are DERIVED from the parent's bindings
  // (seeded via openChildCanvas), so add() is guarded off this flag (the UI
  // hides the affordance on a child canvas).
  canvasId: string | null
  isChildCanvas: boolean
  // Transitional compat field for DesignSurface.tsx's render gate
  // (`loadedContextId !== contextId`, DesignSurface.tsx:50/433) — mirrors the
  // navigation selector the caller passed to load(). Dropped in Phase 4c once
  // the surface reads `canvasId` and passes a real canvas id.
  contextId: string | null
  dimensions: DimensionRow[]
  // The row whose name editor is open. Shared state (not component-local) so
  // surfaces can avoid unmounting an editor mid-gesture (guided start swap).
  editingId: string | null
  setEditing: (id: string | null) => void
  load: (projectId: string, canvasId?: string | null, isChildCanvas?: boolean) => Promise<void>
  // Issue 082 Phase 1 — `name` lets the rail's phantom-row grammar commit the
  // typed name in the same gesture (mirrors parameters.add(dimensionId,
  // name)); omitted, this is byte-identical to the pre-082 "Dimension N" +
  // open-for-rename behavior every existing caller/test relies on.
  add: (name?: string) => Promise<DimensionRow | null>
  rename: (id: string, name: string) => Promise<void>
  setColor: (id: string, color: string) => Promise<void>
  reorder: (id: string, toIndex: number) => Promise<void>
  remove: (id: string) => Promise<{ ok: boolean; reason?: string }>
}

function contextIdsOf(rows: readonly BindingRow[]): string[] {
  return [...new Set(rows.map((r) => r.contextId))]
}

export function createDimensionsStore(getStores: () => CanvasStores) {
  // Issue 075 Part B — the `useSyncStore.dimensionsAppliedAt` subscription
  // below (mirrors src/store/projects.ts's own module-level syncUnsubscribe
  // pattern, 072): re-`load()` re-subscribes rather than accumulating a
  // duplicate listener per canvas navigation. Issue 100 Phase A moved it inside
  // the factory so it is a per-instance closure var.
  let syncUnsubscribe: (() => void) | null = null

  const useStore = create<DimensionsState>()((set, get) => ({
  projectId: null,
  canvasId: null,
  isChildCanvas: false,
  contextId: null,
  dimensions: [],
  editingId: null,

  setEditing(id) {
    set({ editingId: id })
  },

  async load(projectId, canvasId = null, isChildCanvas) {
    const db = requireDatabase()
    // Resolve the navigation selector (null root default / a real canvas id /
    // a legacy context-id drill-in) to its concrete canvas. `isChildCanvas`,
    // when omitted, is derived from the resolved canvas so the child-canvas
    // add-guard is correct even for the un-migrated DesignSurface drill-in.
    const canvas = await resolveCanvasScope(db, projectId, canvasId)
    const resolvedCanvasId = canvas?.id ?? null
    set({
      projectId,
      canvasId: resolvedCanvasId,
      isChildCanvas: isChildCanvas ?? canvas?.parentContextId != null,
      // Compat: the render-gate field tracks the caller's raw selector
      // (DesignSurface.tsx:50/433), dropped in Phase 4c.
      contextId: canvasId,
      dimensions: await dbList(db, projectId, resolvedCanvasId),
      editingId: null,
    })
    // Issue 075 Part B — load() only ever ran once per canvas-open, so a
    // dimensions delta that streamed in (or that 075A's own FK-retry landed)
    // AFTER this resolved never rendered without a remount. Re-list off this
    // store's own ground-truth signal instead, mirroring 062/067/072's own
    // refresh wiring. Only touches `dimensions` (never `editingId`), so an
    // open name editor never gets yanked out from under an in-progress edit.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (state.dimensionsAppliedAt === prevState.dimensionsAppliedAt) return
      const { projectId: currentProjectId, canvasId: currentCanvasId } = get()
      if (currentProjectId === null) return
      void dbList(requireDatabase(), currentProjectId, currentCanvasId).then((rows) =>
        set({ dimensions: rows }),
      )
    })
  },

  async add(name) {
    const { projectId, canvasId, isChildCanvas } = get()
    // Child-canvas dimensions are derived from the parent's bindings — not
    // freely added (SPEC recursion rule). Guarded; the UI hides the affordance.
    if (projectId === null || isChildCanvas) return null
    const db = requireDatabase()
    // Issue 090 Phase 4b — land the new dimension on the currently-selected
    // canvas (canvasId omitted ⇒ the project's default root canvas).
    const row = await dbAdd(db, projectId, name, canvasId ?? undefined)
    // Ready-to-edit is part of the same state transition as the new row —
    // published separately, surfaces could swap away mid-gesture. A caller
    // that already supplied a name (the phantom-row grammar, issue 082) has
    // nothing left to edit, so it doesn't open the row's own name editor.
    set({ dimensions: await dbList(db, projectId, canvasId), editingId: name ? null : row.id })
    enqueueIfSyncing('dimensions', row.id, 'upsert', row)
    const orderedIdsAfterAdd = get().dimensions.map((d) => d.id)
    useCommandLogStore.getState().push({
      label: 'add dimension',
      async undo() {
        // Bypasses the n=2 floor deliberately — see undoAddDimension's doc.
        // Scoped to this canvas (090 Phase 4c) so the sibling-sort rewrite
        // touches only this canvas's rows.
        const before = get().dimensions
        const { dimensions: after, deletedBindings } = await undoAddDimension(
          db,
          projectId,
          row.id,
          canvasId ?? undefined,
        )
        set({ dimensions: after })
        // Issue 094 — the reversal of the forward add's 'upsert': the row is
        // soft-deleted (→ 'delete') and its siblings' sort may close the gap
        // (→ 'update' each moved row). A tail-appended add leaves siblings put,
        // so enqueueSortDeltas usually emits nothing — but mirror it precisely.
        enqueueIfSyncing('dimensions', row.id, 'delete', row)
        enqueueSortDeltas('dimensions', before, after)
        for (const b of deletedBindings) enqueueIfSyncing('bindings', b.id, 'delete', b)
      },
      async redo() {
        const before = get().dimensions
        const after = await dbRestore(db, projectId, row.id, orderedIdsAfterAdd, [], canvasId ?? undefined)
        set({ dimensions: after })
        // Issue 094 — redo re-inserts the row the undo tombstoned → 'revive'
        // (un-tombstones server-side; a plain 'update' can't clear deleted_at,
        // and an 'upsert' would `ON CONFLICT (id) DO NOTHING` — the 066-class
        // no-op). Mirrors canvases.ts's create-redo.
        const restored = after.find((d) => d.id === row.id)
        if (restored) enqueueIfSyncing('dimensions', restored.id, 'revive', restored)
        enqueueSortDeltas('dimensions', before, after)
      },
    })
    return row
  },

  async rename(id, name) {
    const { projectId, canvasId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousName = get().dimensions.find((d) => d.id === id)?.name ?? name
    const renamed = await dbRename(db, id, name)
    set({ dimensions: await dbList(db, projectId, canvasId) })
    enqueueIfSyncing('dimensions', renamed.id, 'update', renamed)
    useCommandLogStore.getState().push({
      label: `rename dimension to "${name}"`,
      async undo() {
        const reverted = await dbRename(db, id, previousName)
        set({ dimensions: await dbList(db, projectId, canvasId) })
        // Issue 094 — an edit of an already-synced row → 'update' (mirrors the
        // forward rename's own enqueue).
        enqueueIfSyncing('dimensions', reverted.id, 'update', reverted)
      },
      async redo() {
        const reapplied = await dbRename(db, id, name)
        set({ dimensions: await dbList(db, projectId, canvasId) })
        enqueueIfSyncing('dimensions', reapplied.id, 'update', reapplied)
      },
    })
  },

  async setColor(id, color) {
    const { projectId, canvasId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousColor = get().dimensions.find((d) => d.id === id)?.color ?? color
    const updated = await dbSetColor(db, id, color)
    set({ dimensions: await dbList(db, projectId, canvasId) })
    enqueueIfSyncing('dimensions', updated.id, 'update', updated)
    useCommandLogStore.getState().push({
      label: 'recolor dimension',
      async undo() {
        const reverted = await dbSetColor(db, id, previousColor)
        set({ dimensions: await dbList(db, projectId, canvasId) })
        // Issue 094 — an edit of an already-synced row → 'update'.
        enqueueIfSyncing('dimensions', reverted.id, 'update', reverted)
      },
      async redo() {
        const reapplied = await dbSetColor(db, id, color)
        set({ dimensions: await dbList(db, projectId, canvasId) })
        enqueueIfSyncing('dimensions', reapplied.id, 'update', reapplied)
      },
    })
  },

  async reorder(id, toIndex) {
    const { projectId, canvasId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().dimensions
    const fromIndex = before.findIndex((d) => d.id === id)
    const after = await dbReorder(db, projectId, id, toIndex, canvasId ?? undefined)
    set({ dimensions: after })
    // Issue 073 Subtlety B — reorderDimension's rewriteSort rewrites `sort` on
    // EVERY sibling row whose position actually moved, not just the one
    // dragged (db/mutations.ts's rewriteSort). `after` is already in the new
    // sort order, so each row's index IS its new sort — enqueue an 'update'
    // for every row whose previous sort disagrees with it, else sibling drift
    // never reaches the server.
    enqueueSortDeltas('dimensions', before, after)
    useCommandLogStore.getState().push({
      label: 'reorder dimension',
      async undo() {
        const beforeUndo = get().dimensions
        const afterUndo = await dbReorder(db, projectId, id, fromIndex, canvasId ?? undefined)
        set({ dimensions: afterUndo })
        // Issue 094 — the reversal re-sorts the lane back; enqueue an 'update'
        // for every row whose sort actually moved (same cascade as forward).
        enqueueSortDeltas('dimensions', beforeUndo, afterUndo)
      },
      async redo() {
        const beforeRedo = get().dimensions
        const afterRedo = await dbReorder(db, projectId, id, toIndex, canvasId ?? undefined)
        set({ dimensions: afterRedo })
        enqueueSortDeltas('dimensions', beforeRedo, afterRedo)
      },
    })
  },

  async remove(id) {
    const { projectId, canvasId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    const before = get().dimensions
    const orderedIds = before.map((d) => d.id)
    const removedRow = before.find((d) => d.id === id)
    const removedName = removedRow?.name ?? ''
    try {
      const { dimensions: after, deletedBindings } = await dbRemove(db, projectId, id, canvasId ?? undefined)
      set({ dimensions: after })
      // Issue 073 — the removed row is a soft-delete tombstone; removeDimension
      // ALSO rewrites `sort` on every surviving sibling (Subtlety B, same
      // rewriteSort cascade as reorder) AND cascades a tombstone to every
      // binding that pointed at this dimension — enqueue all three, not just
      // the delete the user directly triggered.
      if (removedRow) enqueueIfSyncing('dimensions', id, 'delete', removedRow)
      enqueueSortDeltas('dimensions', before, after)
      for (const b of deletedBindings) enqueueIfSyncing('bindings', b.id, 'delete', b)
      await getStores().useContexts.getState().syncBindingsForContexts(contextIdsOf(deletedBindings))
      useCommandLogStore.getState().push({
        label: `remove dimension "${removedName}"`,
        async undo() {
          const beforeUndo = get().dimensions
          const restored = await dbRestore(db, projectId, id, orderedIds, deletedBindings, canvasId ?? undefined)
          set({ dimensions: restored })
          await getStores().useContexts.getState().syncBindingsForContexts(contextIdsOf(deletedBindings))
          // Issue 094 — the exact reversal of the forward remove's three
          // enqueues: revive the dimension (→ 'revive', un-tombstones the
          // soft-deleted row), re-open the sibling-sort gap (→ 'update' each
          // moved row — those stayed live), and revive every cascade-tombstoned
          // binding (→ 'revive'; restoreDimension rewrote parameterId from the
          // captured row, so `b.parameterId` is the live value). A plain
          // 'update' can't clear deleted_at server-side — the 094 bug.
          const revived = restored.find((d) => d.id === id)
          if (revived) enqueueIfSyncing('dimensions', revived.id, 'revive', revived)
          enqueueSortDeltas('dimensions', beforeUndo, restored)
          const revivedAt = new Date().toISOString()
          for (const b of deletedBindings) {
            enqueueIfSyncing('bindings', b.id, 'revive', { ...b, deletedAt: null, updatedAt: revivedAt })
          }
        },
        async redo() {
          const beforeRedo = get().dimensions
          const result = await dbRemove(db, projectId, id, canvasId ?? undefined)
          set({ dimensions: result.dimensions })
          await getStores().useContexts.getState().syncBindingsForContexts(contextIdsOf(result.deletedBindings))
          // Issue 094 — re-do the forward remove's three enqueues verbatim.
          if (removedRow) enqueueIfSyncing('dimensions', id, 'delete', removedRow)
          enqueueSortDeltas('dimensions', beforeRedo, result.dimensions)
          for (const b of result.deletedBindings) enqueueIfSyncing('bindings', b.id, 'delete', b)
        },
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof DimensionFloorError) return { ok: false, reason: err.message }
      throw err
    }
  },
  }))

  function reset(): void {
    syncUnsubscribe?.()
    syncUnsubscribe = null
    useStore.setState({
      projectId: null,
      canvasId: null,
      isChildCanvas: false,
      contextId: null,
      dimensions: [],
      editingId: null,
    })
  }

  function teardown(): void {
    syncUnsubscribe?.()
    syncUnsubscribe = null
  }

  return { useStore, reset, teardown }
}

// Issue 100 Phase A — default-instance shims re-exported from the composition
// root so every existing `./dimensions` import path is unchanged.
export { useDimensionsStore, resetDimensionsStore } from './canvasStores'
