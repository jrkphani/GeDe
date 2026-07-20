import { arc as d3arc } from 'd3-shape'
import { forceCollide, forceSimulation, type SimulationNodeDatum } from 'd3-force'
import { isComplete } from './completeness'

// SPEC §4.2/ADR-0005 — layout is a pure fn(tree) in a fixed 1000x1000 abstract
// space; the SVG viewBox scales it to any container. No x/y is ever stored.
const SIZE = 1000
// d3-shape's arc generator always emits path data centered at (0,0) — it has
// no "center" option. ArcGeometry.d is therefore in that same (0,0)-centered
// coordinate system, NOT the (CENTER,CENTER)-centered one every other
// geometry field uses; consumers must render each arc path inside a
// `transform="translate(${CENTER},${CENTER})"` (see Canvas.tsx). Exported so
// the renderer can never drift from this value.
export const CENTER = SIZE / 2
export const ARC_RADIUS = 400
const ARC_STROKE_HALF_WIDTH = 3 // 6px stroke (STYLE_GUIDE §7), 3px either side of ARC_RADIUS
const GAP_RADIANS = (6 * Math.PI) / 180 // fixed 6deg gap between dimension arcs
// The dimension name sits just INSIDE the ring, centered on the arc midpoint
// (issue 023 fix): parameter labels now live outside the arc, so an outside
// dimension label at the same mid-angle collided with the middle parameter
// (both grow outward along the same ray). Placing it inside keeps it clear.
const LABEL_RADIUS = ARC_RADIUS - 40
// Issue 023 — parameter dots gained a legible visual radius (up from the
// original 5, which measured ~2-4px on screen — see done/023's bug report).
// The dot label sits further out than the arc label offset: dots (and their
// enlarged radius + the compose-mode bound ring, up to BOUND_DOT_RADIUS in
// base.css) sit ON the arc's centerline, so a label needs enough clearance to
// pass the stroke halfwidth AND the dot's own radius, unlike an arc label
// which only needs to clear the stroke.
export const DOT_RADIUS = 8
const DOT_LABEL_RADIUS = ARC_RADIUS + 32
// Issue 085 Phase A — proportional arcs + PURE even-fill dots (supersedes 082
// Phase 1's append-only placement). Each dimension's arc span is proportional
// to its parameter count and its m dots are evenly distributed across that arc
// with NO lower clamp: `slot = segmentSpan / (m + 1)`, dot j at
// `startAngle + slot·(j+1)`. So the last dot lands at
// `startAngle + span·m/(m+1) < endAngle` for every m — dots can never overflow
// the arc, wrap the 12-o'clock seam, or coincide with an early dot. On an
// over-dense arc (far past ADR-0002's optimized 2–8 range) the dots simply
// compress evenly; that is honest degradation (you physically cannot fit
// dozens of 44px targets on one ring), never a collision. The ring reads as a
// balanced chord diagram instead of bunching every dot near each arc's start.
// Adding/removing a parameter re-flows the whole ring; the CSS `cx`/`cy`
// transition (base.css) eases the move so dots settle rather than jump (082's
// dropped "ease residual movement" clause, finally implemented). The
// cross-dimension stability 082 Phase 1 bought is deliberately traded for the
// proportional aesthetic (owner-accepted, see 085 "Open tensions").
//
// NB: an earlier draft floored `slot` at a MIN_DOT_SLOT (4°) to keep a minimum
// pitch. That was WRONG — it clamped the pitch but not the placed angle, so an
// over-dense arc's dots ran past `endAngle`, wrapped the seam, and became
// exactly coincident with the same dimension's early dots (single dim, m=100:
// last dot at 400°, p1≡p91 at distance 0). Pure even-fill removes that failure
// mode entirely.

