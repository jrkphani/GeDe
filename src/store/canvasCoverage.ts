import { create } from 'zustand'

// 089-D3 P4 — the canvas-only slice tracking whether the coverage TWIN node is
// open beside the Design core (issue 012, on the `?d3rf` canvas). `v` (or the
// header toggle) opens the twin — an edge-connected CoverageMatrix node — instead
// of the old route swap that REPLACED the ring. The twin is a SINGLETON per
// canvas, so this is a plain boolean. Camera movement is intentionally absent:
// opening/collapsing analytical content never overrides the user's viewport.
//
// The `v` handler lives in DesignRegisterBody and the twin renders in
// WorkspaceCanvas — SEPARATE React trees — so the open state must be a store, not
// component state (the P2/P3 cross-tree lesson).
//
// UNLIKE P3's satellite (a summary STUB, forced by the singleton contexts store),
// the twin is a FULLY-LIVE node: CoverageMatrix is read-only + fully derived and
// reads the SAME current-canvas stores the ring reads — no second canvas scope,
// so no multi-canvas refactor is needed.

interface CanvasCoverageState {
  // Whether the coverage twin node is mounted beside the core.
  open: boolean
  // `v` / header toggle — open ↔ collapse.
  toggle: () => void
  // Collapse (unmount) the twin.
  collapse: () => void
  // Seed the open state (e.g. from a `?view=coverage` deep-link on canvas-nav).
  setOpen: (open: boolean) => void
}

export const useCanvasCoverageStore = create<CanvasCoverageState>()((set, get) => ({
  open: false,

  setOpen(open) {
    if (get().open === open) return
    set({ open })
  },

  toggle() {
    get().setOpen(!get().open)
  },

  collapse() {
    get().setOpen(false)
  },
}))

// Session-scoped test/reset seam + the per-canvas-nav reset. Mirrors
// resetCanvasSatellites / resetCanvasCompose. WorkspaceCanvas calls this (or
// setOpen from the route's view) when the active canvas changes: the twin node
// has a stable id and never unmounts, so every per-navigation reset must be
// explicit (P2's hoveredMark lesson).
export function resetCanvasCoverage(): void {
  useCanvasCoverageStore.setState({ open: false })
}
