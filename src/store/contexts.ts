import { create } from 'zustand'
import type { Database } from '../db/client'
import {
  archiveContext as dbArchive,
  bindParameter as dbBind,
  childCountsByContext as dbChildCounts,
  ContextSymbolCollisionError,
  createContext as dbCreate,
  getContextsByIds as dbGetByIds,
  listBindings as dbListBindings,
  listContexts as dbListContexts,
  openChildCanvas as dbOpenChildCanvas,
  restoreContext as dbRestore,
  revertStaleRebind as dbRevertStale,
  setContextJustification as dbSetJustification,
  setContextSymbol as dbSetSymbol,
  unbindParameter as dbUnbind,
  type BindingRow,
  type ContextRow,
  type StaleRebindEvent,
} from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { requireDatabase } from './database'
import { enqueueIfSyncing } from './sync'

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
  // The canvas currently loaded: null = the project's root canvas, a context
  // id = that context's child canvas (issue 011). `contexts` are the contexts
  // ON this canvas (parent_id = parentId).
  parentId: string | null
  contexts: ContextRow[]
  // contextId -> number of children on its own child canvas (node/register
  // "Children" badge — SPEC §4.2/§4.3, issue 011). Recomputed on load.
  childCountByContext: Record<string, number>
  // The current recursion trail as {id, symbol} in depth order (excludes Root),
  // resolved from the URL's context-id segments — backs the breadcrumb bar
  // (SITEMAP §1/§2). Cross-canvas, so kept separate from `contexts`.
  breadcrumbs: { id: string; symbol: string }[]
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
  // Issue 009 — one field, read by both projections (SPEC invariant 6):
  // Canvas and ContextRegister each highlight/dim off this same value rather
  // than owning a local notion of "selected".
  selectedContextId: string | null
  select: (id: string | null) => void
  load: (projectId: string, parentId?: string | null) => Promise<void>
  // Issue 011 — resolve the URL's context-id path to breadcrumb {id, symbol}.
  loadBreadcrumbs: (contextPath: readonly string[]) => Promise<void>
  // Issue 011 — seed/reconcile a context's child canvas (idempotent). Returns
  // the stale parent-rebind events for the child canvas's warning banner.
  openChildCanvas: (parentContextId: string) => Promise<StaleRebindEvent[]>
  // Issue 011 — the stale-rebind banner's Undo: restore the child dimension to
  // the parameter it refined and re-insert the retired sub-bindings, then
  // reload the current canvas so the register/canvas reflect it.
  revertStale: (event: StaleRebindEvent) => Promise<void>
  create: () => Promise<ContextRow | null>
  // Issue 010 — archive a context (undoable). Backs the compose exit path's
  // "Discard draft α" status-line action; the same soft-delete as create()'s
  // own undo, exposed as a first-class action so it can be triggered directly.
  discard: (id: string) => Promise<void>
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
  parentId: null,
  contexts: [],
  childCountByContext: {},
  breadcrumbs: [],
  bindingsByContext: {},
  generation: 0,
  selectedContextId: null,

  select(id) {
    set({ selectedContextId: id })
  },

  async loadBreadcrumbs(contextPath) {
    if (contextPath.length === 0) {
      set({ breadcrumbs: [] })
      return
    }
    const db = requireDatabase()
    const rows = await dbGetByIds(db, contextPath)
    set({ breadcrumbs: rows.map((r) => ({ id: r.id, symbol: r.symbol })) })
  },

  async openChildCanvas(parentContextId) {
    const db = requireDatabase()
    const { stale } = await dbOpenChildCanvas(db, parentContextId)
    return stale
  },

  async revertStale(event) {
    const { projectId, parentId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    await dbRevertStale(db, event)
    const contexts = await dbListContexts(db, projectId, parentId)
    const bindingsByContext = await fetchBindingsMap(db, contexts.map((c) => c.id))
    set({ contexts, bindingsByContext })
    // Issue 073 — best-effort: re-syncs the sub-bindings this banner's Undo
    // re-inserts (event.retiredBindings — previously-existing rows, so
    // 'update', not 'upsert'). NOT wired here: the child dimension's own
    // sourceParamId/name change this same event reverts (the `dimensions`
    // table) — that mutation is triggered by openChildCanvas, which is not in
    // this store's Part 1 wiring list, so neither side of that pair is
    // synced yet (flagged in the 073 pt1 report for review).
    for (const b of event.retiredBindings) {
      enqueueIfSyncing('bindings', b.id, 'update', b)
    }
  },

  async load(projectId, parentId = null) {
    const db = requireDatabase()
    // Set synchronously, before any await (issue 007 CI bug, real root
    // cause): create() etc. read get().projectId internally rather than
    // taking it as an argument, so if it were only set after this
    // function's own DB round-trip, a mutation fired very soon after mount
    // (ContextRegister's own load() effect) could run while projectId was
    // still null and silently no-op — no error, since create()'s guard
    // just returns null. Reproduced on CI (slow enough to lose the race
    // every time) but never locally (load() always won there).
    set({ projectId, parentId, selectedContextId: null })
    const gen = get().generation
    const contexts = await dbListContexts(db, projectId, parentId)
    const bindingsByContext = await fetchBindingsMap(
      db,
      contexts.map((c) => c.id),
    )
    const childCountByContext = await dbChildCounts(db, projectId, parentId)
    if (get().generation !== gen) return
    set({ contexts, bindingsByContext, childCountByContext })
  },

  async create() {
    const { projectId, parentId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    const row = await dbCreate(db, projectId, parentId)
    const contexts = await dbListContexts(db, projectId, parentId)
    set({ contexts, bindingsByContext: { ...get().bindingsByContext, [row.id]: {} } })
    enqueueIfSyncing('contexts', row.id, 'upsert', row)
    useCommandLogStore.getState().push({
      label: `create context ${row.symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        await dbArchive(db, row.id)
        set({ contexts: await dbListContexts(db, projectId, parentId) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        await dbRestore(db, row.id)
        set({
          contexts: await dbListContexts(db, projectId, parentId),
          bindingsByContext: { ...get().bindingsByContext, [row.id]: get().bindingsByContext[row.id] ?? {} },
        })
      },
    })
    return row
  },

  async discard(id) {
    const { projectId, parentId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const symbol = get().contexts.find((c) => c.id === id)?.symbol ?? id
    set({ generation: get().generation + 1 })
    const archived = await dbArchive(db, id)
    set({ contexts: await dbListContexts(db, projectId, parentId), selectedContextId: null })
    enqueueIfSyncing('contexts', archived.id, 'delete', archived)
    useCommandLogStore.getState().push({
      label: `discard draft ${symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        await dbRestore(db, id)
        set({ contexts: await dbListContexts(db, projectId, parentId) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        await dbArchive(db, id)
        set({ contexts: await dbListContexts(db, projectId, parentId), selectedContextId: null })
      },
    })
  },

  async setSymbol(id, symbol) {
    const { projectId, parentId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    const previousSymbol = get().contexts.find((c) => c.id === id)?.symbol ?? symbol
    try {
      set({ generation: get().generation + 1 })
      const updated = await dbSetSymbol(db, projectId, id, symbol)
      set({ contexts: await dbListContexts(db, projectId, parentId) })
      enqueueIfSyncing('contexts', updated.id, 'update', updated)
      useCommandLogStore.getState().push({
        label: `rename ${previousSymbol} to ${symbol}`,
        async undo() {
          set({ generation: get().generation + 1 })
          await dbSetSymbol(db, projectId, id, previousSymbol)
          set({ contexts: await dbListContexts(db, projectId, parentId) })
        },
        async redo() {
          set({ generation: get().generation + 1 })
          await dbSetSymbol(db, projectId, id, symbol)
          set({ contexts: await dbListContexts(db, projectId, parentId) })
        },
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof ContextSymbolCollisionError) return { ok: false, reason: err.message }
      throw err
    }
  },

  async setJustification(id, text) {
    const { projectId, parentId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousText = get().contexts.find((c) => c.id === id)?.justification ?? ''
    const symbol = get().contexts.find((c) => c.id === id)?.symbol ?? id
    set({ generation: get().generation + 1 })
    const updated = await dbSetJustification(db, id, text)
    set({ contexts: await dbListContexts(db, projectId, parentId) })
    enqueueIfSyncing('contexts', updated.id, 'update', updated)
    useCommandLogStore.getState().push({
      label: `edit justification for ${symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        await dbSetJustification(db, id, previousText)
        set({ contexts: await dbListContexts(db, projectId, parentId) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        await dbSetJustification(db, id, text)
        set({ contexts: await dbListContexts(db, projectId, parentId) })
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
    // Issue 073 Subtlety A — bindParameter upserts on the natural key
    // (contextId, dimensionId), reusing a stable row id across every rebind
    // of the SAME pair (db/mutations.ts:618-639). 'upsert' only for a
    // genuinely new pair (no previous live binding for this dimension on this
    // context); every subsequent rebind of that pair must be 'update', else
    // the server's `ON CONFLICT (id) DO NOTHING` silently no-ops it (the
    // 066-class bug).
    const bindingRow = rows.find((r) => r.dimensionId === dimensionId)
    if (bindingRow) {
      enqueueIfSyncing('bindings', bindingRow.id, previousParameterId === null ? 'upsert' : 'update', bindingRow)
    }
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
    // unbindParameter tombstones the binding (deleted_at) then returns the
    // still-live set, which excludes it — read the row back first so the
    // 'delete' envelope has a real rowId/payload (issue 073).
    const target = (await dbListBindings(db, contextId)).find((r) => r.dimensionId === dimensionId)
    set({ generation: get().generation + 1 })
    const rows = await dbUnbind(db, contextId, dimensionId)
    set({
      bindingsByContext: {
        ...get().bindingsByContext,
        [contextId]: Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId])),
      },
    })
    if (target) enqueueIfSyncing('bindings', target.id, 'delete', target)
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
  useContextsStore.setState({
    projectId: null,
    parentId: null,
    contexts: [],
    childCountByContext: {},
    breadcrumbs: [],
    bindingsByContext: {},
    generation: 0,
    selectedContextId: null,
  })
}
