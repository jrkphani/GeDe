import { create } from 'zustand'

// Issue 100 Phase D — the canvas-only slice tracking which child canvases are OPEN
// as drilled-in LIVE child cores beside the Design core (issue 011 recursion, on
// the `?d3rf` canvas). A drill-in ("Open ▸" in the register / double-click a ring
// node) opens the context's child canvas as a second LIVE {register + ring} core +
// a parent→child edge, and collapse tears it down. Opening content never moves
// the user-owned workspace camera.
//
// The register/ring bodies (which trigger the open) and the WorkspaceCanvas (which
// mounts the child cores + edges) are SEPARATE React trees, so the open set cannot
// live in component state — it lives here (P2's cross-tree lesson: a shared draft
// that two node bodies touch belongs in a store).
//
// LIVE CORES (issue 100 Phase D): the contexts/dimensions/compose stores are no
// longer singletons — Phase A/B made them factory-produced with a per-canvas
// registry (canvasStores.ts). So drilling promotes the former SUMMARY stub to a
// second live core with its OWN independent store instance, keyed by the parent
// context id; WorkspaceCanvas maps each open core to a namespaced {register + ring}
// node pair (storeCanvasId = the core's own context id) and releases the instance
// on collapse. The `open` list is a parent-aware `OpenSatellite[]` (106 item 2 —
// each entry carries the core's own contextId plus the parentCoreId it was drilled
// from), which drives per-parent column anchoring, edge origin, and cascade collapse.

// 106 item 2 — one open drilled-in child core, PARENT-AWARE. `contextId` is the
// context whose child canvas this core shows (its own store id); `parentCoreId` is
// the store id of the core it was drilled FROM — null for a direct child (drilled
// off the PRIMARY), the parent child-core's id for a grandchild. The linkage drives
// column anchoring + edge origin in clusterLayout/WorkspaceCanvas and cascade
// collapse here (arbitrary depth: a grandchild's parentCoreId is its parent's
// contextId).
export interface OpenSatellite {
  contextId: string
  parentCoreId: string | null
}

// Collect a context id + ALL its transitive descendants (children whose
// parentCoreId is a collapsing id, recursively). Pure — the shared cascade walk
// used by `collapse` (to prune the open set) and by
// WorkspaceCanvas (to releaseCanvasStores + reset the arbiter for every torn-down
// core). A finite open set + the visited guard guarantee termination.
export function cascadeContextIds(open: readonly OpenSatellite[], contextId: string): string[] {
  const doomed = new Set<string>([contextId])
  let grew = true
  while (grew) {
    grew = false
    for (const s of open) {
      if (s.parentCoreId !== null && doomed.has(s.parentCoreId) && !doomed.has(s.contextId)) {
        doomed.add(s.contextId)
        grew = true
      }
    }
  }
  return [...doomed]
}

interface CanvasSatellitesState {
  // Open child cores, in open order (drives the rightward per-parent columns +
  // vertical stacks). Each carries its parent-core linkage (see OpenSatellite).
  open: OpenSatellite[]
  // Open the child canvas of `contextId` as a live core hanging off
  // `parentCoreId` (null = the primary). Idempotent on `contextId` (no duplicate).
  openSatellite: (contextId: string, parentCoreId: string | null) => void
  // Collapse the core for `contextId` AND cascade to every descendant (else an
  // orphaned grandchild edge/column would dangle). Returns the cascaded context
  // ids (target + descendants) so the caller can releaseCanvasStores + reset the
  // arbiter for each.
  collapse: (contextId: string) => string[]
}

export const useCanvasSatellitesStore = create<CanvasSatellitesState>()((set, get) => ({
  open: [],

  openSatellite(contextId, parentCoreId) {
    const { open } = get()
    if (open.some((s) => s.contextId === contextId)) return
    set({ open: [...open, { contextId, parentCoreId }] })
  },

  collapse(contextId) {
    const { open } = get()
    const doomed = cascadeContextIds(open, contextId)
    const doomedSet = new Set(doomed)
    set({
      open: open.filter((s) => !doomedSet.has(s.contextId)),
    })
    return doomed
  },
}))

// Session-scoped test/reset seam + the per-canvas-nav reset. Mirrors
// resetCanvasCompose / resetActiveLane. WorkspaceCanvas calls this when the active
// canvas changes (deep-link / ⌘ / breadcrumb): the satellite nodes have stable
// ids and never unmount, so every per-navigation reset must be explicit (P2's
// hoveredMark lesson — a stable id means there is no unmount to rely on).
export function resetCanvasSatellites(): void {
  useCanvasSatellitesStore.setState({ open: [] })
}
