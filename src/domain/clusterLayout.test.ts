import { describe, expect, it } from 'vitest'
import { computeSatelliteLayout, type ClusterLayoutConfig } from './clusterLayout'

// 089-D3 P3 — the recursion cluster's derived placement, in isolation (no React
// Flow, no store, no DOM). A drill-in opens a child canvas as a SUMMARY satellite
// node to the RIGHT of the Design core, connected by a parent→child edge. Like
// laneLayout, position is DERIVED — never persisted — so this pure projection is
// the single source of truth the WorkspaceCanvas reconcile trusts.
//
// dagre/elk were evaluated here (the spike's "defer dagre to the 011/012
// clusters") and deferred: the open-satellite set is a single rightward column
// stacked vertically — a deterministic tidy layout with no edge crossings to
// minimize, so a heavyweight (elk: async → layout-race) or extra dependency
// (dagre) buys nothing yet. This module's interface is the swap seam if P5's
// volume/LOD work ever proves real graph layout is needed.

const CONFIG: ClusterLayoutConfig = {
  originX: 2016, // the Design column x (2 * (960 + 48))
  coreWidth: 960,
  coreGap: 120,
  satelliteHeight: 180,
  vGap: 24,
}

const CORE = 'workspace-canvas-design'

describe('computeSatelliteLayout — derived cluster placement (issue 011 / P3)', () => {
  it('places a single satellite to the RIGHT of the core, top-aligned', () => {
    const { positions, edges } = computeSatelliteLayout([{ id: 'satellite:a' }], CORE, CONFIG)
    expect(positions).toEqual([
      { id: 'satellite:a', x: 2016 + 960 + 120, y: 0 },
    ])
    // The FIRST React Flow edge in the app: parent core → child satellite.
    expect(edges).toEqual([
      { id: 'edge:workspace-canvas-design:satellite:a', source: CORE, target: 'satellite:a' },
    ])
  })

  it('stacks multiple satellites vertically with a gap — none overlap', () => {
    const { positions } = computeSatelliteLayout(
      [{ id: 'satellite:a' }, { id: 'satellite:b' }, { id: 'satellite:c' }],
      CORE,
      CONFIG,
    )
    const x = 2016 + 960 + 120
    expect(positions).toEqual([
      { id: 'satellite:a', x, y: 0 },
      { id: 'satellite:b', x, y: 180 + 24 },
      { id: 'satellite:c', x, y: (180 + 24) * 2 },
    ])
    // No two satellites share a y band — strictly ascending, all distinct (the
    // exact spacing is pinned by the toEqual above; this guards the invariant).
    const ys = positions.map((p) => p.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    expect(new Set(ys).size).toBe(ys.length)
  })

  it('emits exactly one parent→child edge per satellite, order preserved', () => {
    const { edges } = computeSatelliteLayout(
      [{ id: 'satellite:x' }, { id: 'satellite:y' }],
      CORE,
      CONFIG,
    )
    expect(edges.map((e) => e.target)).toEqual(['satellite:x', 'satellite:y'])
    expect(edges.every((e) => e.source === CORE)).toBe(true)
    // Edge ids are unique + stable (reconcile identity — no churn, no loop).
    expect(new Set(edges.map((e) => e.id)).size).toBe(2)
  })

  it('clears a WIDE (093-uncapped) core — x tracks the measured coreWidth, not a nominal one', () => {
    // A register widened by many dimensions: the caller passes the MEASURED width
    // (1400) so the satellite column sits past the register's real right edge, not
    // on top of it (the review-caught 093 overlap).
    const wide: ClusterLayoutConfig = { ...CONFIG, coreWidth: 1400 }
    const { positions } = computeSatelliteLayout([{ id: 'satellite:a' }], CORE, wide)
    const first = positions[0]
    expect(first).toEqual({ id: 'satellite:a', x: 2016 + 1400 + 120, y: 0 })
    // Strictly right of where a nominal-960 core would have placed it.
    expect(first?.x ?? 0).toBeGreaterThan(2016 + 960 + 120)
  })

  it('is a no-op for an empty open set (collapse-all → no nodes, no edges)', () => {
    const { positions, edges } = computeSatelliteLayout([], CORE, CONFIG)
    expect(positions).toEqual([])
    expect(edges).toEqual([])
  })

  it('is pure — the same input yields byte-identical output (deterministic)', () => {
    const input = [{ id: 'satellite:a' }, { id: 'satellite:b' }]
    const a = computeSatelliteLayout(input, CORE, CONFIG)
    const b = computeSatelliteLayout(input, CORE, CONFIG)
    expect(a).toEqual(b)
  })
})
