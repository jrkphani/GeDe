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
  // The satellite node's stable id (see `satelliteNodeId` in the store). For a
  // live child core this is its REGISTER node id, which also serves as the
  // `parentCoreNodeId` of any grandchild drilled from inside it.
  id: string
  // 106 item 2 — the node id of the PARENT core this satellite hangs off. A direct
  // child names the PRIMARY register (LANE_NODE_ID.design); a grandchild names its
  // own parent child-core's register node id. The satellite's x + edge source are
  // both anchored to this parent (not always the primary).
  parentCoreNodeId: string
  // This core's EFFECTIVE (measured) reading width — used ONLY to place ITS OWN
  // children: a grandchild sits one `coreWidth + coreGap` to the right of this
  // core's column. The CALLER must pass the register's MEASURED width (max of the
  // nominal lane width and the live `node.measured.width`), NOT the nominal 960px:
  // 093 made the register `width: max-content` (uncapped), so a nominal width
  // would let a wide register overlap its child + skew the edge (the source handle
  // anchors to the real bounding box). Width is a layout INPUT, never a lane
  // x-stride — only the child clearance off this core's real right edge.
  coreWidth: number
}

// 106 item 2 — a parent core's derived column: where its left edge sits (x) and
// its measured reading width. A satellite hangs one `coreWidth + coreGap` to the
// right of its parent's column. The CALLER seeds only the ROOT columns (the
// primary register); the fn derives every child/grandchild column from there.
export interface ParentColumn {
  x: number
  coreWidth: number
}

export interface ClusterLayoutConfig {
  // Horizontal gap between a core's right edge and a child satellite column, px.
  coreGap: number
  // Fixed summary-card height used for vertical stacking in the PURE projection.
  // The WorkspaceCanvas consumer overrides y with MEASURED heights (live cores are
  // far taller than a fixed stub); this keeps the pure fn deterministic + testable.
  satelliteHeight: number
  // Vertical gap between two stacked satellites sharing one column, px.
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

// Derive a position + a parent→child edge for every open satellite. Each
// satellite hangs one `coreWidth + coreGap` to the RIGHT of ITS parent core's
// column (a direct child off the primary; a grandchild off its own parent
// child-core), and siblings sharing a column stack downward by the fixed card
// height + gap so none overlap. Each edge runs from the parent core to its
// satellite; edge ids are unique + stable so the WorkspaceCanvas edge reconcile
// never churns (the "Maximum update depth" guard).
//
// `rootColumns` seeds only the columns whose x is externally known (the primary
// register). Child/grandchild columns are DERIVED here: satellites are processed
// PARENTS-BEFORE-CHILDREN (depth order) so a satellite registers its own column
// before any grandchild looks it up — arbitrary depth resolves off one seed. A
// satellite whose parent column is absent is skipped (defensive; never throws).
// Pure — no mutation of inputs, no I/O; the same input yields byte-identical output.
export function computeSatelliteLayout(
  satellites: readonly SatelliteItem[],
  rootColumns: ReadonlyMap<string, ParentColumn>,
  config: ClusterLayoutConfig,
): { positions: SatellitePlacement[]; edges: SatelliteEdge[] } {
  // Working column registry: seeded with the roots, extended as each satellite is
  // placed so its descendants can anchor off it. A local copy — inputs stay pure.
  const columns = new Map<string, ParentColumn>(rootColumns)
  // Stable depth sort: a satellite whose parentCoreNodeId is another satellite's
  // id is deeper. Preserving input order within a depth keeps sibling stacking +
  // output ordering deterministic (and byte-identical for the all-direct case).
  const satelliteIds = new Set(satellites.map((s) => s.id))
  const depthOf = (sat: SatelliteItem): number => {
    let depth = 0
    let parent = sat.parentCoreNodeId
    // Walk up while the parent is itself a satellite (guard against cycles via the
    // visited-count cap — the id set is finite so this always terminates).
    const seen = new Set<string>()
    while (satelliteIds.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      depth += 1
      parent = satellites.find((s) => s.id === parent)?.parentCoreNodeId ?? ''
    }
    return depth
  }
  const ordered = satellites
    .map((sat, index) => ({ sat, index, depth: depthOf(sat) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)

  const positions: SatellitePlacement[] = []
  const edges: SatelliteEdge[] = []
  // Per-column vertical cursor so siblings of one parent stack; distinct parents
  // occupy distinct columns each with their own cursor.
  const yByColumn = new Map<string, number>()
  for (const { sat } of ordered) {
    const parentColumn = columns.get(sat.parentCoreNodeId)
    if (!parentColumn) continue // orphan (parent not open) — skip, don't throw.
    const x = parentColumn.x + parentColumn.coreWidth + config.coreGap
    const y = yByColumn.get(sat.parentCoreNodeId) ?? 0
    positions.push({ id: sat.id, x, y })
    edges.push({
      id: `edge:${sat.parentCoreNodeId}:${sat.id}`,
      source: sat.parentCoreNodeId,
      target: sat.id,
    })
    yByColumn.set(sat.parentCoreNodeId, y + config.satelliteHeight + config.vGap)
    // Register this core as a column so its own children anchor off its right edge.
    columns.set(sat.id, { x, coreWidth: sat.coreWidth })
  }
  return { positions, edges }
}
