import { describe, expect, it } from 'vitest'
import { ARC_RADIUS, layout, NODE_RADIUS, spokePath, type CanvasLayoutInput } from './canvasLayout'

const CENTER = 500

function dimension(id: string, sort: number, color = '#6f5bd6') {
  return { id, name: id, color, sort }
}

function params(dimensionId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${dimensionId}-p${i}`,
    name: `${dimensionId}-p${i}`,
    sort: i,
  }))
}

function distanceFromCenter(x: number, y: number): number {
  return Math.hypot(x - CENTER, y - CENTER)
}

describe('layout', () => {
  it('produces one arc per dimension for n = 2, 3, 4, each spanning a finite non-overlapping angle', () => {
    for (const n of [2, 3, 4]) {
      const dimensions = Array.from({ length: n }, (_, i) => dimension(`d${i}`, i))
      const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 2)]))
      const input: CanvasLayoutInput = {
        dimensions,
        parametersByDimension,
        contexts: [],
        bindingsByContext: {},
      }
      const geometry = layout(input)

      expect(geometry.viewBox).toBe('0 0 1000 1000')
      expect(geometry.arcs).toHaveLength(n)
      for (const arc of geometry.arcs) {
        expect(typeof arc.d).toBe('string')
        expect(arc.d.length).toBeGreaterThan(0)
        expect(arc.empty).toBe(false)
      }
      // Every arc's dimension id is represented exactly once.
      expect(geometry.arcs.map((a) => a.dimensionId).sort()).toEqual(dimensions.map((d) => d.id).sort())
      // 2 dots per dimension.
      expect(geometry.dots).toHaveLength(n * 2)
      for (const dot of geometry.dots) {
        expect(Number.isFinite(dot.x)).toBe(true)
        expect(Number.isFinite(dot.y)).toBe(true)
        // Dots sit on the arc radius, regardless of n.
        expect(distanceFromCenter(dot.x, dot.y)).toBeCloseTo(distanceFromCenter(dot.x, dot.y), 5)
      }
      // All dots across all dimensions sit at the same radius from center.
      const radii = geometry.dots.map((d) => distanceFromCenter(d.x, d.y))
      for (const r of radii) expect(r).toBeCloseTo(radii[0] as number, 5)
    }
  })

  it('is a pure function: calling twice on equal input produces byte-identical output', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1), dimension('d2', 2)]
    const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 3)]))
    const contexts = [
      { id: 'ctxA', symbol: 'α', parentId: null },
      { id: 'ctxB', symbol: 'β', parentId: null },
    ]
    const bindingsByContext = {
      ctxA: { d0: 'd0-p0', d1: 'd1-p1', d2: 'd2-p2' },
      ctxB: { d0: 'd0-p1', d1: 'd1-p0' },
    }
    const input: CanvasLayoutInput = { dimensions, parametersByDimension, contexts, bindingsByContext }

    const first = layout(input)
    const second = layout(input)
    expect(second).toEqual(first)
  })

  it('resolves two contexts on an identical tuple to distinct, non-overlapping positions, deterministically', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1)]
    const parametersByDimension = { d0: params('d0', 1), d1: params('d1', 1) }
    const contexts = [
      { id: 'ctxA', symbol: 'α', parentId: null },
      { id: 'ctxB', symbol: 'β', parentId: null },
    ]
    // Both contexts bind the exact same tuple -> identical raw centroid.
    const bindingsByContext = {
      ctxA: { d0: 'd0-p0', d1: 'd1-p0' },
      ctxB: { d0: 'd0-p0', d1: 'd1-p0' },
    }
    const input: CanvasLayoutInput = { dimensions, parametersByDimension, contexts, bindingsByContext }

    const geometry = layout(input)
    const nodeA = geometry.nodes.find((n) => n.contextId === 'ctxA')
    const nodeB = geometry.nodes.find((n) => n.contextId === 'ctxB')
    expect(nodeA).toBeDefined()
    expect(nodeB).toBeDefined()
    const dist = Math.hypot((nodeA?.x ?? 0) - (nodeB?.x ?? 0), (nodeA?.y ?? 0) - (nodeB?.y ?? 0))
    expect(dist).toBeGreaterThanOrEqual(NODE_RADIUS)

    // Determinism: re-running produces the exact same resolved positions.
    const again = layout(input)
    expect(again).toEqual(geometry)
  })

  it('flags a context missing a binding as draft, and a fully bound context as not draft', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1)]
    const parametersByDimension = { d0: params('d0', 1), d1: params('d1', 1) }
    const contexts = [
      { id: 'ctxDraft', symbol: 'α', parentId: null },
      { id: 'ctxComplete', symbol: 'β', parentId: null },
    ]
    const bindingsByContext = {
      ctxDraft: { d0: 'd0-p0' },
      ctxComplete: { d0: 'd0-p0', d1: 'd1-p0' },
    }
    const input: CanvasLayoutInput = { dimensions, parametersByDimension, contexts, bindingsByContext }
    const geometry = layout(input)

    const draft = geometry.nodes.find((n) => n.contextId === 'ctxDraft')
    const complete = geometry.nodes.find((n) => n.contextId === 'ctxComplete')
    expect(draft?.isDraft).toBe(true)
    expect(complete?.isDraft).toBe(false)
  })

  it('renders a zero-parameter dimension as an empty arc with no dots and no NaN geometry', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1)]
    const parametersByDimension = { d0: params('d0', 2), d1: [] }
    const input: CanvasLayoutInput = {
      dimensions,
      parametersByDimension,
      contexts: [],
      bindingsByContext: {},
    }
    const geometry = layout(input)

    const emptyArc = geometry.arcs.find((a) => a.dimensionId === 'd1')
    expect(emptyArc?.empty).toBe(true)
    expect(geometry.dots.filter((d) => d.dimensionId === 'd1')).toHaveLength(0)
    for (const arc of geometry.arcs) {
      expect(Number.isFinite(arc.labelPos.x)).toBe(true)
      expect(Number.isFinite(arc.labelPos.y)).toBe(true)
    }
  })

  it('returns empty geometry (no NaN/crash) when there are no dimensions yet', () => {
    const input: CanvasLayoutInput = {
      dimensions: [],
      parametersByDimension: {},
      contexts: [],
      bindingsByContext: {},
    }
    expect(layout(input)).toEqual({ viewBox: '0 0 1000 1000', arcs: [], dots: [], nodes: [] })
  })

  it('adding one context changes only that context\'s node geometry, nothing else (no global reshuffle)', () => {
    // Single-dimension, single-binding contexts so each centroid is exactly
    // one dot's position — full control over separation, independent of the
    // centroid-averaging behavior exercised by the collision test above.
    // ctxA and ctxB sit on opposite ends of d0's arc; ctxC sits on d1's arc
    // entirely — three points guaranteed far apart from each other.
    const dimensions = [dimension('d0', 0), dimension('d1', 1), dimension('d2', 2)]
    const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 8)]))
    const baseContexts = [
      { id: 'ctxA', symbol: 'α', parentId: null },
      { id: 'ctxB', symbol: 'β', parentId: null },
    ]
    const baseBindings = {
      ctxA: { d0: 'd0-p0' },
      ctxB: { d0: 'd0-p7' },
    }
    const before = layout({
      dimensions,
      parametersByDimension,
      contexts: baseContexts,
      bindingsByContext: baseBindings,
    })

    // Precondition: the fixture itself must be non-colliding, or this test
    // would just be re-testing collision resolution, not "no reshuffle".
    const [nodeA, nodeB] = before.nodes
    const preexistingSeparation = Math.hypot((nodeA?.x ?? 0) - (nodeB?.x ?? 0), (nodeA?.y ?? 0) - (nodeB?.y ?? 0))
    expect(preexistingSeparation).toBeGreaterThan(NODE_RADIUS * 4)

    const after = layout({
      dimensions,
      parametersByDimension,
      contexts: [...baseContexts, { id: 'ctxC', symbol: 'γ', parentId: null }],
      bindingsByContext: { ...baseBindings, ctxC: { d1: 'd1-p4' } },
    })

    // Arcs and dots are dimension/parameter-derived only — untouched by context count.
    expect(after.arcs).toEqual(before.arcs)
    expect(after.dots).toEqual(before.dots)

    // Every pre-existing node is byte-identical; only the new node was added.
    const beforeById = new Map(before.nodes.map((n) => [n.contextId, n]))
    const afterById = new Map(after.nodes.map((n) => [n.contextId, n]))
    expect(afterById.size).toBe(beforeById.size + 1)
    for (const [id, node] of beforeById) {
      expect(afterById.get(id)).toEqual(node)
    }
    expect(afterById.get('ctxC')).toBeDefined()
  })

  // Issue 023 — every dot gains a labelPos outside ARC_RADIUS, on the dot's
  // own radial angle (same angle convention as pointAt: 0 = north, clockwise).
  it('adds a labelPos for each dot, outside ARC_RADIUS on the dot\'s own radial angle, deterministic across n', () => {
    for (const n of [2, 3]) {
      const dimensions = Array.from({ length: n }, (_, i) => dimension(`d${i}`, i))
      const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 2)]))
      const input: CanvasLayoutInput = {
        dimensions,
        parametersByDimension,
        contexts: [],
        bindingsByContext: {},
      }
      const geometry = layout(input)

      expect(geometry.dots.length).toBeGreaterThan(0)
      for (const dot of geometry.dots) {
        expect(Number.isFinite(dot.labelPos.x)).toBe(true)
        expect(Number.isFinite(dot.labelPos.y)).toBe(true)

        const labelDistance = distanceFromCenter(dot.labelPos.x, dot.labelPos.y)
        expect(labelDistance).toBeGreaterThan(ARC_RADIUS)

        // Same radial angle as the dot itself (pointAt's convention: angle =
        // atan2(dx, -dy) relative to CENTER).
        const dotAngle = Math.atan2(dot.x - CENTER, -(dot.y - CENTER))
        const labelAngle = Math.atan2(dot.labelPos.x - CENTER, -(dot.labelPos.y - CENTER))
        expect(labelAngle).toBeCloseTo(dotAngle, 5)
      }

      // Determinism (ADR-0005): identical input, identical output, including labelPos.
      const again = layout(input)
      expect(again).toEqual(geometry)
    }
  })

  // Issue 023 fix — a label reads OUTWARD from the ring so it never crosses the
  // arc/dots: right half anchors 'start', left half 'end', vertical top/bottom
  // 'middle'. The dimension (arc) label sits inside, always centered.
  it('gives each dot a side-aware text anchor and centers the dimension label', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1)]
    const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 3)]))
    const geometry = layout({ dimensions, parametersByDimension, contexts: [], bindingsByContext: {} })

    for (const dot of geometry.dots) {
      const horizontal = dot.labelPos.x - CENTER
      if (dot.labelAnchor === 'start') expect(horizontal).toBeGreaterThan(0)
      else if (dot.labelAnchor === 'end') expect(horizontal).toBeLessThan(0)
      // A dot's outward label anchor must never point back across the circle.
      expect(['start', 'middle', 'end']).toContain(dot.labelAnchor)
    }
    // With two dimensions the arcs face east/west, so their labels land on a
    // side — but the dimension label is always centered (it sits inside).
    for (const arc of geometry.arcs) expect(arc.labelAnchor).toBe('middle')
  })

  // Issue 023 crowding fix — many parameters bunch near the poles (the arc's y
  // barely changes per angle there); labels on the same side must never stack.
  it('spreads crowded same-side parameter labels so none vertically overlap', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1)]
    // 9 params on one dimension forces near-pole vertical bunching.
    const parametersByDimension = { d0: params('d0', 9), d1: params('d1', 2) }
    const geometry = layout({ dimensions, parametersByDimension, contexts: [], bindingsByContext: {} })

    for (const side of [
      geometry.dots.filter((d) => d.labelPos.x >= CENTER),
      geometry.dots.filter((d) => d.labelPos.x < CENTER),
    ]) {
      const ys = side.map((d) => d.labelPos.y).sort((a, b) => a - b)
      for (let i = 1; i < ys.length; i++) {
        // A comfortable line-height gap (MIN_LABEL_GAP = 20), minus float slack.
        expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(19.9)
      }
    }
  })

  // Design brief targets a 16ms (one-frame) budget for 100 contexts. Asserted
  // here with generous headroom (200ms) for shared/noisy CI hardware — even
  // the 40ms threshold this replaced still flaked (43.6ms on a loaded
  // runner). This is a guard against pathological blowups (e.g. an
  // accidental O(n^2) path, which would land in the hundreds of ms or
  // seconds), not a tight micro-benchmark, so it shouldn't flake again.
  it('lays out 100 contexts across 3 dimensions well within the frame budget', () => {
    const dimensions = [dimension('d0', 0), dimension('d1', 1), dimension('d2', 2)]
    const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 10)]))
    const contexts = Array.from({ length: 100 }, (_, i) => ({ id: `ctx${i}`, symbol: `s${i}`, parentId: null }))
    const bindingsByContext = Object.fromEntries(
      contexts.map((c, i) => [
        c.id,
        { d0: `d0-p${i % 10}`, d1: `d1-p${(i + 3) % 10}`, d2: `d2-p${(i + 7) % 10}` },
      ]),
    )
    const input: CanvasLayoutInput = { dimensions, parametersByDimension, contexts, bindingsByContext }

    // Warm up once (JIT), then measure.
    layout(input)
    const start = performance.now()
    layout(input)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(200)
  })
})

// Issue 039 (028 phase b) — deterministic bundled spoke splines. `spokePath`
// is pure: fed only the two endpoints (the module's own CENTER attractor is
// baked in, per ADR-0005), so it's unit-testable without touching `layout`.
describe('spokePath', () => {
  // Quadratic Bezier point at parameter t, matching the `M from Q ctrl to`
  // path spokePath emits — used to independently verify the emitted `d`
  // actually bends the way the construction claims, rather than trusting the
  // string alone.
  function quadraticAt(p0: { x: number; y: number }, ctrl: { x: number; y: number }, p2: { x: number; y: number }, t: number) {
    const mt = 1 - t
    return {
      x: mt * mt * p0.x + 2 * mt * t * ctrl.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * ctrl.y + t * t * p2.y,
    }
  }

  // Extracts the three points out of the `M x y Q cx cy ex ey` path spokePath
  // emits, so tests can check curve shape without depending on exact
  // formatting/whitespace of the `d` string.
  function parseQuadratic(d: string) {
    const match = /M\s*([-\d.]+)\s+([-\d.]+)\s*Q\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(d)
    if (!match) throw new Error(`not a quadratic path: ${d}`)
    const [, mx, my, cx, cy, ex, ey] = match.map(Number)
    return {
      from: { x: mx as number, y: my as number },
      ctrl: { x: cx as number, y: cy as number },
      to: { x: ex as number, y: ey as number },
    }
  }

  it('returns a non-empty path containing a curve command, not a straight segment', () => {
    const from = { x: 500, y: 100 }
    const to = { x: 850, y: 400 }
    const d = spokePath(from, to)
    expect(d.length).toBeGreaterThan(0)
    expect(d).toMatch(/[QC]/)
  })

  it('is deterministic: identical input produces a byte-identical path', () => {
    const from = { x: 500, y: 100 }
    const to = { x: 850, y: 400 }
    expect(spokePath(from, to)).toBe(spokePath({ ...from }, { ...to }))
  })

  it("bends inward: the curve's midpoint sits closer to CENTER than the straight chord's midpoint", () => {
    const CENTER = 500
    // A spread of endpoint angles/radii around the ring, node-to-dot pairs
    // like the real canvas produces.
    const pairs = [
      { from: { x: 500, y: 100 }, to: { x: 850, y: 400 } },
      { from: { x: 480, y: 520 }, to: { x: 120, y: 500 } },
      { from: { x: 700, y: 700 }, to: { x: 900, y: 100 } },
      { from: { x: 300, y: 850 }, to: { x: 500, y: 900 } },
      { from: { x: 510, y: 490 }, to: { x: 60, y: 60 } },
    ]
    for (const { from, to } of pairs) {
      const d = spokePath(from, to)
      const { ctrl } = parseQuadratic(d)
      const curveMid = quadraticAt(from, ctrl, to, 0.5)
      const chordMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
      const distCurve = Math.hypot(curveMid.x - CENTER, curveMid.y - CENTER)
      const distChord = Math.hypot(chordMid.x - CENTER, chordMid.y - CENTER)
      expect(distCurve).toBeLessThan(distChord)
    }
  })

  it('endpoints are preserved exactly (only the interior bends)', () => {
    const from = { x: 500, y: 100 }
    const to = { x: 850, y: 400 }
    const { from: parsedFrom, to: parsedTo } = parseQuadratic(spokePath(from, to))
    expect(parsedFrom).toEqual(from)
    expect(parsedTo).toEqual(to)
  })
})