// Issue 082 Phase 1 regression fix, generalized for 085 Phase A's variable
// spacing — hit-circle overlap. STYLE_GUIDE §7 wants every dot's invisible
// hit circle to be >= 44px on screen (canvasResponsive.dotHitRadiusUnits),
// but two adjacent dots on a dense arc can sit far closer than that at
// ARC_RADIUS — well inside a 44-unit hit radius. Overlapping hit circles cover
// each other's centers, so whichever dot paints last steals clicks aimed at
// its neighbor (docs/issues/082-design-route-ux.md:133).
//
// Under 085's even-fill the tightest spacing is no longer a constant (a sparse
// arc spreads its dots wide, a dense one compresses them), so the safe cap is
// computed PER LAYOUT: `CanvasGeometry.maxDotHitRadius` is HALF the tightest
// chord between any two dots this call produced (half of it sits exactly at the
// midpoint between the two, so two circles of that radius touch but never
// overlap past each other's center). There is no DOT_RADIUS floor: flooring
// would let the cap exceed half the true spacing on an over-dense arc and
// re-introduce the exact overlap 5bbc8bc fixed.
//
// Issue 099-2c — this is a TRUE all-pairs minimum. It used to be a
// within-dimension-only minimum, justified thus: the cross-gap distance between
// dimension A's last dot and B's first is `slotA + GAP_RADIANS + slotB` angular
// — strictly greater than either slot alone — so no cross-dimension pair can be
// tighter than the within-dimension minimum. That argument is SOUND, but it only
// establishes a minimum over the pairs it actually ranges over, and the loop
// skipped any dimension with m < 2. So a ring where NO dimension has two dots
// (e.g. three dimensions of one parameter each) has real, finite cross-dimension
// pairs and yet fell through to an effectively open ARC_RADIUS cap. Harmless
// while the hit radius was small; not once 2c sizes it in SCREEN space, where
// zooming out grows it until neighbours overlap — and in compose mode an
// overlapping circle carries the bind handler, so the WRONG parameter binds.
// Measuring every pair closes the hole and returns an identical value whenever
// some dimension has m >= 2, so the normal case is unchanged.
//
// Consumers (Canvas.tsx) take `min(dotHitRadiusUnits(width),
// geometry.maxDotHitRadius)`. This deliberately lets the effective hit radius
// fall below STYLE_GUIDE §7's 44px floor on a dense ring — honoring 44px there
// is physically impossible without overlap.
// Minimum vertical gap between two labels on the same side of the ring, in
// viewBox user units. The label font is 13 user units tall (--text-mono, sized
// in the SVG's own coordinate space, so it does not change with container
// width); ~20 leaves a comfortable line-height so labels near the poles — where
// the arc's y barely changes per angle and dots bunch vertically — never touch.
const MIN_LABEL_GAP = 20
export const NODE_RADIUS = 14
const COLLIDE_RADIUS = NODE_RADIUS + 6
const JITTER_RADIUS = 8
// d3-force's default schedule assumes ~300 ticks to decay alpha from 1 to its
// alphaMin (0.001). Collision-only resolution over small, mostly-non-
// -overlapping node sets converges much sooner; running fewer ticks with a
// matching steeper alphaDecay reaches the same full convergence for a
// fraction of the cost — this budget is asserted directly (see
// canvasLayout.test.ts's 100-context perf test).
const SIMULATION_TICKS = 30
const ALPHA_MIN = 0.001
const SIMULATION_ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / SIMULATION_TICKS)

export interface DimensionInput {
  id: string
  name: string
  color: string
  sort: number
}

export interface ParameterInput {
  id: string
  name: string
  sort: number
}

export interface ContextInput {
  id: string
  symbol: string
  parentId: string | null
}

