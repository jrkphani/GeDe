import { create } from 'zustand'
import type { Database } from '../db/client'
import {
  archiveContext as dbArchive,
  bindParameter as dbBind,
  ContextSymbolCollisionError,
  createContext as dbCreate,
  listBindings as dbListBindings,
  listContexts as dbListContexts,
  restoreContext as dbRestore,
  setContextJustification as dbSetJustification,
  setContextSymbol as dbSetSymbol,
  unbindParameter as dbUnbind,
  type BindingRow,
  type ContextRow,
} from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { requireDatabase } from './database'

// Root-canvas contexts for the currently open project (child canvases: 011).
// Every mutating action pushes its inverse onto the shared command log
// (issue 006); unlike dimensions/parameters, contexts have only five simple
// actions, each with a direct field-level inverse — no snapshot machinery
// needed. Undo/redo replay is safe against setSymbol's collision check
// because undo always runs in strict LIFO order: any later context that took
// over a symbol being restored was itself already undone first.

async function fetchBindingsMap(
  db: Database,
  contextIds: readonly string[],
): Promise<Record<string, Record<string, string>>> {
  const map: Record<string, Record<string, string>> = {}
  for (const id of contextIds) {
    const rows: BindingRow[] = await dbListBindings(db, id)
    map[id] = Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId]))
  }
  return map
}

interface ContextsState {
  projectId: string | null
  contexts: ContextRow[]
  // contextId -> dimensionId -> parameterId
  bindingsByContext: Record<string, Record<string, string>>
  // Mirrors parameters.ts's per-dimension generation counter (issue 004 fix),
  // scoped to the single currently-open project instead: ContextRegister's
  // mount effect calls load(projectId) once, and a mutation (create() etc.)
  // can complete *before* that initial load's own SELECT resolves — a stale
  // load() landing after a mutation would silently overwrite it with
  // pre-mutation state. Every mutating action bumps this synchronously
  // before awaiting anything; load() discards its result if the generation
  // moved while it was in flight (root-caused via a CI-only e2e failure,
  // issue 007 cleanup — mutations always win regardless of DB interleaving).
  generation: number
  load: (projectId: string) => Promise<void>
  create: () => Promise<ContextRow | null>
  setSymbol: (id: string, symbol: string) => Promise<{ ok: boolean; reason?: string }>
  setJustification: (id: string, text: string) => Promise<void>
  bind: (contextId: string, dimensionId: string, parameterId: string) => Promise<void>
  unbind: (contextId: string, dimensionId: string) => Promise<void>
  // Re-reads bindings for exactly these contexts from the DB and merges them
  // in (issue 007) — the mirror side of a dimension add/remove, whose own
  // mutation + undo/redo already wrote the authoritative binding rows.
  syncBindingsForContexts: (contextIds: readonly string[]) => Promise<void>
}

