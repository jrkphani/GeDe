import { create } from 'zustand'

// 089-D3 P3 — the canvas-only slice tracking which child canvases are OPEN as
// edge-connected satellites beside the Design core (issue 011 recursion, on the
// `?d3rf` canvas). A drill-in ("Open ▸" in the register / double-click a ring
// node) opens the context's child canvas as a SUMMARY satellite node + a
// parent→child edge, pans to it, and collapse unmounts it.
//
// The register/ring bodies (which trigger the open) and the WorkspaceCanvas
// (which renders the satellites + edges) are SEPARATE React trees, so the open
// set cannot live in component state — it lives here (P2's cross-tree lesson: a
// shared draft that two node bodies touch belongs in a store).
//
// STUB SCOPE (owner, 2026-07-19): a satellite is a SUMMARY node (parent symbol +
// child count), NOT a second live {register+ring} core — the contexts store is a
// hard singleton (one canvasId/contexts/selection), so two live cores can't
// coexist without a central multi-canvas refactor. Promoting a stub to a live
// child core is the tracked follow-up in issue 089. Deep drill-in still works via
// the satellite's "Enter ▸" (the existing navigate that re-scopes the core).

// The satellite node's stable React Flow id, namespaced off its parent context id
// so it never collides with a context/table/prop node id. Stable across renders
// so the reconcile carries measured dims and never remounts (P2 stable-id lesson).
export function satelliteNodeId(parentContextId: string): string {
  return `satellite:${parentContextId}`
}

interface CanvasSatellitesState {
  // Parent context ids with an open satellite, in open order (drives the
  // rightward vertical stack in clusterLayout).
  open: string[]
  // The satellite node id to pan/zoom to on the next frame, or null. A one-shot:
  // WorkspaceCanvas pans to it then calls consumeFocus() so a later reconcile
  // doesn't yank the viewport back.
  focus: string | null
  // Open (or re-focus) the child canvas of `parentContextId` as a satellite.
  // Idempotent on `open` (no duplicate); always re-targets the pan.
  openSatellite: (parentContextId: string) => void
  // Collapse (unmount) the satellite for `parentContextId`. Clears `focus` if it
  // pointed at the collapsed node so the viewport never pans to a gone node.
  collapse: (parentContextId: string) => void
  // Clear the one-shot pan target after the viewport has panned to it.
  consumeFocus: () => void
}

export const useCanvasSatellitesStore = create<CanvasSatellitesState>()((set, get) => ({
  open: [],
  focus: null,

  openSatellite(parentContextId) {
    const { open } = get()
    const focus = satelliteNodeId(parentContextId)
    if (open.includes(parentContextId)) {
      // Already open — re-target the pan, leave the set (and its order) untouched.
      set({ focus })
      return
    }
    set({ open: [...open, parentContextId], focus })
  },

  collapse(parentContextId) {
    const { open, focus } = get()
    const nodeId = satelliteNodeId(parentContextId)
    set({
      open: open.filter((id) => id !== parentContextId),
      focus: focus === nodeId ? null : focus,
    })
  },

  consumeFocus() {
    if (get().focus !== null) set({ focus: null })
  },
}))

// Session-scoped test/reset seam + the per-canvas-nav reset. Mirrors
// resetCanvasCompose / resetActiveLane. WorkspaceCanvas calls this when the active
// canvas changes (deep-link / ⌘ / breadcrumb): the satellite nodes have stable
// ids and never unmount, so every per-navigation reset must be explicit (P2's
// hoveredMark lesson — a stable id means there is no unmount to rely on).
export function resetCanvasSatellites(): void {
  useCanvasSatellitesStore.setState({ open: [], focus: null })
}
