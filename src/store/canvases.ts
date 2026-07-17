import { create } from 'zustand'
import {
  archiveCanvas as dbArchiveCanvas,
  archiveCanvasCascade,
  createCanvas as dbCreateCanvas,
  listCanvases as dbListCanvases,
  renameCanvas as dbRenameCanvas,
  reorderCanvas as dbReorderCanvas,
  restoreCanvas as dbRestoreCanvas,
  restoreCanvasCascade,
  RootCanvasFloorError,
  type CanvasCascadeResult,
  type CanvasRow,
} from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { requireDatabase } from './database'
import { useStatusStore } from './status'
import { enqueueIfSyncing, useSyncStore } from './sync'

// Issue 090 Phase 4b — the root-canvas switcher's store, the sibling of
// contexts.ts/projects.ts. A project holds N root canvases in a Design lane
// (sort order); this store owns which one is selected and the create / rename /
// reorder / (cascading, undoable) delete gestures over them. Every mutating
// action pushes its inverse onto the shared command log (issue 006) and, when
// signed in, enqueues the matching sync op (issue 073 op-selection rule:
// new row → upsert, delete → delete, restore → update).

// Issue 075 Part B pattern — the `useSyncStore.canvasesAppliedAt` subscription
// below (mirrors dimensions.ts's own module-level syncUnsubscribe): re-`load()`
// re-subscribes rather than accumulating a duplicate listener.
let syncUnsubscribe: (() => void) | null = null

// Keep the current selection if it still exists, else fall back to the first
// canvas (or null when the lane is empty). Shared by every relist.
function reselect(rows: CanvasRow[], current: string | null): string | null {
  if (current !== null && rows.some((c) => c.id === current)) return current
  return rows[0]?.id ?? null
}

interface CanvasesState {
  projectId: string | null
  canvases: CanvasRow[]
  selectedCanvasId: string | null
  // Mirrors contexts.ts's generation counter (issue 007): every mutating action
  // bumps this synchronously before awaiting anything; load() (and the delta
  // relist) discard their result if the generation moved while in flight, so a
  // local mutation always wins over a stale/streamed read.
  generation: number
  select: (id: string) => void
  load: (projectId: string) => Promise<void>
  create: (name?: string) => Promise<CanvasRow | null>
  rename: (id: string, name: string) => Promise<void>
  reorder: (id: string, toIndex: number) => Promise<void>
  archive: (id: string) => Promise<void>
}

