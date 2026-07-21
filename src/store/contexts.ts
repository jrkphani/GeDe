import { create } from 'zustand'
import type { Database } from '../db/client'
import {
  archiveContext as dbArchive,
  bindParameter as dbBind,
  childCountsByContext as rawChildCounts,
  ContextSymbolCollisionError,
  createContext as dbCreate,
  getContextsByIds as dbGetByIds,
  listBindings as dbListBindings,
  listContexts as rawListContexts,
  listDimensions as rawListDimensions,
  openChildCanvas as dbOpenChildCanvas,
  resolveCanvasScope,
  resolveReadCanvasId,
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
import { enqueueIfSyncing, useSyncStore } from './sync'

// Issue 090 Phase 4b — the reads below now key on the real `canvas_id` FK,
// threaded in via load()'s `canvasId` argument (null ⇒ the project's default
// root canvas — the tolerant pre-090 default the raw list functions already
// honor). rawListContexts/rawListDimensions/rawChildCounts each accept a
// `canvasId | null`, so the store calls them directly — the Phase 4a selector
// seam (which resolved a context id to a child canvas) is gone. The one place
// that still resolves a context → its child canvas is openChildCanvas's
// pre-seed snapshot below (resolveReadCanvasId).

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

// Issue 075 Part B — the shared read shared by load() and the delta-driven
// re-read below, so the two never drift out of sync with each other.
async function readCanvas(
  db: Database,
  projectId: string,
  canvasId: string | null,
): Promise<{
  contexts: ContextRow[]
  bindingsByContext: Record<string, Record<string, string>>
  childCountByContext: Record<string, number>
}> {
  const contexts = await rawListContexts(db, projectId, canvasId)
  const bindingsByContext = await fetchBindingsMap(
    db,
    contexts.map((c) => c.id),
  )
  const childCountByContext = await rawChildCounts(db, projectId, canvasId)
  return { contexts, bindingsByContext, childCountByContext }
}

export interface ContextsState {
  projectId: string | null
  // Issue 090 Phase 4b — the canvas currently loaded, keyed on the real
  // `canvas_id` FK (null ⇒ the project's default root canvas). `contexts` are
  // the contexts ON this canvas.
  canvasId: string | null
  // The parent context of the current canvas (== the pre-090 `parentId`):
  // null on a root canvas, the owning context on a child canvas (issue 011).
  // RETAINED (not superseded by canvasId) because create() still needs it to
  // stamp `parent_id` and derive a child symbol (α1, α2 — SPEC §3).
  parentContextId: string | null
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
  load: (projectId: string, canvasId?: string | null, parentContextId?: string | null) => Promise<void>
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

export function createContextsStore() {
  // Issue 075 Part B — the `useSyncStore.contextsAppliedAt`/`bindingsAppliedAt`
  // subscription below (mirrors src/store/projects.ts's own module-level
  // syncUnsubscribe pattern, 072): re-`load()` re-subscribes rather than
  // accumulating a duplicate listener per canvas navigation. Issue 100 Phase A
  // moved it inside the factory so it is a per-instance closure var.
  let syncUnsubscribe: (() => void) | null = null

  const useStore = create<ContextsState>()((set, get) => ({
  projectId: null,
  canvasId: null,
  parentContextId: null,
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
    // Issue 073 pt2 — openChildCanvas seeds/reconciles child-canvas dimensions
    // (brand-new rows on first open; sourceParamId/name/sort rewrites on a
    // parent re-bind/reorder/rename, db/mutations.ts's own openChildCanvas)
    // and, on a stale re-bind, hard-deletes the child's own retired
    // sub-bindings — none of that ever reached the write outbox. Snapshot
    // "before" so a genuinely NEW child dimension gets 'upsert' and an
    // existing one whose sourceParamId/name/sort actually changed gets
    // 'update' (Subtlety A/B) — `stale` alone only reports the rebind case,
    // never the first-seed or parent-reorder/rename cases.
    const [parent] = await dbGetByIds(db, [parentContextId])
    // The child canvas of `parentContextId` may not exist yet (first open) —
    // resolveReadCanvasId returns null then, so `before` is [] and every
    // seeded dimension below is correctly treated as new ('upsert').
    const childCanvasId = parent
      ? await resolveReadCanvasId(db, parent.projectId, parentContextId)
      : null
    const before =
      parent && childCanvasId ? await rawListDimensions(db, parent.projectId, childCanvasId) : []
    const { dimensions: after, stale } = await dbOpenChildCanvas(db, parentContextId)
    const beforeById = new Map(before.map((d) => [d.id, d]))
    for (const row of after) {
      const prev = beforeById.get(row.id)
      if (!prev) {
        enqueueIfSyncing('dimensions', row.id, 'upsert', row)
      } else if (
        prev.sourceParamId !== row.sourceParamId ||
        prev.name !== row.name ||
        prev.sort !== row.sort
      ) {
        enqueueIfSyncing('dimensions', row.id, 'update', row)
      }
    }
    // A stale rebind hard-deletes the child's retired sub-bindings locally
    // (db.delete, not a tombstone — db/mutations.ts's own openChildCanvas) —
    // enqueue 'delete' so the server marks the same rows gone; revertStale's
    // own 'revive' (below) is the one path that ever un-tombstones them.
    for (const event of stale) {
      for (const b of event.retiredBindings) {
        enqueueIfSyncing('bindings', b.id, 'delete', b)
      }
    }
    return stale
  },

  async revertStale(event) {
    const { projectId, canvasId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    await dbRevertStale(db, event)
    const contexts = await rawListContexts(db, projectId, canvasId)
    const bindingsByContext = await fetchBindingsMap(db, contexts.map((c) => c.id))
    set({ contexts, bindingsByContext })
    // Issue 073 pt1 / 094 — re-syncs the sub-bindings this banner's Undo
    // re-inserts (event.retiredBindings). openChildCanvas tombstoned these rows
    // server-side via a wire 'delete' (they pointed at the retired
    // sub-parameter), so resurrecting them is a 'revive', NOT an 'update': a
    // plain 'update' can't clear deleted_at server-side and checkTenancy rejects
    // a tombstoned target as unknown_entity — the 094 bug (the re-insert would
    // be silently dropped).
    for (const b of event.retiredBindings) {
      enqueueIfSyncing('bindings', b.id, 'revive', b)
    }
    // Issue 073 pt2 — the OTHER half of the pair pt1 flagged as unwired:
    // revertStaleRebind ALSO reverts the child dimension's own
    // sourceParamId/name back to what it was before the parent re-bind (the
    // `dimensions` table). Read the row back (revertStaleRebind returns void)
    // and enqueue the 'update' — an edit of an already-synced row, never
    // 'upsert'.
    const revertedDim = (await rawListDimensions(db, projectId, canvasId)).find(
      (d) => d.id === event.childDimensionId,
    )
    if (revertedDim) enqueueIfSyncing('dimensions', revertedDim.id, 'update', revertedDim)
  },

  async load(projectId, canvasId = null, parentContextId) {
    const db = requireDatabase()
    // Set projectId synchronously, before any await (issue 007 CI bug, real
    // root cause): create() etc. read get().projectId internally rather than
    // taking it as an argument, so if it were only set after this function's
    // own DB round-trip, a mutation fired very soon after mount
    // (ContextRegister's own load() effect) could run while projectId was
    // still null and silently no-op. Reproduced on CI, never locally.
    set({ projectId, selectedContextId: null })
    // Resolve the navigation selector to its concrete canvas; derive
    // parentContextId (for create()'s parent stamping + child symbol) from the
    // resolved canvas when the caller didn't pass one — this is what makes the
    // un-migrated DesignSurface drill-in (which passes only the context id)
    // still create child contexts correctly.
    const canvas = await resolveCanvasScope(db, projectId, canvasId)
    const resolvedCanvasId = canvas?.id ?? null
    set({ canvasId: resolvedCanvasId, parentContextId: parentContextId ?? canvas?.parentContextId ?? null })
    const gen = get().generation
    const result = await readCanvas(db, projectId, resolvedCanvasId)
    if (get().generation !== gen) return
    set(result)

    // Issue 075 Part B — load() only ever ran once per canvas-open, so a
    // contexts OR bindings delta that streamed in (or that 075A's own
    // FK-retry landed) AFTER this resolved never rendered without a
    // remount. Re-read off this store's own ground-truth signals instead,
    // mirroring 062/067/072's own refresh wiring. Reuses the SAME
    // generation guard load() itself relies on, so an in-progress local
    // mutation (which bumps `generation` before awaiting anything) always
    // wins over a delta-triggered reload that started before it — no
    // clobbering of in-flight local edits, and no lost `selectedContextId`
    // either, since only `contexts`/`bindingsByContext`/`childCountByContext`
    // are ever overwritten here.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (
        state.contextsAppliedAt === prevState.contextsAppliedAt &&
        state.bindingsAppliedAt === prevState.bindingsAppliedAt
      ) {
        return
      }
      const { projectId: currentProjectId, canvasId: currentCanvasId } = get()
      if (currentProjectId === null) return
      const genAtStart = get().generation
      void readCanvas(requireDatabase(), currentProjectId, currentCanvasId).then((fresh) => {
        if (get().generation !== genAtStart) return
        set(fresh)
      })
    })
  },

  async create() {
    const { projectId, canvasId, parentContextId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    // parentContextId stamps `parent_id` + drives the child symbol; canvasId
    // (as targetCanvasId) names WHICH root canvas a root context lands on. On a
    // child canvas createContext resolves the parent's own child canvas and
    // ignores targetCanvasId (db/mutations.ts's createContext).
    const row = await dbCreate(db, projectId, parentContextId, canvasId ?? undefined)
    const contexts = await rawListContexts(db, projectId, canvasId)
    set({ contexts, bindingsByContext: { ...get().bindingsByContext, [row.id]: {} } })
    enqueueIfSyncing('contexts', row.id, 'upsert', row)
    useCommandLogStore.getState().push({
      label: `create context ${row.symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        const archived = await dbArchive(db, row.id)
        set({ contexts: await rawListContexts(db, projectId, canvasId) })
        // Issue 094 — reversal of the forward create's 'upsert' is a tombstone
        // → 'delete'.
        enqueueIfSyncing('contexts', archived.id, 'delete', archived)
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const restored = await dbRestore(db, row.id)
        set({
          contexts: await rawListContexts(db, projectId, canvasId),
          bindingsByContext: { ...get().bindingsByContext, [row.id]: get().bindingsByContext[row.id] ?? {} },
        })
        // Issue 094 — redo re-inserts the row the undo tombstoned → 'revive'
        // (un-tombstones server-side; a plain 'update' can't clear deleted_at).
        enqueueIfSyncing('contexts', restored.id, 'revive', restored)
      },
    })
    return row
  },

  async discard(id) {
    const { projectId, canvasId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const symbol = get().contexts.find((c) => c.id === id)?.symbol ?? id
    set({ generation: get().generation + 1 })
    const archived = await dbArchive(db, id)
    set({ contexts: await rawListContexts(db, projectId, canvasId), selectedContextId: null })
    enqueueIfSyncing('contexts', archived.id, 'delete', archived)
    useCommandLogStore.getState().push({
      label: `discard draft ${symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        const restored = await dbRestore(db, id)
        set({ contexts: await rawListContexts(db, projectId, canvasId) })
        // Issue 094 — reversal of discard's forward 'delete' resurrects the
        // tombstoned row → 'revive' (a plain 'update' can't clear deleted_at).
        enqueueIfSyncing('contexts', restored.id, 'revive', restored)
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const archived = await dbArchive(db, id)
        set({ contexts: await rawListContexts(db, projectId, canvasId), selectedContextId: null })
        enqueueIfSyncing('contexts', archived.id, 'delete', archived)
      },
    })
  },

  async setSymbol(id, symbol) {
    const { projectId, canvasId } = get()
    if (projectId === null) return { ok: false }
    const db = requireDatabase()
    const previousSymbol = get().contexts.find((c) => c.id === id)?.symbol ?? symbol
    try {
      set({ generation: get().generation + 1 })
      const updated = await dbSetSymbol(db, projectId, id, symbol)
      set({ contexts: await rawListContexts(db, projectId, canvasId) })
      enqueueIfSyncing('contexts', updated.id, 'update', updated)
      useCommandLogStore.getState().push({
        label: `rename ${previousSymbol} to ${symbol}`,
        async undo() {
          set({ generation: get().generation + 1 })
          const reverted = await dbSetSymbol(db, projectId, id, previousSymbol)
          set({ contexts: await rawListContexts(db, projectId, canvasId) })
          // Issue 094 — an edit of an already-synced row → 'update'.
          enqueueIfSyncing('contexts', reverted.id, 'update', reverted)
        },
        async redo() {
          set({ generation: get().generation + 1 })
          const reapplied = await dbSetSymbol(db, projectId, id, symbol)
          set({ contexts: await rawListContexts(db, projectId, canvasId) })
          enqueueIfSyncing('contexts', reapplied.id, 'update', reapplied)
        },
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof ContextSymbolCollisionError) return { ok: false, reason: err.message }
      throw err
    }
  },

  async setJustification(id, text) {
    const { projectId, canvasId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousText = get().contexts.find((c) => c.id === id)?.justification ?? ''
    const symbol = get().contexts.find((c) => c.id === id)?.symbol ?? id
    set({ generation: get().generation + 1 })
    const updated = await dbSetJustification(db, id, text)
    set({ contexts: await rawListContexts(db, projectId, canvasId) })
    enqueueIfSyncing('contexts', updated.id, 'update', updated)
    useCommandLogStore.getState().push({
      label: `edit justification for ${symbol}`,
      async undo() {
        set({ generation: get().generation + 1 })
        const reverted = await dbSetJustification(db, id, previousText)
        set({ contexts: await rawListContexts(db, projectId, canvasId) })
        // Issue 094 — an edit of an already-synced row → 'update'.
        enqueueIfSyncing('contexts', reverted.id, 'update', reverted)
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const reapplied = await dbSetJustification(db, id, text)
        set({ contexts: await rawListContexts(db, projectId, canvasId) })
        enqueueIfSyncing('contexts', reapplied.id, 'update', reapplied)
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
        // Issue 094 — when the forward bind created a brand-new binding (no
        // prior parameter), its reversal tombstones that row; dbUnbind returns
        // the live set (which excludes it), so read the row back FIRST for the
        // 'delete' payload (mirrors the forward unbind's own read-back).
        const removedTarget = previousParameterId
          ? null
          : (await dbListBindings(db, contextId)).find((r) => r.dimensionId === dimensionId)
        const restored = previousParameterId
          ? await dbBind(db, contextId, dimensionId, previousParameterId)
          : await dbUnbind(db, contextId, dimensionId)
        set({
          bindingsByContext: {
            ...get().bindingsByContext,
            [contextId]: Object.fromEntries(restored.map((r) => [r.dimensionId, r.parameterId])),
          },
        })
        if (previousParameterId) {
          // Re-bound the prior parameter on the SAME natural-key row (already
          // server-seen) → 'update'.
          const bindingRow = restored.find((r) => r.dimensionId === dimensionId)
          if (bindingRow) enqueueIfSyncing('bindings', bindingRow.id, 'update', bindingRow)
        } else if (removedTarget) {
          enqueueIfSyncing('bindings', removedTarget.id, 'delete', removedTarget)
        }
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
        // Issue 094 — redo re-binds `parameterId` on the SAME natural-key row.
        // When the forward bind created a BRAND-NEW binding (previousParameterId
        // === null), the undo tombstoned that row, so redo must RESURRECT it →
        // 'revive' (a plain 'update' can't clear deleted_at server-side, and an
        // 'upsert' would `ON CONFLICT (id) DO NOTHING` — the 066-class no-op).
        // When the forward bind was a REBIND (previousParameterId !== null), the
        // row stayed live throughout, so redo is a plain field edit → 'update'.
        const bindingRow = reapplied.find((r) => r.dimensionId === dimensionId)
        if (bindingRow) {
          enqueueIfSyncing('bindings', bindingRow.id, previousParameterId === null ? 'revive' : 'update', bindingRow)
        }
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
        // Issue 094 — reversal of unbind's 'delete' resurrects the SAME
        // natural-key row (tombstoned by the forward unbind) → 'revive' (a plain
        // 'update' can't clear deleted_at server-side).
        const bindingRow = restored.find((r) => r.dimensionId === dimensionId)
        if (bindingRow) enqueueIfSyncing('bindings', bindingRow.id, 'revive', bindingRow)
      },
      async redo() {
        set({ generation: get().generation + 1 })
        // Issue 094 — dbUnbind tombstones then returns the live set (excluding
        // the row), so read it back FIRST for the 'delete' payload (mirrors the
        // forward unbind).
        const target = (await dbListBindings(db, contextId)).find((r) => r.dimensionId === dimensionId)
        const reapplied = await dbUnbind(db, contextId, dimensionId)
        set({
          bindingsByContext: {
            ...get().bindingsByContext,
            [contextId]: Object.fromEntries(reapplied.map((r) => [r.dimensionId, r.parameterId])),
          },
        })
        if (target) enqueueIfSyncing('bindings', target.id, 'delete', target)
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

  function reset(): void {
    syncUnsubscribe?.()
    syncUnsubscribe = null
    useStore.setState({
      projectId: null,
      canvasId: null,
      parentContextId: null,
      contexts: [],
      childCountByContext: {},
      breadcrumbs: [],
      bindingsByContext: {},
      generation: 0,
      selectedContextId: null,
    })
  }

  function teardown(): void {
    syncUnsubscribe?.()
    syncUnsubscribe = null
  }

  return { useStore, reset, teardown }
}

// Issue 100 Phase A — the default-instance shims live in canvasStores.ts (the
// composition root); re-exported here so every existing `./contexts` import
// path keeps resolving to the same singleton it always did.
export { useContextsStore, resetContextsStore } from './canvasStores'