export interface CanvasLayoutInput {
  dimensions: readonly DimensionInput[]
  parametersByDimension: Readonly<Record<string, readonly ParameterInput[]>>
  contexts: readonly ContextInput[]
  bindingsByContext: Readonly<Record<string, Readonly<Record<string, string>>>>
  // Issue 011 — child count per context for the node badge. On a child canvas
  // the loaded contexts are all siblings (no parent/child pairs among them), so
  // the count can't be derived from `contexts` alone; the store supplies it. If
  // omitted, it falls back to counting parentId links within `contexts` (the
  // pre-011 single-level behaviour).
  childCountByContext?: Readonly<Record<string, number>> | undefined
}

export interface Point {
  x: number
  y: number
}

// SVG text-anchor for a radial label, chosen by which side of the circle it
// sits on so the text always reads OUTWARD and never crosses the arc/dots
// (issue 023 fix): right half → 'start' (grows right), left half → 'end'
// (grows left), near the vertical top/bottom → 'middle' (centered).
export type LabelAnchor = 'start' | 'middle' | 'end'

export interface ArcGeometry {
  dimensionId: string
  d: string
  color: string
  label: string
  labelPos: Point
  labelAnchor: LabelAnchor
  empty: boolean
}

export interface DotGeometry {
  dimensionId: string
  parameterId: string
  x: number
  y: number
  color: string
  label: string
  labelPos: Point
  labelAnchor: LabelAnchor
}

export interface NodeGeometry {
  contextId: string
  symbol: string
  x: number
  y: number
  isDraft: boolean
  childCount: number
}

export interface CanvasGeometry {
  viewBox: string
  arcs: ArcGeometry[]
  dots: DotGeometry[]
  nodes: NodeGeometry[]
  // Issue 085 Phase A — the largest dot hit-circle radius (viewBox units) that
  // keeps two adjacent within-dimension hit circles from overlapping, given
  // THIS layout's actual (variable) dot spacing. Consumed by Canvas.tsx as the
  // cap in `min(dotHitRadiusUnits(width), maxDotHitRadius)`.
  maxDotHitRadius: number
}

// A point on the circle at the given radius/angle, using d3's angle
// convention (0 = north/12-o'clock, increasing clockwise) so arc paths and
// dot/node placement agree on the same coordinate frame.
function pointAt(radius: number, angle: number): Point {
  return { x: CENTER + radius * Math.sin(angle), y: CENTER - radius * Math.cos(angle) }
}

// Issue 039 (028 phase b) — bundling strength for spokePath below: how far the
// quadratic's control point is pulled from the straight chord's midpoint
// toward CENTER. 0 = straight line, 1 = control point sits exactly at CENTER.
// A single fixed constant per the issue's scope (density-adaptive bundling is
// an explicit non-goal for this slice); 0.35 reads as a legible inward bend
// without the spline reading as ornament (STYLE_GUIDE §7 "drafting
// restraint").
export const SPOKE_BUNDLE_PULL = 0.35

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

// Issue 039 (028 phase b) — deterministic bundled spoke curve (SPEC §4.2,
// ADR-0005, STYLE_GUIDE §7 amended "Connections"). Picked the hand-rolled
// quadratic Bezier over `d3-shape`'s `curveBundle` (the issue's other
// option): both are dependency-available (d3-shape is already used for arcs
// above) and both are pure/deterministic, but the quadratic's determinism is
// visibly trivial from the formula alone — `curveBundle` derives its curve
// from a B-spline basis over the whole point list, which is harder to reason
// about byte-for-byte across engines/versions. `Canvas.tsx` calls this per
// spoke; it does no geometry math itself (stays presentational, per Canvas's
// own header comment).
//
// Control point = the straight chord's midpoint, pulled SPOKE_BUNDLE_PULL of
// the way toward CENTER — the same bundling attractor as the design brief's
// "hierarchical edge bundling" prior art. `from`/`to` are reproduced exactly
// as given (only the interior bends), so endpoints/hit circles/labels are
// untouched.
export function spokePath(from: Point, to: Point): string {
  const chordMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  const ctrl = lerpPoint(chordMid, { x: CENTER, y: CENTER }, SPOKE_BUNDLE_PULL)
  return `M ${from.x} ${from.y} Q ${ctrl.x} ${ctrl.y} ${to.x} ${to.y}`
}

