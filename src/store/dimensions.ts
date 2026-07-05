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

// Root-canvas dimensions for the currently open project (child canvases: 011).
// Every mutating action pushes its inverse onto the shared command log
// (issue 006) — one gesture, one call, one undo step.

interface DimensionsState {
  projectId: string | null
  dimensions: DimensionRow[]
  // The row whose name editor is open. Shared state (not component-local) so
  // surfaces can avoid unmounting an editor mid-gesture (guided start swap).
  editingId: string | null
  setEditing: (id: string | null) => void
  load: (projectId: string) => Promise<void>
  add: () => Promise<DimensionRow | null>
  rename: (id: string, name: string) => Promise<void>
  setColor: (id: string, color: string) => Promise<void>
  reorder: (id: string, toIndex: number) => Promise<void>
  remove: (id: string) => Promise<{ ok: boolean; reason?: string }>
}

function contextIdsOf(rows: readonly BindingRow[]): string[] {
  return [...new Set(rows.map((r) => r.contextId))]
}

export const useDimensionsStore = create<DimensionsState>()((set, get) => ({
  projectId: null,
  dimensions: [],
  editingId: null,

  setEditing(id) {
    set({ editingId: id })
  },

  async load(projectId) {
    const db = requireDatabase()
    set({ projectId, dimensions: await dbList(db, projectId), editingId: null })
  },

  async add() {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    const row = await dbAdd(db, projectId)
    // Ready-to-edit is part of the same state transition as the new row —
    // published separately, surfaces could swap away mid-gesture (issue 002
    // guided start).
    set({ dimensions: await dbList(db, projectId), editingId: row.id })
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
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousName = get().dimensions.find((d) => d.id === id)?.name ?? name
    await dbRename(db, id, name)
    set({ dimensions: await dbList(db, projectId) })
    useCommandLogStore.getState().push({
      label: `rename dimension to "${name}"`,
      async undo() {
        await dbRename(db, id, previousName)
        set({ dimensions: await dbList(db, projectId) })
      },
      async redo() {
        await dbRename(db, id, name)
        set({ dimensions: await dbList(db, projectId) })
      },
    })
  },

  async setColor(id, color) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousColor = get().dimensions.find((d) => d.id === id)?.color ?? color
    await dbSetColor(db, id, color)
    set({ dimensions: await dbList(db, projectId) })
    useCommandLogStore.getState().push({
      label: 'recolor dimension',
      async undo() {
        await dbSetColor(db, id, previousColor)
        set({ dimensions: await dbList(db, projectId) })
      },
      async redo() {
        await dbSetColor(db, id, color)
        set({ dimensions: await dbList(db, projectId) })
      },
    })
  },

  async reorder(id, toIndex) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const fromIndex = get().dimensions.findIndex((d) => d.id === id)
    set({ dimensions: await dbReorder(db, projectId, id, toIndex) })
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
    const orderedIds = get().dimensions.map((d) => d.id)
    const removedName = get().dimensions.find((d) => d.id === id)?.name ?? ''
    try {
      const { dimensions, deletedBindings } = await dbRemove(db, projectId, id)
      set({ dimensions })
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
  useDimensionsStore.setState({ projectId: null, dimensions: [], editingId: null })
}
