// 089-D3 P3 — the recursion cluster's derived-layout core (no React Flow, no
// store, no React, no I/O), the sibling of laneLayout.ts for satellites.
//
// A drill-in (issue 011) opens a context's child canvas as a SUMMARY satellite
// node to the RIGHT of the Design core, connected by a parent→child edge — the
// FIRST React Flow edges in the app. Like laneLayout, position is DERIVED and
// never persisted (STYLE_GUIDE §1 principle 4 / SPEC invariant 5); this pure
// projection is the single source of truth WorkspaceCanvas's reconcile trusts.
//
// dagre/elk evaluated + DEFERRED here (the spike's "defer dagre to the 011/012
// clusters"): the open-satellite set is a single rightward column stacked
// vertically — a deterministic tidy layout with no edge crossings to minimize, so
// elk (async → a layout-vs-measure race) or dagre (an extra dependency) buys
// nothing yet. This module's `computeSatelliteLayout` signature is the swap seam
// if P5's volume/LOD work ever proves real graph layout is needed. Tracked in the
// 089 issue as the "promote stub → live child core" follow-up.
//
// No `Date.now()` / `Math.random()` / DOM / store — deterministic by design.

export interface SatelliteItem {
  // The satellite node's stable id (see `satelliteNodeId` in the store).
  id: string
}

export interface ClusterLayoutConfig {
  // The Design core column's x (satellites hang to its right). A pure input so
  // this module never reaches into WorkspaceCanvas's LANE_CONFIG.
  originX: number
  // The core's EFFECTIVE (measured) reading width — the satellite column starts
  // one coreWidth + coreGap to the right of the core's left edge. The CALLER must
  // pass the register's MEASURED width (max of the nominal lane width and the
  // live `node.measured.width`), NOT the nominal 960px: 093 made the register
  // `width: max-content` (uncapped), so a nominal width would let a wide register
  // overlap the satellite + skew the edge (the source handle anchors to the real
  // bounding box). Position stays derived — width is a layout INPUT, never the
  // lane x-stride (which stays tier-indexed so a wide lane grows into empty
  // canvas), only the satellite clearance off the core's real right edge.
  coreWidth: number
  // Horizontal gap between the core's right edge and the satellite column, px.
  coreGap: number
  // Fixed summary-card height used for vertical stacking (P3 satellites are
  // fixed-height summary nodes — no measured feedback loop until P5's live cores).
  satelliteHeight: number
  // Vertical gap between two stacked satellites, px.
  vGap: number
}

export interface SatellitePlacement {
  id: string
  x: number
  y: number
}

export interface SatelliteEdge {
  id: string
  source: string
  target: string
}

// Derive a position + a parent→child edge for every open satellite. All
// satellites share one x (a column to the right of the core) and stack downward
// by open order using the fixed card height + gap, so none overlap. Each edge
// runs from the core node to its satellite; edge ids are unique + stable so the
// WorkspaceCanvas edge reconcile never churns (the "Maximum update depth" guard).
// Pure — no mutation, no I/O; the same input yields byte-identical output.
export function computeSatelliteLayout(
  satellites: readonly SatelliteItem[],
  coreNodeId: string,
  config: ClusterLayoutConfig,
): { positions: SatellitePlacement[]; edges: SatelliteEdge[] } {
  const x = config.originX + config.coreWidth + config.coreGap
  const positions: SatellitePlacement[] = []
  const edges: SatelliteEdge[] = []
  let y = 0
  for (const sat of satellites) {
    positions.push({ id: sat.id, x, y })
    edges.push({ id: `edge:${coreNodeId}:${sat.id}`, source: coreNodeId, target: sat.id })
    y += config.satelliteHeight + config.vGap
  }
  return { positions, edges }
}
