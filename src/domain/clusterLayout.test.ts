import { describe, expect, it } from 'vitest'
import {
  computeSatelliteLayout,
  type ClusterLayoutConfig,
  type ParentColumn,
  type SatelliteItem,
} from './clusterLayout'

// 089-D3 P3 / 106 item 2 — the recursion cluster's derived placement, in isolation
// (no React Flow, no store, no DOM). A drill-in opens a child canvas as a LIVE child
// core to the RIGHT of its PARENT core, connected by a parent→child edge. Like
// laneLayout, position is DERIVED — never persisted — so this pure projection is the
// single source of truth the WorkspaceCanvas reconcile trusts.
//
// 106 item 2 — a core can itself be a parent: a grandchild hangs off ITS parent
// child-core's column (parent's derived x + measured coreWidth + gap), with its edge
// sourced from THAT parent core, not the primary. The fn derives child columns
// parents-before-children so arbitrary depth resolves off a single primary seed.

const CONFIG: ClusterLayoutConfig = {
  coreGap: 120,
  satelliteHeight: 180,
  vGap: 24,
}

const CORE = 'workspace-canvas-design'
// The primary column seed: x = the Design column (2 * (960 + 48)), measured width 960.
const PRIMARY: ParentColumn = { x: 2016, coreWidth: 960 }
const ROOTS = new Map<string, ParentColumn>([[CORE, PRIMARY]])

// A satellite hanging directly off the primary core.
const child = (id: string, coreWidth = 960): SatelliteItem => ({
  id,
  parentCoreNodeId: CORE,
  coreWidth,
})