// Side-aware text anchor so a radial label grows away from the circle instead
// of overlapping it. sin(angle) is the horizontal offset from center; the
// ±0.2 dead-band (~11.5° either side of vertical) keeps top/bottom labels
// centered rather than jittering between start/end.
function labelAnchorFor(angle: number): LabelAnchor {
  const horizontal = Math.sin(angle)
  if (horizontal > 0.2) return 'start'
  if (horizontal < -0.2) return 'end'
  return 'middle'
}

// De-collide parameter labels vertically (issue 023 crowding fix): near the top
// and bottom of the ring the arc's y barely changes per angle, so evenly-spaced
// dots produce labels that stack. Per side (labels grow left or right, so the
// two sides never collide with each other), sort by y and push any pair closer
// than MIN_LABEL_GAP apart, then shift the whole side back so its mean y is
// unchanged — the group stays anchored to its dots instead of drifting down.
// Pure and deterministic: it mutates only the fresh labelPos objects this call
// created (ADR-0005).
function declutterLabels(dots: DotGeometry[]): void {
  const sides = [
    dots.filter((d) => d.labelPos.x >= CENTER),
    dots.filter((d) => d.labelPos.x < CENTER),
  ]
  for (const side of sides) {
    if (side.length < 2) continue
    side.sort((a, b) => a.labelPos.y - b.labelPos.y)
    const meanBefore = side.reduce((sum, d) => sum + d.labelPos.y, 0) / side.length
    for (let i = 1; i < side.length; i++) {
      const floor = (side[i - 1] as DotGeometry).labelPos.y + MIN_LABEL_GAP
      const dot = side[i] as DotGeometry
      if (dot.labelPos.y < floor) dot.labelPos.y = floor
    }
    const meanAfter = side.reduce((sum, d) => sum + d.labelPos.y, 0) / side.length
    const shift = meanBefore - meanAfter
    for (const d of side) d.labelPos.y += shift
  }
}

