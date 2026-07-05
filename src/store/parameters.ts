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
  // Per-dimension generation counter (issue 004 fix). ParameterList mounts
  // once per dimension and calls load() on mount; ContextRegister's effect
  // also calls load() for every dimension whenever the dimension list
  // changes. A concurrent load()'s single SELECT can land *between* a
  // mutation's own internal steps (addParameter does SELECT-then-INSERT) and
  // read pre-write state — mutations must always win regardless of DB-level
  // interleaving. Each mutation bumps the generation synchronously before
  // awaiting anything; load() snapshots the generation before its read and
  // discards its result if a mutation started meanwhile (mutations always
  // apply unconditionally — they read-after-write themselves).
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
  },

  async add(dimensionId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const db = requireDatabase()
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const row = await dbAdd(db, dimensionId, trimmed)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
    return row
  },

  async rename(dimensionId, id, name) {
    const db = requireDatabase()
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    await dbRename(db, id, name)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
  },

  async reorder(dimensionId, id, toIndex) {
    const db = requireDatabase()
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const rows = await dbReorder(db, dimensionId, id, toIndex)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
  },

  async remove(dimensionId, id) {
    const db = requireDatabase()
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const rows = await dbRemove(db, dimensionId, id)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
  },
}))

export function resetParametersStore(): void {
  useParametersStore.setState({ byDimension: {}, generation: {} })
}
