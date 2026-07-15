import { create } from 'zustand'
import {
  addDimension as dbAdd,
  DimensionFloorError,
  listDimensions as dbList,
  removeDimension as dbRemove,
  renameDimension as dbRename,
  reorderDimension as dbReorder,
  restoreDimension as dbRestore,
  setDimensionColor as dbSetColor,
  undoAddDimension,
  type BindingRow,
  type DimensionRow,
} from '../db/mutations'
import { requireDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { useContextsStore } from './contexts'
import { enqueueIfSyncing, useSyncStore } from './sync'

// Root-canvas dimensions for the currently open project (child canvases: 011).
// Every mutating action pushes its inverse onto the shared command log
// (issue 006) — one gesture, one call, one undo step.

interface DimensionsState {
  projectId: string | null
  // The canvas currently loaded: null = the project's root canvas, a context
  // id = that context's child canvas (issue 011). Child-canvas dimensions are
  // DERIVED from the parent's bindings (seeded via openChildCanvas), so the
  // add/remove/reorder gestures are root-only here — the UI hides them on a
  // child canvas and the store guards against them defensively.
  contextId: string | null
  dimensions: DimensionRow[]
  // The row whose name editor is open. Shared state (not component-local) so
  // surfaces can avoid unmounting an editor mid-gesture (guided start swap).
  editingId: string | null
  setEditing: (id: string | null) => void
  load: (projectId: string, contextId?: string | null) => Promise<void>
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

// Issue 075 Part B — the `useSyncStore.dimensionsAppliedAt` subscription
// below (mirrors src/store/projects.ts's own module-level syncUnsubscribe
// pattern, 072): re-`load()` re-subscribes rather than accumulating a
// duplicate listener per canvas navigation.
let syncUnsubscribe: (() => void) | null = null

export const useDimensionsStore = create<DimensionsState>()((set, get) => ({
  projectId: null,
  contextId: null,
  dimensions: [],
  editingId: null,

  setEditing(id) {
    set({ editingId: id })
  },

  async load(projectId, contextId = null) {
    const db = requireDatabase()
    set({ projectId, contextId, dimensions: await dbList(db, projectId, contextId), editingId: null })
    // Issue 075 Part B — load() only ever ran once per canvas-open, so a
    // dimensions delta that streamed in (or that 075A's own FK-retry landed)
    // AFTER this resolved never rendered without a remount. Re-list off this
    // store's own ground-truth signal instead, mirroring 062/067/072's own
    // refresh wiring. Only touches `dimensions` (never `editingId`), so an
    // open name editor never gets yanked out from under an in-progress edit.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (state.dimensionsAppliedAt === prevState.dimensionsAppliedAt) return
      const { projectId: currentProjectId, contextId: currentContextId } = get()
      if (currentProjectId === null) return
      void dbList(requireDatabase(), currentProjectId, currentContextId).then((rows) =>
        set({ dimensions: rows }),
      )
    })
  },

  async add(name) {
    const { projectId, contextId } = get()
    // Child-canvas dimensions are derived from the parent's bindings — not
    // freely added (SPEC recursion rule). Guarded; the UI hides the affordance.
    if (projectId === null || contextId !== null) return null
    const db = requireDatabase()
    const row = await dbAdd(db, projectId, name)
    // Ready-to-edit is part of the same state transition as the new row —
    // published separately, surfaces could swap away mid-gesture. A caller
    // that already supplied a name (the phantom-row grammar, issue 082) has
    // nothing left to edit, so it doesn't open the row's own name editor.
    set({ dimensions: await dbList(db, projectId), editingId: name ? null : row.id })
    enqueueIfSyncing('dimensions', row.id, 'upsert', row)
    const orderedIdsAfterAdd = get().dimensions.map((d) => d.id)
    useCommandLogStore.getState().push({
      label: 'add dimension',
      async undo() {
        // Bypasses the n=2 floor deliberately — see undoAddDimension's doc.
        await undoAddDimension(db, projectId, row.id)
        set({ dimensions: await dbList(db, projectId) })
      },
      async redo() {
        await dbRestore(db, projectId, row.id, orderedIdsAfterAdd)
        set({ dimensions: await dbList(db, projectId) })
      },
    })
    return row
  },

  async rename(id, name) {
    const { projectId, contextId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousName = get().dimensions.find((d) => d.id === id)?.name ?? name
    const renamed = await dbRename(db, id, name)
    set({ dimensions: await dbList(db, projectId, contextId) })
    enqueueIfSyncing('dimensions', renamed.id, 'update', renamed)
    useCommandLogStore.getState().push({
      label: `rename dimension to "${name}"`,
      async undo() {
        await dbRename(db, id, previousName)
        set({ dimensions: await dbList(db, projectId, contextId) })
      },
      async redo() {
        await dbRename(db, id, name)
        set({ dimensions: await dbList(db, projectId, contextId) })
      },
    })
  },

  async setColor(id, color) {
    const { projectId, contextId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousColor = get().dimensions.find((d) => d.id === id)?.color ?? color
    const updated = await dbSetColor(db, id, color)
    set({ dimensions: await dbList(db, projectId, contextId) })
    enqueueIfSyncing('dimensions', updated.id, 'update', updated)
    useCommandLogStore.getState().push({
      label: 'recolor dimension',
      async undo() {
        await dbSetColor(db, id, previousColor)
        set({ dimensions: await dbList(db, projectId, contextId) })
      },
      async redo() {
        await dbSetColor(db, id, color)
        set({ dimensions: await dbList(db, projectId, contextId) })
      },
    })
  },

  async reorder(id, toIndex) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().dimensions
    const fromIndex = before.findIndex((d) => d.id === id)
    const after = await dbReorder(db, projectId, id, toIndex)
    set({ dimensions: after })
    // Issue 073 Subtlety B — reorderDimension's rewriteSort rewrites `sort` on
    // EVERY sibling row whose position actually moved, not just the one
    // dragged (db/mutations.ts's rewriteSort). `after` is already in the new
    // sort order, so each row's index IS its new sort — enqueue an 'update'
    // for every row whose previous sort disagrees with it, else sibling drift
    // never reaches the server.
    const beforeById = new Map(before.map((d) => [d.id, d]))
    after.forEach((row, index) => {
      const prevSort = beforeById.get(row.id)?.sort ?? -1
      if (prevSort !== index) enqueueIfSyncing('dimensions', row.id, 'update', row)
    })
    useCommandLogStore.getState().push({
      label: 'reorder dimension',
      async undo() {
        set({ dimensions: await dbReorder(db, projectId, id, fromIndex) })
      },
      async redo() {
        set({ dimensions: await dbReorder(db, projectId, id, toIndex) })
      },
    })
  },

  async remove(id) {
    const { projectId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    const before = get().dimensions
    const orderedIds = before.map((d) => d.id)
    const removedRow = before.find((d) => d.id === id)
    const removedName = removedRow?.name ?? ''
    try {
      const { dimensions: after, deletedBindings } = await dbRemove(db, projectId, id)
      set({ dimensions: after })
      // Issue 073 — the removed row is a soft-delete tombstone; removeDimension
      // ALSO rewrites `sort` on every surviving sibling (Subtlety B, same
      // rewriteSort cascade as reorder) AND cascades a tombstone to every
      // binding that pointed at this dimension — enqueue all three, not just
      // the delete the user directly triggered.
      if (removedRow) enqueueIfSyncing('dimensions', id, 'delete', removedRow)
      const beforeById = new Map(before.map((d) => [d.id, d]))
      after.forEach((row, index) => {
        const prevSort = beforeById.get(row.id)?.sort ?? -1
        if (prevSort !== index) enqueueIfSyncing('dimensions', row.id, 'update', row)
      })
      for (const b of deletedBindings) enqueueIfSyncing('bindings', b.id, 'delete', b)
      await useContextsStore.getState().syncBindingsForContexts(contextIdsOf(deletedBindings))
      useCommandLogStore.getState().push({
        label: `remove dimension "${removedName}"`,
        async undo() {
          const restored = await dbRestore(db, projectId, id, orderedIds, deletedBindings)
          set({ dimensions: restored })
          await useContextsStore.getState().syncBindingsForContexts(contextIdsOf(deletedBindings))
        },
        async redo() {
          const result = await dbRemove(db, projectId, id)
          set({ dimensions: result.dimensions })
          await useContextsStore.getState().syncBindingsForContexts(contextIdsOf(result.deletedBindings))
        },
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof DimensionFloorError) return { ok: false, reason: err.message }
      throw err
    }
  },
}))

export function resetDimensionsStore(): void {
  syncUnsubscribe?.()
  syncUnsubscribe = null
  useDimensionsStore.setState({ projectId: null, contextId: null, dimensions: [], editingId: null })
}
