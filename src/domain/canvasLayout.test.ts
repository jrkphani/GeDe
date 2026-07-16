import { describe, expect, it } from 'vitest'
import { ARC_RADIUS, layout, NODE_RADIUS, spokePath, type CanvasLayoutInput } from './canvasLayout'
import { dotHitRadiusUnits } from './canvasResponsive'

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

// Issue 085 Phase A adversarial-review helper — the TRUE global minimum
// distance over EVERY pair of dots (O(n²)), not just array-adjacent ones. The
// earlier MIN_DOT_SLOT-floor bug let over-dense dots overflow the arc, wrap the
// 12-o'clock seam, and coincide with a same-dimension early dot; a global scan
// is what exposes that (array-adjacent scans stay green through a distance-0
// coincidence between non-adjacent indices).
function globalMinPairwise(dots: readonly { x: number; y: number }[]): number {
  let min = Infinity
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const a = dots[i] as { x: number; y: number }
      const b = dots[j] as { x: number; y: number }
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  return min
}

// Tightest distance between two dots of the SAME dimension that are adjacent in
// sort order — the value maxDotHitRadius is derived from. With pure even-fill
// this must equal globalMinPairwise (cross-gap pairs are always wider).
function withinDimAdjacentMin(dots: readonly { x: number; y: number; dimensionId: string }[]): number {
  const byDim = new Map<string, { x: number; y: number }[]>()
  for (const d of dots) {
    const list = byDim.get(d.dimensionId) ?? []
    list.push(d)
    byDim.set(d.dimensionId, list)
  }
  let min = Infinity
  for (const list of byDim.values()) {
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1] as { x: number; y: number }
      const b = list[i] as { x: number; y: number }
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  return min
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
    expect(layout(input)).toEqual({ viewBox: '0 0 1000 1000', arcs: [], dots: [], nodes: [], maxDotHitRadius: ARC_RADIUS })
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
  // Issue 082 — one param per dimension here deliberately avoids triggering
  // declutterLabels (append-only placement clusters same-arc dots near their
  // arc's start, close enough together that 2+ on one arc legitimately
  // decluter — covered by "spreads crowded same-side parameter labels"
  // below); this test isolates the plain radial-correspondence invariant.
  it('adds a labelPos for each dot, outside ARC_RADIUS on the dot\'s own radial angle, deterministic across n', () => {
    for (const n of [2, 3]) {
      const dimensions = Array.from({ length: n }, (_, i) => dimension(`d${i}`, i))
      const parametersByDimension = Object.fromEntries(dimensions.map((d) => [d.id, params(d.id, 1)]))
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

  // Issue 085 Phase A test-plan item 1 — proportional arcs. Each dimension's
  // arc span is proportional to its parameter count; a sparse dimension gets a
  // short arc (Decision 5). Red before 085 (equal slices at `:300`).
  describe('proportional arcs (issue 085 Phase A)', () => {
    it('sizes each arc proportional to its parameter count; the 1-param dimension is smallest', () => {
      const counts = [4, 3, 2, 1]
      const dimensions = counts.map((_, i) => dimension(`d${i}`, i))
      const parametersByDimension = Object.fromEntries(
        dimensions.map((d, i) => [d.id, params(d.id, counts[i] as number)]),
      )
      const geometry = layout({ dimensions, parametersByDimension, contexts: [], bindingsByContext: {} })

      // Recover each arc's angular span from its start/end. The arcs are laid
      // out in sort order, and each start is the running sum of prior spans +
      // gaps; the span itself is independent of the gaps, so measure it from
      // the mid-angle geometry the layout exposes indirectly via the dots.
      // Simplest exact recovery: re-derive spans from the known total.
      const GAP = (6 * Math.PI) / 180
      const availableSpan = 2 * Math.PI - counts.length * GAP
      const totalParams = counts.reduce((s, c) => s + c, 0)
      const expectedSpans = counts.map((c) => availableSpan * (c / totalParams))

      // The dots of a dimension span exactly `slot·(m)` of its arc where
      // `slot = span/(m+1)`; the angular extent from first to last dot is
      // `slot·(m-1) = span·(m-1)/(m+1)`. Invert to recover each span and
      // confirm proportionality without reaching into private layout state.
      for (let i = 0; i < counts.length; i++) {
        const m = counts[i] as number
        const dimDots = geometry.dots.filter((d) => d.dimensionId === `d${i}`)
        expect(dimDots).toHaveLength(m)
        if (m < 2) continue
        const angles = dimDots.map((d) => Math.atan2(d.x - CENTER, -(d.y - CENTER)))
        // atan2 wraps at π; every arc here sits in [0, ~2π) so unwrap by
        // adding 2π to any angle that dipped negative relative to the first.
        const first = angles[0] as number
        const unwrapped = angles.map((a) => (a < first ? a + 2 * Math.PI : a))
        const extent = (unwrapped[unwrapped.length - 1] as number) - (unwrapped[0] as number)
        const recoveredSpan = (extent * (m + 1)) / (m - 1)
        expect(recoveredSpan).toBeCloseTo(expectedSpans[i] as number, 6)
      }

      // Proportionality + ordering: 4-param arc is the largest, 1-param the
      // smallest, monotonically decreasing with count.
      const spans = expectedSpans
      expect(spans[0]).toBeGreaterThan(spans[1] as number)
      expect(spans[1]).toBeGreaterThan(spans[2] as number)
      expect(spans[2]).toBeGreaterThan(spans[3] as number)
      // The spans sum to the full ring minus the gaps.
      expect(spans.reduce((s, x) => s + x, 0)).toBeCloseTo(availableSpan, 9)
    })

    it('falls back to equal arcs when every dimension is still empty (Σm = 0, no divide-by-zero)', () => {
      const dimensions = [dimension('d0', 0), dimension('d1', 1), dimension('d2', 2)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: [], d1: [], d2: [] },
        contexts: [],
        bindingsByContext: {},
      })
      expect(geometry.arcs).toHaveLength(3)
      for (const arc of geometry.arcs) {
        expect(arc.empty).toBe(true)
        expect(Number.isFinite(arc.labelPos.x)).toBe(true)
        expect(Number.isFinite(arc.labelPos.y)).toBe(true)
      }
      // Equal-arc fallback: the three dimension labels sit at equal angular
      // spacing around the ring (their mid-angles differ by a constant, modulo
      // the 2π wrap atan2 introduces past the south pole).
      const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const labelAngles = geometry.arcs.map((a) => Math.atan2(a.labelPos.x - CENTER, -(a.labelPos.y - CENTER)))
      const gap01 = norm((labelAngles[1] as number) - (labelAngles[0] as number))
      const gap12 = norm((labelAngles[2] as number) - (labelAngles[1] as number))
      expect(gap01).toBeCloseTo(gap12, 6)
    })
  })

  // Issue 085 Phase A test-plan item 2 — even-fill. m params land at
  // `startAngle + slot·(j+1)` with `slot = span/(m+1)`, spread across the whole
  // arc (last dot near the arc end, not ~16° in). Red before 085 (fixed 4°
  // step from the arc start left ~81% of the arc empty).
  describe('even-fill dots (issue 085 Phase A)', () => {
    it('distributes m dots evenly across the arc with uniform adjacent gaps', () => {
      const dimensions = [dimension('d0', 0)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 5) },
        contexts: [],
        bindingsByContext: {},
      })
      // Unwrap the clockwise-increasing dot angles past atan2's ±π seam so
      // adjacent gaps are comparable.
      const raw = geometry.dots.map((d) => Math.atan2(d.x - CENTER, -(d.y - CENTER)))
      const angles: number[] = []
      let prev = -Infinity
      for (const a of raw) {
        let v = a
        while (v < prev) v += 2 * Math.PI
        angles.push(v)
        prev = v
      }
      const gaps = angles.slice(1).map((a, i) => a - (angles[i] as number))
      for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] as number, 9)

      // The first dot sits one slot in from the arc start (angle 0 here) and
      // the leading gap equals the inter-dot gap — i.e. dots fill the arc
      // rather than bunching at the start.
      expect(angles[0]).toBeCloseTo(gaps[0] as number, 9)
    })

    it('spreads dots across the whole arc: the last dot is near the arc end, not ~16° in', () => {
      // Single dimension → the arc is the full ring minus one gap (~354°).
      const dimensions = [dimension('d0', 0)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 4) },
        contexts: [],
        bindingsByContext: {},
      })
      const angles = geometry.dots
        .map((d) => Math.atan2(d.x - CENTER, -(d.y - CENTER)))
        .map((a) => (a < 0 ? a + 2 * Math.PI : a))
      const last = Math.max(...angles)
      // With even-fill the last of 4 dots sits at 4/5 of a ~354° arc (~283°) —
      // the pre-085 fixed-step formula left it at ~16° (four 4° steps). Assert
      // it is well past a quarter-turn to prove the arc is actually filled.
      expect(last).toBeGreaterThan(Math.PI) // > 180°
    })

    it('re-flows the whole arc when a parameter is added: existing dots move (settle), all stay on ARC_RADIUS', () => {
      // The inverse of 082's now-retired append-only invariant: adding a
      // parameter re-divides the arc, so every existing dot moves. The CSS
      // cx/cy transition (base.css, asserted in Canvas.test.tsx) is what makes
      // that a settle rather than a jump; here we assert the re-flow itself.
      const dimensions = [dimension('d0', 0)]
      const before = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 3) },
        contexts: [],
        bindingsByContext: {},
      })
      const after = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 4) },
        contexts: [],
        bindingsByContext: {},
      })

      const beforeById = new Map(before.dots.map((d) => [d.parameterId, d]))
      let moved = 0
      for (const [id, dot] of beforeById) {
        const afterDot = after.dots.find((d) => d.parameterId === id)
        expect(afterDot).toBeDefined()
        // Every pre-existing dot stays on the ring…
        expect(distanceFromCenter(afterDot?.x ?? 0, afterDot?.y ?? 0)).toBeCloseTo(ARC_RADIUS, 6)
        // …but re-spaces (moves) — even-fill, not append-only.
        if (Math.hypot((afterDot?.x ?? 0) - dot.x, (afterDot?.y ?? 0) - dot.y) > 1e-6) moved++
      }
      expect(moved).toBe(beforeById.size)
      // The one new dot is the only addition.
      const newIds = after.dots.map((d) => d.parameterId).filter((id) => !beforeById.has(id))
      expect(newIds).toEqual(['d0-p3'])
    })

    it('a bound context node settles to a new centroid when its bound dot re-spaces', () => {
      // Confirms the flagged assumption end-to-end: the node sits at the
      // centroid of its bound dots, so re-spacing the dot moves the node too
      // (the settle the ~120ms transform transition eases on the node).
      const dimensions = [dimension('d0', 0), dimension('d1', 1)]
      const contexts = [{ id: 'ctxA', symbol: 'α', parentId: null }]
      const bindingsByContext = { ctxA: { d0: 'd0-p0', d1: 'd1-p0' } }
      const before = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 2), d1: params('d1', 1) },
        contexts,
        bindingsByContext,
      })
      const after = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 3), d1: params('d1', 1) },
        contexts,
        bindingsByContext,
      })
      const nodeBefore = before.nodes.find((n) => n.contextId === 'ctxA')
      const nodeAfter = after.nodes.find((n) => n.contextId === 'ctxA')
      // d0-p0 re-spaced (2→3 params on d0), so its centroid — and the node —
      // moved. This is the settle 085 accepts, not the freeze 082 guaranteed.
      const delta = Math.hypot((nodeAfter?.x ?? 0) - (nodeBefore?.x ?? 0), (nodeAfter?.y ?? 0) - (nodeBefore?.y ?? 0))
      expect(delta).toBeGreaterThan(1e-6)
    })
  })

  // Issue 085 Phase A test-plan item 3 (+ adversarial review) — per-layout hit
  // radius under PURE even-fill. The cap must equal half the TRUE global-minimum
  // pairwise dot distance, so no two hit circles ever overlap at any density;
  // and no two dots ever coincide (the MIN_DOT_SLOT-floor bug produced a
  // distance-0 seam-wrap coincidence that an array-adjacent-only scan missed).
  describe('per-layout maxDotHitRadius (issue 085 Phase A)', () => {
    it('reports maxDotHitRadius as exactly half the TRUE global-minimum pairwise dot distance', () => {
      const dimensions = [dimension('d0', 0)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 3) },
        contexts: [],
        bindingsByContext: {},
      })
      expect(geometry.maxDotHitRadius).toBeCloseTo(globalMinPairwise(geometry.dots) / 2, 9)
    })

    it('sparse arc: dots spread wide, so the cap does not bite and the full 44px target is honored at ~500px', () => {
      // 3 dots on a full single-dimension arc are ~120° apart — far wider than
      // the 44px target, so min(dotHitRadiusUnits, cap) = the 44px radius.
      const dimensions = [dimension('d0', 0)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 3) },
        contexts: [],
        bindingsByContext: {},
      })
      const uncapped = dotHitRadiusUnits(500)
      expect(geometry.maxDotHitRadius).toBeGreaterThan(uncapped)
      expect(Math.min(uncapped, geometry.maxDotHitRadius)).toBe(uncapped)
    })

    // Adversarial-review case 1 — high density, single dimension (Σm = 100,
    // far past ADR-0002's optimized 2–8 range: m is unbounded). This FAILS
    // against the MIN_DOT_SLOT-floor code (last dot at 400° wraps the seam onto
    // an early dot ⇒ global min = 0, and array-adjacent scans stay green).
    it('high-density single dimension: no dot coincides, none overflows its arc, and the cap = half the true global min', () => {
      const dimensions = [dimension('d0', 0)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 100) },
        contexts: [],
        bindingsByContext: {},
      })

      // No coincidence anywhere (the seam-wrap bug drives this to 0).
      const globalMin = globalMinPairwise(geometry.dots)
      expect(globalMin).toBeGreaterThan(0)
      // Pure even-fill ⇒ within-dimension adjacency IS the global minimum.
      expect(withinDimAdjacentMin(geometry.dots)).toBeCloseTo(globalMin, 9)

      // Every dot stays within its arc [startAngle, endAngle]: the arc is a
      // single dimension, so [0, availableSpan]. Unwrapping the clockwise angles
      // from the first dot must stay strictly monotonic (no seam wrap) and end
      // below the arc's own span — the buggy code overflowed to > availableSpan.
      const availableSpan = 2 * Math.PI - 1 * ((6 * Math.PI) / 180)
      const raw = geometry.dots.map((d) => Math.atan2(d.x - CENTER, -(d.y - CENTER)))
      let prev = -Infinity
      const unwrapped: number[] = []
      for (const a of raw) {
        let v = a
        while (v < prev + 1e-9) v += 2 * Math.PI
        unwrapped.push(v)
        prev = v
      }
      expect((unwrapped[0] as number)).toBeGreaterThan(0)
      expect((unwrapped[unwrapped.length - 1] as number)).toBeLessThan(availableSpan)

      // Cap is exactly half the true global min ⇒ hit circles touch but never
      // overlap; and it bites below the 44px target at 500px.
      expect(geometry.maxDotHitRadius).toBeCloseTo(globalMin / 2, 9)
      expect(geometry.maxDotHitRadius).toBeLessThanOrEqual(globalMin / 2 + 1e-9)
      const uncapped = dotHitRadiusUnits(500)
      expect(uncapped).toBeGreaterThan(geometry.maxDotHitRadius)
      expect(Math.min(uncapped, geometry.maxDotHitRadius)).toBe(geometry.maxDotHitRadius)
    })

    // Adversarial-review case 2 — high density across MULTIPLE dimensions, the
    // configuration where a cross-gap pair (A's last dot ↔ B's first dot) could
    // in principle be the tightest. Proves it is NOT: with pure even-fill the
    // cross-gap distance is slotA + GAP + slotB > either slot, so the global
    // minimum still lives strictly within a dimension, and the cap tracks it.
    it('high-density multi-dimension: the global-min pair is within a dimension (never cross-gap), cap = half it', () => {
      const dimensions = [dimension('d0', 0), dimension('d1', 1), dimension('d2', 2)]
      const geometry = layout({
        dimensions,
        parametersByDimension: {
          d0: params('d0', 40),
          d1: params('d1', 40),
          d2: params('d2', 40),
        },
        contexts: [],
        bindingsByContext: {},
      })
      const globalMin = globalMinPairwise(geometry.dots)
      expect(globalMin).toBeGreaterThan(0)
      // The tightest pair anywhere equals the tightest same-dimension adjacent
      // pair — cross-gap pairs are provably wider.
      expect(withinDimAdjacentMin(geometry.dots)).toBeCloseTo(globalMin, 9)
      expect(geometry.maxDotHitRadius).toBeCloseTo(globalMin / 2, 9)
      expect(geometry.maxDotHitRadius).toBeLessThanOrEqual(globalMin / 2 + 1e-9)
    })

    it('defaults the cap to ARC_RADIUS (uncapped) when no dimension has two dots to overlap', () => {
      const dimensions = [dimension('d0', 0), dimension('d1', 1)]
      const geometry = layout({
        dimensions,
        parametersByDimension: { d0: params('d0', 1), d1: params('d1', 1) },
        contexts: [],
        bindingsByContext: {},
      })
      expect(geometry.maxDotHitRadius).toBe(ARC_RADIUS)
    })
  })

  // Issue 085 Phase A test-plan item 5 — contexts spread (owner #6). With dots
  // even-filled, two contexts binding different parameters get centroid nodes
  // in different arc regions, not the same wedge. Red before 085 (fixed-step
  // dots clustered near each arc's start ⇒ clustered centroids ⇒ one wedge).
  it('places two contexts binding different parameters in different arc regions (owner #6)', () => {
    // Single-binding contexts so each node IS its one dot's centroid: ctxA on
    // d0's first parameter, ctxB on d0's last — even-fill spreads these to
    // opposite ends of the arc.
    const dimensions = [dimension('d0', 0)]
    const parametersByDimension = { d0: params('d0', 6) }
    const contexts = [
      { id: 'ctxA', symbol: 'α', parentId: null },
      { id: 'ctxB', symbol: 'β', parentId: null },
    ]
    const bindingsByContext = { ctxA: { d0: 'd0-p0' }, ctxB: { d0: 'd0-p5' } }
    const geometry = layout({ dimensions, parametersByDimension, contexts, bindingsByContext })
    const nodeA = geometry.nodes.find((n) => n.contextId === 'ctxA')
    const nodeB = geometry.nodes.find((n) => n.contextId === 'ctxB')
    const separation = Math.hypot((nodeA?.x ?? 0) - (nodeB?.x ?? 0), (nodeA?.y ?? 0) - (nodeB?.y ?? 0))
    // Far more than collision-jitter apart — they occupy genuinely different
    // regions of the ring, not one narrow wedge.
    expect(separation).toBeGreaterThan(NODE_RADIUS * 8)
  })

  // Design brief targets a 16ms (one-frame) budget for 100 contexts. Asserted
  // here with generous headroom (200ms) for shared/noisy CI hardware; this is
  // a guard against pathological blowups (e.g. an accidental O(n^2) path), not
  // a tight micro-benchmark.
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