// Deterministic, non-cryptographic string hash (FNV-1a) — used only to seed a
// small per-context jitter so two contexts never start a collision simulation
// at the exact same coordinate (see the Math.random() note below).
function hashUnit(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

interface SimNode extends SimulationNodeDatum {
  contextId: string
}

// SPEC §4.2 — auto-placed by centroid of bound-parameter positions "with
// hash-seeded jitter for collisions". ADR-0005 forbids any randomness:
// d3-force's internal jiggle() falls back to Math.random() only when two
// nodes are initialized at the exact same coordinate. Seeding every node's
// initial position with a hash of its own (stable) context id means distinct
// contexts never coincide exactly, so that Math.random() fallback path is
// never exercised and the fixed-tick simulation below is fully deterministic.
function seededStart(id: string, base: Point): Point {
  const angle = hashUnit(id) * 2 * Math.PI
  return { x: base.x + JITTER_RADIUS * Math.cos(angle), y: base.y + JITTER_RADIUS * Math.sin(angle) }
}

export function layout(input: CanvasLayoutInput): CanvasGeometry {
  const { dimensions, parametersByDimension, contexts, bindingsByContext, childCountByContext } = input
  const viewBox = `0 0 ${SIZE} ${SIZE}`
  if (dimensions.length === 0)
    return { viewBox, arcs: [], dots: [], nodes: [], maxDotHitRadius: ARC_RADIUS }

  const sortedDimensions = [...dimensions].sort((a, b) => a.sort - b.sort)
  const n = sortedDimensions.length
  const totalGap = n * GAP_RADIANS
  const availableSpan = 2 * Math.PI - totalGap

  // Issue 085 Phase A — arc span proportional to this dimension's parameter
  // count (chord-diagram sizing): `segmentSpan_i = availableSpan · m_i / Σm`.
  // Guards: Σm === 0 (every dimension still empty) has no proportion to
  // compute, so fall back to equal arcs — matching the pre-085 equal-slice
  // behaviour until the first parameter exists. A single dimension (n === 1)
  // needs no special case: its share is availableSpan · m/m = the full ring
  // minus one gap. An empty dimension among non-empty ones gets a zero-width
  // arc by construction (a sparse dimension gets a short arc — 085 Decision 5,
  // explicitly accepted); its label still renders so it stays discoverable.
  const paramCounts = sortedDimensions.map((dim) => (parametersByDimension[dim.id] ?? []).length)
  const totalParams = paramCounts.reduce((sum, c) => sum + c, 0)
  const spanFor = (i: number): number =>
    totalParams === 0 ? availableSpan / n : availableSpan * ((paramCounts[i] as number) / totalParams)

  // Cumulative start angles: with variable spans a dimension's start is the
  // running sum of every prior span plus one gap each, not `i · (span + gap)`.
  let runningAngle = 0
  const startAngles = sortedDimensions.map((_, i) => {
    const start = runningAngle
    runningAngle += spanFor(i) + GAP_RADIANS
    return start
  })

  const arcs: ArcGeometry[] = []
  const dots: DotGeometry[] = []
  const dotPositionsByDimension = new Map<string, Map<string, Point>>()
  // Tightest chord between two adjacent within-dimension dots this call
  // produced; drives maxDotHitRadius below. Infinity until a dimension with
  // >= 2 dots is seen (a lone or absent dot has no neighbour to overlap).

  sortedDimensions.forEach((dim, i) => {
    const segmentSpan = spanFor(i)
    const startAngle = startAngles[i] as number
    const endAngle = startAngle + segmentSpan
    const midAngle = (startAngle + endAngle) / 2

    const arcPath = d3arc()({
      innerRadius: ARC_RADIUS - ARC_STROKE_HALF_WIDTH,
      outerRadius: ARC_RADIUS + ARC_STROKE_HALF_WIDTH,
      startAngle,
      endAngle,
    })

    const params = [...(parametersByDimension[dim.id] ?? [])].sort((a, b) => a.sort - b.sort)
    arcs.push({
      dimensionId: dim.id,
      d: arcPath ?? '',
      color: dim.color,
      label: dim.name,
      labelPos: pointAt(LABEL_RADIUS, midAngle),
      labelAnchor: 'middle', // centered inside the ring at the arc midpoint
      empty: params.length === 0,
    })

    const positions = new Map<string, Point>()
    // Issue 085 Phase A — pure even-fill: evenly distribute m dots across the
    // arc, `slot = segmentSpan / (m + 1)`, dot j at `startAngle + slot·(j+1)`.
    // The first and last dot each sit one slot in from an edge, so the dots
    // span the whole arc (never bunching at the start) and the last dot lands
    // at `startAngle + span·m/(m+1) < endAngle` — no overflow, no seam wrap, no
    // coincidence — for every m. No lower clamp: an over-dense arc compresses
    // evenly (honest degradation), and the maxDotHitRadius cap below tracks
    // whatever spacing this actually produces so hit circles never overlap.
    const m = params.length
    const slot = m > 0 ? segmentSpan / (m + 1) : 0
    params.forEach((param, j) => {
      const angle = startAngle + slot * (j + 1)
      const pos = pointAt(ARC_RADIUS, angle)
      positions.set(param.id, pos)
      dots.push({
        dimensionId: dim.id,
        parameterId: param.id,
        x: pos.x,
        y: pos.y,
        color: dim.color,
        label: param.name,
        labelPos: pointAt(DOT_LABEL_RADIUS, angle),
        labelAnchor: labelAnchorFor(angle),
      })
    })
    dotPositionsByDimension.set(dim.id, positions)
  })

  declutterLabels(dots)

  const dimensionIds = sortedDimensions.map((d) => d.id)
  const childCountByParent = new Map<string, number>()
  for (const ctx of contexts) {
    if (!ctx.parentId) continue
    childCountByParent.set(ctx.parentId, (childCountByParent.get(ctx.parentId) ?? 0) + 1)
  }

  const simNodes: SimNode[] = contexts.map((ctx) => {
    const bindings = bindingsByContext[ctx.id] ?? {}
    const boundPoints: Point[] = []
    for (const dimId of dimensionIds) {
      const paramId = bindings[dimId]
      if (!paramId) continue
      const pos = dotPositionsByDimension.get(dimId)?.get(paramId)
      if (pos) boundPoints.push(pos)
    }
    const centroid: Point =
      boundPoints.length > 0
        ? {
            x: boundPoints.reduce((sum, p) => sum + p.x, 0) / boundPoints.length,
            y: boundPoints.reduce((sum, p) => sum + p.y, 0) / boundPoints.length,
          }
        : { x: CENTER, y: CENTER }
    const start = seededStart(ctx.id, centroid)
    return { contextId: ctx.id, x: start.x, y: start.y }
  })

  // No physics beyond collision (ADR-0005): fixed synchronous ticks, no
  // requestAnimationFrame, no randomness once initial positions are seeded.
  if (simNodes.length > 0) {
    const simulation = forceSimulation(simNodes)
      .alphaDecay(SIMULATION_ALPHA_DECAY)
      .force('collide', forceCollide<SimNode>(COLLIDE_RADIUS))
      .stop()
    for (let i = 0; i < SIMULATION_TICKS; i++) simulation.tick()
  }

  const simByContextId = new Map(simNodes.map((n) => [n.contextId, n]))
  const nodes: NodeGeometry[] = contexts.map((ctx) => {
    const bound = new Set(Object.keys(bindingsByContext[ctx.id] ?? {}))
    const sim = simByContextId.get(ctx.id)
    return {
      contextId: ctx.id,
      symbol: ctx.symbol,
      x: sim?.x ?? CENTER,
      y: sim?.y ?? CENTER,
      isDraft: !isComplete(dimensionIds, bound),
      childCount: childCountByContext?.[ctx.id] ?? childCountByParent.get(ctx.id) ?? 0,
    }
  })

  // Half the tightest adjacent-dot chord keeps two neighbouring hit circles
  // touching but never overlapping. No DOT_RADIUS floor: flooring would let the
  // cap exceed half the true spacing on an over-dense arc and re-admit the
  // overlap 5bbc8bc fixed.
  //
  // Issue 099-2c — this is now a TRUE all-pairs minimum, which is what this
  // comment always CLAIMED but the code did not do: the per-arc pass above only
  // measures WITHIN-dimension chords (`if (m >= 2)`), so two dots in DIFFERENT
  // dimensions facing each other across a 6° arc gap were never measured, and a
  // ring where no dimension has two dots fell through to an effectively open
  // ARC_RADIUS cap. That hole was harmless while the hit radius was small, but
  // 2c sizes it in SCREEN space, so under zoom-out it grows until neighbours
  // overlap — and in compose mode an overlapping circle carries the bind
  // handler, so the wrong parameter gets bound. Measuring every pair closes it
  // at the source. O(n²) over a ring's worth of dots (tens) — negligible, and it
  // runs inside the same `useMemo` as the rest of the layout.
  let minPairwise = Number.POSITIVE_INFINITY
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const a = dots[i] as (typeof dots)[number]
      const b = dots[j] as (typeof dots)[number]
      minPairwise = Math.min(minPairwise, Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  // A single dot (or none) has nothing to overlap, so leave the cap effectively
  // open (ARC_RADIUS) and let dotHitRadiusUnits' 44px target win.
  const maxDotHitRadius = Number.isFinite(minPairwise) ? minPairwise / 2 : ARC_RADIUS

  return { viewBox, arcs, dots, nodes, maxDotHitRadius }
}
