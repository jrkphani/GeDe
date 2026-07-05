import { create } from 'zustand'
import {
  addDimension as dbAdd,
  DimensionFloorError,
  listDimensions as dbList,
  removeDimension as dbRemove,
  renameDimension as dbRename,
  reorderDimension as dbReorder,
  setDimensionColor as dbSetColor,
  type DimensionRow,
} from '../db/mutations'
import { requireDatabase } from './database'

// Root-canvas dimensions for the currently open project (child canvases: 011).
// Each action is one gesture — the seam where the 006 command log will attach.

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
    return row
  },

  async rename(id, name) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    await dbRename(db, id, name)
    set({ dimensions: await dbList(db, projectId) })
  },

  async setColor(id, color) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    await dbSetColor(db, id, color)
    set({ dimensions: await dbList(db, projectId) })
  },

  async reorder(id, toIndex) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    set({ dimensions: await dbReorder(db, projectId, id, toIndex) })
  },

  async remove(id) {
    const { projectId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    try {
      set({ dimensions: await dbRemove(db, projectId, id) })
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