export const useCanvasesStore = create<CanvasesState>()((set, get) => ({
  projectId: null,
  canvases: [],
  selectedCanvasId: null,
  generation: 0,

  select(id) {
    set({ selectedCanvasId: id })
  },

  async load(projectId) {
    const db = requireDatabase()
    set({ projectId })
    const gen = get().generation
    const canvases = await dbListCanvases(db, projectId)
    if (get().generation !== gen) return
    set({ canvases, selectedCanvasId: reselect(canvases, get().selectedCanvasId) })

    // Live relist off this store's own ground-truth signal (mirrors
    // dimensions.ts's refresh wiring) — a canvases delta streaming in after
    // this resolved re-renders without a remount. Reuses the same generation
    // guard so an in-flight local mutation always wins.
    syncUnsubscribe?.()
    syncUnsubscribe = useSyncStore.subscribe((state, prevState) => {
      if (state.canvasesAppliedAt === prevState.canvasesAppliedAt) return
      const { projectId: currentProjectId } = get()
      if (currentProjectId === null) return
      const genAtStart = get().generation
      void dbListCanvases(requireDatabase(), currentProjectId).then((rows) => {
        if (get().generation !== genAtStart) return
        set({ canvases: rows, selectedCanvasId: reselect(rows, get().selectedCanvasId) })
      })
    })
  },

  async create(name) {
    const { projectId } = get()
    if (projectId === null) return null
    const db = requireDatabase()
    set({ generation: get().generation + 1 })
    const row = await dbCreateCanvas(db, projectId, name)
    set({ canvases: await dbListCanvases(db, projectId), selectedCanvasId: row.id })
    // Issue 073 op-selection — a genuinely new row → 'upsert'.
    enqueueIfSyncing('canvases', row.id, 'upsert', row)
    useCommandLogStore.getState().push({
      label: `create canvas ${row.name ?? ''}`.trimEnd(),
      async undo() {
        set({ generation: get().generation + 1 })
        // An empty, just-created canvas has nothing on it — archive (no
        // cascade) is its exact inverse.
        const archived = await dbArchiveCanvas(db, row.id)
        const canvases = await dbListCanvases(db, projectId)
        set({ canvases, selectedCanvasId: reselect(canvases, get().selectedCanvasId) })
        enqueueIfSyncing('canvases', archived.id, 'delete', archived)
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const restored = await dbRestoreCanvas(db, row.id)
        set({ canvases: await dbListCanvases(db, projectId), selectedCanvasId: restored.id })
        // Restore of an already-synced row clears deleted_at → 'update', never
        // 'upsert' (the 066-class no-op the op-selection rule warns about).
        enqueueIfSyncing('canvases', restored.id, 'update', restored)
      },
    })
    return row
  },

  async rename(id, name) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const previousName = get().canvases.find((c) => c.id === id)?.name ?? ''
    set({ generation: get().generation + 1 })
    const renamed = await dbRenameCanvas(db, id, name)
    set({ canvases: await dbListCanvases(db, projectId) })
    enqueueIfSyncing('canvases', renamed.id, 'update', renamed)
    useCommandLogStore.getState().push({
      label: `rename canvas to "${name}"`,
      async undo() {
        set({ generation: get().generation + 1 })
        await dbRenameCanvas(db, id, previousName)
        set({ canvases: await dbListCanvases(db, projectId) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        await dbRenameCanvas(db, id, name)
        set({ canvases: await dbListCanvases(db, projectId) })
      },
    })
  },

  async reorder(id, toIndex) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const before = get().canvases
    const fromIndex = before.findIndex((c) => c.id === id)
    set({ generation: get().generation + 1 })
    const after = await dbReorderCanvas(db, projectId, id, toIndex)
    set({ canvases: after })
    // reorderCanvas rewrites `sort` on every sibling that actually moved (same
    // rewriteSort cascade as reorderDimension) — enqueue an 'update' for each
    // row whose previous sort disagrees with its new index (issue 073).
    const beforeById = new Map(before.map((c) => [c.id, c]))
    after.forEach((row, index) => {
      const prevSort = beforeById.get(row.id)?.sort ?? -1
      if (prevSort !== index) enqueueIfSyncing('canvases', row.id, 'update', row)
    })
    useCommandLogStore.getState().push({
      label: 'reorder canvas',
      async undo() {
        set({ generation: get().generation + 1 })
        set({ canvases: await dbReorderCanvas(db, projectId, id, fromIndex) })
      },
      async redo() {
        set({ generation: get().generation + 1 })
        set({ canvases: await dbReorderCanvas(db, projectId, id, toIndex) })
      },
    })
  },

  async archive(id) {
    const { projectId } = get()
    if (projectId === null) return
    const db = requireDatabase()
    const name = get().canvases.find((c) => c.id === id)?.name ?? 'canvas'
    let captured: CanvasCascadeResult
    try {
      set({ generation: get().generation + 1 })
      captured = await archiveCanvasCascade(db, id)
    } catch (err) {
      // The last live root canvas can't be deleted (SPEC floor). No modal in
      // this app — narrate the refusal on the status bar and no-op.
      if (err instanceof RootCanvasFloorError) {
        useStatusStore.getState().announce(err.message)
        return
      }
      throw err
    }
    const canvases = await dbListCanvases(db, projectId)
    set({ canvases, selectedCanvasId: reselect(canvases, get().selectedCanvasId) })
    // The cascade soft-deletes the canvas AND every row on it — enqueue a
    // 'delete' per row (canvas + its dimensions/contexts/bindings), exactly as
    // dimensions.ts enqueues cascaded bindings.
    enqueueCascade(captured, 'delete')
    useCommandLogStore.getState().push({
      label: `delete canvas "${name}"`,
      async undo() {
        set({ generation: get().generation + 1 })
        const restored = await restoreCanvasCascade(db, captured)
        const rows = await dbListCanvases(db, projectId)
        set({ canvases: rows, selectedCanvasId: restored.canvas.id })
        // Restore revives already-synced rows → 'update' per row.
        enqueueCascade(restored, 'update')
      },
      async redo() {
        set({ generation: get().generation + 1 })
        const recaptured = await archiveCanvasCascade(db, id)
        const rows = await dbListCanvases(db, projectId)
        set({ canvases: rows, selectedCanvasId: reselect(rows, get().selectedCanvasId) })
        enqueueCascade(recaptured, 'delete')
      },
    })
    // The repo's no-modal destructive idiom (mirrors projects/dimensions):
    // the delete is already done; a quiet status line offers an inline Undo.
    useStatusStore.getState().announce(`Deleted "${name}"`, {
      label: 'Undo',
      run: () => useCommandLogStore.getState().undo(),
    })
  },
}))

// Enqueue the same sync op for every row a cascade touched — the canvas itself
// plus its dimensions, contexts, and bindings (verbatim rows from the cascade
// result). 'delete' on archive, 'update' on restore (issue 073).
function enqueueCascade(result: CanvasCascadeResult, op: 'delete' | 'update'): void {
  enqueueIfSyncing('canvases', result.canvas.id, op, result.canvas)
  for (const d of result.dimensions) enqueueIfSyncing('dimensions', d.id, op, d)
  for (const c of result.contexts) enqueueIfSyncing('contexts', c.id, op, c)
  for (const b of result.bindings) enqueueIfSyncing('bindings', b.id, op, b)
}

export function resetCanvasesStore(): void {
  syncUnsubscribe?.()
  syncUnsubscribe = null
  useCanvasesStore.setState({
    projectId: null,
    canvases: [],
    selectedCanvasId: null,
    generation: 0,
  })
}