export const useContextsStore = create<ContextsState>()((set, get) => ({
  projectId: null,
  contexts: [],
  bindingsByContext: {},
  generation: 0,

  async load(projectId) {
    const db = requireDatabase()
    // Set synchronously, before any await (issue 007 CI bug, real root
    // cause): create() etc. read get().projectId internally rather than
    // taking it as an argument, so if it were only set after this
    // function's own DB round-trip, a mutation fired very soon after mount
    // (ContextRegister's own load() effect) could run while projectId was
    // still null and silently no-op — no error, since create()'s guard
    // just returns null. Reproduced on CI (slow enough to lose the race
    // every time) but never locally (load() always won there).
    set({ projectId })
    const gen = get().generation
    const contexts = await dbListContexts(db, projectId)
    const bindingsByContext = await fetchBindingsMap(
      db,
      contexts.map((c) => c.id),
    )
    if (get().generation !== gen) return
    set({ contexts, bindingsByContext })
  },

  async create() {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    const row = await dbCreate(db, projectId)
    const contexts = await dbListContexts(db, projectId)
    set({ contexts, bindingsByContext: { ...get().bindingsByContext, [row.id]: {} } })
    useCommandLogStore.getState().push({
      label: `create context ${row.symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        await dbArchive(db, row.id)
        set({ contexts: await dbListContexts(db, projectId) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        await dbRestore(db, row.id)
        set({
          contexts: await dbListContexts(db, projectId),
          bindingsByContext: { ...get().bindingsByContext, [row.id]: get().bindingsByContext[row.id] ?? {} },
        })
      },
    })
    return row
  },

  async setSymbol(id, symbol) {
    const { projectId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    const previousSymbol = get().contexts.find((c) => c.id === id)?.symbol ?? symbol
    try {
      set({ generation: get().generation + 1 })
      await dbSetSymbol(db, projectId, id, symbol)
      set({ contexts: await dbListContexts(db, projectId) })
      useCommandLogStore.getState().push({
        label: `rename ${previousSymbol} to ${symbol}`,
        async undo() {
          set({ generation: get().generation + 1 })
          await dbSetSymbol(db, projectId, id, previousSymbol)
          set({ contexts: await dbListContexts(db, projectId) })
        },
        async redo() {
          set({ generation: get().generation + 1 })
          await dbSetSymbol(db, projectId, id, symbol)
          set({ contexts: await dbListContexts(db, projectId) })
        },
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof ContextSymbolCollisionError) return { ok: false, reason: err.message }
      throw err
    }
  },

  async setJustification(id, text) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousText = get().contexts.find((c) => c.id === id)?.justification ?? ''
    const symbol = get().contexts.find((c) => c.id === id)?.symbol ?? id
    set({ generation: get().generation + 1 })
    await dbSetJustification(db, id, text)
    set({ contexts: await dbListContexts(db, projectId) })
    useCommandLogStore.getState().push({
      label: `edit justification for ${symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        await dbSetJustification(db, id, previousText)
        set({ contexts: await dbListContexts(db, projectId) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        await dbSetJustification(db, id, text)
        set({ contexts: await dbListContexts(db, projectId) })
      },
    })
  },

  async bind(contextId, dimensionId, parameterId) {
    const db = requireDatabase()
    const previousParameterId = get().bindingsByContext[contextId]?.[dimensionId] ?? null
    set({ generation: get().generation + 1 })
    const rows = await dbBind(db, contextId, dimensionId, parameterId)
    set({
      bindingsByContext: {
        ...get().bindingsByContext,
        [contextId]: Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId])),
      },
    })
    useCommandLogStore.getState().push({
      label: 'bind parameter',
      async undo() {
        set({ generation: get().generation + 1 })
        const restored = previousParameterId
          ? await dbBind(db, contextId, dimensionId, previousParameterId)
          : await dbUnbind(db, contextId, dimensionId)
        set({
          bindingsByContext: {
            ...get().bindingsByContext,
            [contextId]: Object.fromEntries(restored.map((r) => [r.dimensionId, r.parameterId])),
          },
        })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const reapplied = await dbBind(db, contextId, dimensionId, parameterId)
        set({
          bindingsByContext: {
            ...get().bindingsByContext,
            [contextId]: Object.fromEntries(reapplied.map((r) => [r.dimensionId, r.parameterId])),
          },
        })
      },
    })
  },

  async unbind(contextId, dimensionId) {
    const db = requireDatabase()
    const previousParameterId = get().bindingsByContext[contextId]?.[dimensionId] ?? null
    set({ generation: get().generation + 1 })
    const rows = await dbUnbind(db, contextId, dimensionId)
    set({
      bindingsByContext: {
        ...get().bindingsByContext,
        [contextId]: Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId])),
      },
    })
    useCommandLogStore.getState().push({
      label: 'unbind parameter',
      async undo() {
        if (!previousParameterId) return
        set({ generation: get().generation + 1 })
        const restored = await dbBind(db, contextId, dimensionId, previousParameterId)
        set({
          bindingsByContext: {
            ...get().bindingsByContext,
            [contextId]: Object.fromEntries(restored.map((r) => [r.dimensionId, r.parameterId])),
          },
        })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const reapplied = await dbUnbind(db, contextId, dimensionId)
        set({
          bindingsByContext: {
            ...get().bindingsByContext,
            [contextId]: Object.fromEntries(reapplied.map((r) => [r.dimensionId, r.parameterId])),
          },
        })
      },
    })
  },

  async syncBindingsForContexts(contextIds) {
    if (contextIds.length === 0) return
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    const updated = await fetchBindingsMap(db, contextIds)
    set((state) => ({ bindingsByContext: { ...state.bindingsByContext, ...updated } }))
  },
}))

export function resetContextsStore(): void {
  useContextsStore.setState({ projectId: null, contexts: [], bindingsByContext: {}, generation: 0 })
}
