import type { OpenSatellite } from '../store/canvasSatellites'

// Issue 106 item 1 — the PURE culling calculus for zoom-LOD auto-demotion of a
// drilled-in child {register + ring} core. When a child core is zoomed OUT, scrolls
// OFF-SCREEN, or nests too DEEP, its heavy grids/editors are swapped for a
// lightweight STUB to cut render cost — UNLESS it is actively being edited. This
// module holds ONLY the geometry/threshold math: React-free, DOM-free, no store —
// deterministic in, boolean out, so every axis is unit-testable in isolation. The
// wiring (RF `useStore` selector, focus ref, stub swap) lives in DesignCoreAdapter.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface CoreLodConfig {
  // Below this viewport zoom a non-editing core demotes (reuse LANE_LOD_ZOOM 0.35).
  minZoom: number
  // Direct child = depth 0; a core deeper than this demotes. maxLiveDepth 2 means
  // depth-culling only bites great-great-grandchildren+ — zoom/off-screen are the
  // real cullers.
  maxLiveDepth: number
  // Flow-coord slack around the viewport: a core just off-edge (within this margin)
  // stays live so a small pan doesn't thrash it in and out of a stub.
  offscreenMargin: number
}

export interface CoreLodInput {
  zoom: number
  depth: number
  coreRect: Rect
  viewportRect: Rect
  isEditing: boolean
}

// Axis-aligned rect overlap with an optional symmetric margin expanding the overlap
// tolerance on all sides. Edges are STRICT: at margin 0, edge-touching rects do NOT
// intersect (a core exactly flush with the viewport edge is off-screen); any
// positive margin brings a near-miss back in.
export function rectsIntersect(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width > b.x - margin &&
    a.y < b.y + b.height + margin &&
    a.y + a.height > b.y - margin
  )
}

// The visible flow-coordinate rectangle for a React Flow transform. RF's transform
// is [translateX, translateY, zoom] in SCREEN px; a point at screen (0,0) maps to
// flow (-tx/zoom, -ty/zoom), and the pane's `paneW × paneH` screen px cover
// `paneW/zoom × paneH/zoom` flow units.
export function viewportRect(
  transform: readonly [number, number, number],
  paneW: number,
  paneH: number,
): Rect {
  const [tx, ty, zoom] = transform
  return { x: -tx / zoom, y: -ty / zoom, width: paneW / zoom, height: paneH / zoom }
}

// The single demote/promote decision. Editing is the HARD first gate — an
// actively-edited core is ALWAYS live (never demoted, never unmounted mid-edit),
// overriding all three cull axes. Otherwise it demotes on ANY axis: zoomed below
// minZoom, nested past maxLiveDepth, or scrolled beyond the viewport + margin.
// Boundaries are inclusive-live: exactly minZoom and exactly maxLiveDepth stay live.
export function shouldCoreBeLive(input: CoreLodInput, config: CoreLodConfig): boolean {
  if (input.isEditing) return true
  if (input.zoom < config.minZoom) return false
  if (input.depth > config.maxLiveDepth) return false
  if (!rectsIntersect(input.coreRect, input.viewportRect, config.offscreenMargin)) return false
  return true
}

// How many ancestor cores sit above `contextId` in the drill-in chain. A direct
// child (parentCoreId null, drilled off the PRIMARY) is depth 0; each parentCoreId
// hop up adds one. An unknown id (not in the open set) is depth 0. A visited-guard
// keeps a malformed cyclic chain finite. Takes the minimal `{contextId,
// parentCoreId}[]` structural shape so it accepts `OpenSatellite[]` without a value
// import (type-only above → no store↔domain cycle).
export function coreDepth(
  open: readonly Pick<OpenSatellite, 'contextId' | 'parentCoreId'>[],
  contextId: string,
): number {
  const byId = new Map(open.map((s) => [s.contextId, s]))
  const visited = new Set<string>()
  let depth = 0
  let cursor = byId.get(contextId)?.parentCoreId ?? null
  while (cursor !== null && !visited.has(cursor)) {
    visited.add(cursor)
    depth += 1
    cursor = byId.get(cursor)?.parentCoreId ?? null
  }
  return depth
}
