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
  },

  async add(dimensionId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const db = requireDatabase()
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const row = await dbAdd(db, dimensionId, trimmed)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
    const orderedIdsAfterAdd = get().byDimension[dimensionId]?.map((p) => p.id) ?? [row.id]
    useCommandLogStore.getState().push({
      label: `add parameter "${row.name}"`,
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        await dbRemove(db, dimensionId, row.id)
        set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        await dbRestore(db, dimensionId, row.id, orderedIdsAfterAdd)
        set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
      },
    })
    return row
  },

  async rename(dimensionId, id, name) {
    const db = requireDatabase()
    const previousName = get().byDimension[dimensionId]?.find((p) => p.id === id)?.name ?? name
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    await dbRename(db, id, name)
    set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
    useCommandLogStore.getState().push({
      label: `rename parameter to "${name}"`,
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        await dbRename(db, id, previousName)
        set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        await dbRename(db, id, name)
        set({ byDimension: { ...get().byDimension, [dimensionId]: await dbList(db, dimensionId) } })
      },
    })
  },

  async reorder(dimensionId, id, toIndex) {
    const db = requireDatabase()
    const fromIndex = (get().byDimension[dimensionId] ?? []).findIndex((p) => p.id === id)
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const rows = await dbReorder(db, dimensionId, id, toIndex)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
    useCommandLogStore.getState().push({
      label: 'reorder parameter',
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const reverted = await dbReorder(db, dimensionId, id, fromIndex)
        set({ byDimension: { ...get().byDimension, [dimensionId]: reverted } })
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const reapplied = await dbReorder(db, dimensionId, id, toIndex)
        set({ byDimension: { ...get().byDimension, [dimensionId]: reapplied } })
      },
    })
  },

  async remove(dimensionId, id) {
    const db = requireDatabase()
    const orderedIds = (get().byDimension[dimensionId] ?? []).map((p) => p.id)
    const removedName = get().byDimension[dimensionId]?.find((p) => p.id === id)?.name ?? ''
    set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
    const rows = await dbRemove(db, dimensionId, id)
    set({ byDimension: { ...get().byDimension, [dimensionId]: rows } })
    useCommandLogStore.getState().push({
      label: `remove parameter "${removedName}"`,
      async undo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const restored = await dbRestore(db, dimensionId, id, orderedIds)
        set({ byDimension: { ...get().byDimension, [dimensionId]: restored } })
      },
      async redo() {
        set({ generation: { ...get().generation, [dimensionId]: (get().generation[dimensionId] ?? 0) + 1 } })
        const removed = await dbRemove(db, dimensionId, id)
        set({ byDimension: { ...get().byDimension, [dimensionId]: removed } })
      },
    })
  },
}))

export function resetParametersStore(): void {
  useParametersStore.setState({ byDimension: {}, generation: {} })
}
