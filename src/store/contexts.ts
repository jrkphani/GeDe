import { create } from 'zustand'
import type { Database } from '../db/client'
import {
  bindParameter as dbBind,
  ContextSymbolCollisionError,
  createContext as dbCreate,
  listBindings as dbListBindings,
  listContexts as dbListContexts,
  setContextJustification as dbSetJustification,
  setContextSymbol as dbSetSymbol,
  unbindParameter as dbUnbind,
  type BindingRow,
  type ContextRow,
} from '../db/mutations'
import { requireDatabase } from './database'

// Root-canvas contexts for the currently open project (child canvases: 011).

async function fetchBindingsMap(
  db: Database,
  contextRows: ContextRow[],
): Promise<Record<string, Record<string, string>>> {
  const map: Record<string, Record<string, string>> = {}
  for (const c of contextRows) {
    const rows: BindingRow[] = await dbListBindings(db, c.id)
    map[c.id] = Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId]))
  }
  return map
}

interface ContextsState {
  projectId: string | null
  contexts: ContextRow[]
  // contextId -> dimensionId -> parameterId
  bindingsByContext: Record<string, Record<string, string>>
  load: (projectId: string) => Promise<void>
  create: () => Promise<ContextRow | null>
  setSymbol: (id: string, symbol: string) => Promise<{ ok: boolean; reason?: string }>
  setJustification: (id: string, text: string) => Promise<void>
  bind: (contextId: string, dimensionId: string, parameterId: string) => Promise<void>
  unbind: (contextId: string, dimensionId: string) => Promise<void>
}

export const useContextsStore = create<ContextsState>()((set, get) => ({
  projectId: null,
  contexts: [],
  bindingsByContext: {},

  async load(projectId) {
    const db = requireDatabase()
    const contexts = await dbListContexts(db, projectId)
    const bindingsByContext = await fetchBindingsMap(db, contexts)
    set({ projectId, contexts, bindingsByContext })
  },

  async create() {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    const row = await dbCreate(db, projectId)
    const contexts = await dbListContexts(db, projectId)
    set({ contexts, bindingsByContext: { ...get().bindingsByContext, [row.id]: {} } })
    return row
  },

  async setSymbol(id, symbol) {
    const { projectId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    try {
      await dbSetSymbol(db, projectId, id, symbol)
      set({ contexts: await dbListContexts(db, projectId) })
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
    await dbSetJustification(db, id, text)
    set({ contexts: await dbListContexts(db, projectId) })
  },

  async bind(contextId, dimensionId, parameterId) {
    const db = requireDatabase()
    const rows = await dbBind(db, contextId, dimensionId, parameterId)
    set({
      bindingsByContext: {
        ...get().bindingsByContext,
        [contextId]: Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId])),
      },
    })
  },

  async unbind(contextId, dimensionId) {
    const db = requireDatabase()
    const rows = await dbUnbind(db, contextId, dimensionId)
    set({
      bindingsByContext: {
        ...get().bindingsByContext,
        [contextId]: Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId])),
      },
    })
  },
}))

export function resetContextsStore(): void {
  useContextsStore.setState({ projectId: null, contexts: [], bindingsByContext: {} })
}
