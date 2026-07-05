import { create } from 'zustand'
import {
  addParameter as dbAdd,
  listParameters as dbList,
  removeParameter as dbRemove,
  renameParameter as dbRename,
  reorderParameter as dbReorder,
  type ParameterRow,
} from '../db/mutations'
import { requireDatabase } from './database'

// Parameters keyed by their owning dimension — m is unbounded and independent
// per dimension (SPEC §2). Each action is one gesture, same seam as dimensions
// for the future 006 command log.

interface ParametersState {
  byDimension: Record<string, ParameterRow[]>
  load: (dimensionId: string) => Promise<void>
  add: (dimensionId: string, name: string) => Promise<ParameterRow | null>
  rename: (dimensionId: string, id: string, name: string) => Promise<void>
  reorder: (dimensionId: string, id: string, toIndex: number) => Promise<void>
  remove: (dimensionId: string, id: string) => Promise<void>
}

export const useParametersStore = create<ParametersState>()((set, get) => ({
  byDimension: {},

  async load(dimensionId) {
    const db = requireDatabase()
    const rows = await dbList(db, dimensionId)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
  },

  async add(dimensionId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const db = requireDatabase()
    const row = await dbAdd(db, dimensionId, trimmed)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
    return row
  },

  async rename(dimensionId, id, name) {
    const db = requireDatabase()
    await dbRename(db, id, name)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
  },

  async reorder(dimensionId, id, toIndex) {
    const db = requireDatabase()
    const rows = await dbReorder(db, dimensionId, id, toIndex)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
  },

  async remove(dimensionId, id) {
    const db = requireDatabase()
    const rows = await dbRemove(db, dimensionId, id)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
  },
}))

export function resetParametersStore(): void {
  useParametersStore.setState({ byDimension: {} })
}