describe('computeSatelliteLayout — derived cluster placement (issue 011 / P3 / 106-②)', () => {
  it('places a single satellite to the RIGHT of the core, top-aligned', () => {
    const { positions, edges } = computeSatelliteLayout([child('satellite:a')], ROOTS, CONFIG)
    expect(positions).toEqual([{ id: 'satellite:a', x: 2016 + 960 + 120, y: 0 }])
    // The parent→child edge: primary core → child satellite.
    expect(edges).toEqual([
      { id: 'edge:workspace-canvas-design:satellite:a', source: CORE, target: 'satellite:a' },
    ])
  })

  it('stacks multiple satellites of ONE parent vertically with a gap — none overlap', () => {
    const { positions } = computeSatelliteLayout(
      [child('satellite:a'), child('satellite:b'), child('satellite:c')],
      ROOTS,
      CONFIG,
    )
    const x = 2016 + 960 + 120
    expect(positions).toEqual([
      { id: 'satellite:a', x, y: 0 },
      { id: 'satellite:b', x, y: 180 + 24 },
      { id: 'satellite:c', x, y: (180 + 24) * 2 },
    ])
    const ys = positions.map((p) => p.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    expect(new Set(ys).size).toBe(ys.length)
  })

  it('emits exactly one parent→child edge per satellite, order preserved', () => {
    const { edges } = computeSatelliteLayout([child('satellite:x'), child('satellite:y')], ROOTS, CONFIG)
    expect(edges.map((e) => e.target)).toEqual(['satellite:x', 'satellite:y'])
    expect(edges.every((e) => e.source === CORE)).toBe(true)
    expect(new Set(edges.map((e) => e.id)).size).toBe(2)
  })

  it('clears a WIDE (093-uncapped) core — x tracks the measured coreWidth, not a nominal one', () => {
    // A register widened by many dimensions: the seed column carries the MEASURED
    // width (1400) so the satellite column sits past the register's real right edge.
    const roots = new Map<string, ParentColumn>([[CORE, { x: 2016, coreWidth: 1400 }]])
    const { positions } = computeSatelliteLayout([child('satellite:a')], roots, CONFIG)
    const first = positions[0]
    expect(first).toEqual({ id: 'satellite:a', x: 2016 + 1400 + 120, y: 0 })
    expect(first?.x ?? 0).toBeGreaterThan(2016 + 960 + 120)
  })

  it('is a no-op for an empty open set (collapse-all → no nodes, no edges)', () => {
    const { positions, edges } = computeSatelliteLayout([], ROOTS, CONFIG)
    expect(positions).toEqual([])
    expect(edges).toEqual([])
  })

  it('is pure — the same input yields byte-identical output (deterministic)', () => {
    const input = [child('satellite:a'), child('satellite:b')]
    const a = computeSatelliteLayout(input, ROOTS, CONFIG)
    const b = computeSatelliteLayout(input, ROOTS, CONFIG)
    expect(a).toEqual(b)
  })

  // ── 106 item 2 — nested drill positioning ──────────────────────────────────
  it('anchors a grandchild to its PARENT column, not the primary; edge sourced from the parent core', () => {
    const parentNodeId = `${CORE}:P` // childRegisterNodeId('P')
    const directChild: SatelliteItem = { id: parentNodeId, parentCoreNodeId: CORE, coreWidth: 800 }
    const grandchild: SatelliteItem = { id: 'satellite:g', parentCoreNodeId: parentNodeId, coreWidth: 500 }
    const { positions, edges } = computeSatelliteLayout([directChild, grandchild], ROOTS, CONFIG)

    const primaryColumnX = 2016 + 960 + 120 // where a direct child sits
    const byId = new Map(positions.map((p) => [p.id, p]))
    // The direct child sits at the primary column; the grandchild sits strictly to
    // its RIGHT — one parent-core width + gap past the direct child's own column.
    expect(byId.get(parentNodeId)?.x).toBe(primaryColumnX)
    expect(byId.get('satellite:g')?.x).toBe(primaryColumnX + 800 + 120)
    expect(byId.get('satellite:g')?.x ?? 0).toBeGreaterThan(primaryColumnX)

    // The grandchild's edge is sourced from ITS PARENT core, NOT the primary.
    const gcEdge = edges.find((e) => e.target === 'satellite:g')
    expect(gcEdge?.source).toBe(parentNodeId)
    expect(gcEdge?.id).toBe(`edge:${parentNodeId}:satellite:g`)
    // The direct child's edge still sources from the primary (byte-identical).
    expect(edges.find((e) => e.target === parentNodeId)?.source).toBe(CORE)
  })

  it('resolves a grandchild regardless of input order (parents-before-children internally)', () => {
    const parentNodeId = `${CORE}:P`
    const directChild: SatelliteItem = { id: parentNodeId, parentCoreNodeId: CORE, coreWidth: 800 }
    const grandchild: SatelliteItem = { id: 'satellite:g', parentCoreNodeId: parentNodeId, coreWidth: 500 }
    // Grandchild listed FIRST — the fn must still derive the parent column first.
    const { positions } = computeSatelliteLayout([grandchild, directChild], ROOTS, CONFIG)
    const byId = new Map(positions.map((p) => [p.id, p]))
    expect(byId.get('satellite:g')?.x).toBe(2016 + 960 + 120 + 800 + 120)
  })

  it('siblings of one parent stack in its column; a deeper level opens a new column', () => {
    const pa = `${CORE}:A` // a direct child off the primary
    const items: SatelliteItem[] = [
      { id: pa, parentCoreNodeId: CORE, coreWidth: 700 },
      { id: 'g:a1', parentCoreNodeId: pa, coreWidth: 400 },
      { id: 'g:a2', parentCoreNodeId: pa, coreWidth: 400 }, // sibling of g:a1
    ]
    const { positions } = computeSatelliteLayout(items, ROOTS, CONFIG)
    const byId = new Map(positions.map((p) => [p.id, p]))
    // A's two grandchildren share A's column x and stack vertically (distinct y).
    expect(byId.get('g:a1')?.x).toBe(byId.get('g:a2')?.x)
    expect(byId.get('g:a1')?.y).not.toBe(byId.get('g:a2')?.y)
    expect(byId.get('g:a2')?.y).toBe(180 + 24)
    // The grandchild column sits to the RIGHT of A's own column (a new depth level,
    // a distinct column — never on top of the parent).
    expect(byId.get('g:a1')?.x ?? 0).toBeGreaterThan(byId.get(pa)?.x ?? 0)
  })

  it('skips a satellite whose parent column is missing (defensive — never throws)', () => {
    const orphan: SatelliteItem = { id: 'satellite:x', parentCoreNodeId: 'unknown-core', coreWidth: 400 }
    const { positions, edges } = computeSatelliteLayout([child('satellite:a'), orphan], ROOTS, CONFIG)
    expect(positions.map((p) => p.id)).toEqual(['satellite:a'])
    expect(edges.map((e) => e.target)).toEqual(['satellite:a'])
  })
})
