# 039: Canvas spline bundling (028 phase b)

- **Status**: OPEN
- **Milestone**: M6 (Polish — canvas legibility)
- **Blocked by**: 028 (SHIPPED — phase a adjacency emphasis; this is the deferred phase b)

## Slice

As a designer looking at a **dense** canvas — many contexts each binding many parameters — the spokes read as clean **splines bundled toward the interior** instead of a straight-line star that crosses into an unreadable knot at the centre. The curve is a deterministic function of its endpoints (ADR-0005), computed in the pure layout; nothing animates.

## Motivation

Issue 028 shipped phase (a) — hover/focus **adjacency emphasis** (fade the unconnected) — which makes a *focused* reading legible. But the **resting** dense canvas is still a straight-line star: with N contexts × up to D bindings, the interior fills with crossing radial lines. STYLE_GUIDE §7 ("Connections", amended by 028) and principle 4 (amended — "connections may bundle into deterministic splines … computed from the data, never hand-arranged") already **sanction** this; 028 explicitly deferred it as a separate slice with `Status` noting "phase (b) spline bundling is deferred". This issue is that slice.

The prior art is **hierarchical edge bundling** (d3): edges routed through a shared interior read as grouped ribbons rather than a hairball. GeDe's radial hub-and-spoke has a natural bundling attractor — the circle's centre.

## Scope

- **Move spoke-path construction into the pure layout** (ADR-0005): a `spokePath(from: Point, toDot: Point) → string` (SVG `d`) in `canvasLayout.ts`, so `Canvas` stays presentational and the curve is unit-testable without the DOM. Today the spoke is an inline straight `<line>` in `Canvas.tsx` (drawn from the node centroid to each bound dot); replace it with a `<path d={…}>`.
- **Deterministic bundled curve**: each spoke curves toward the interior — a fixed function of its two endpoints (and `CENTER`), identical input → identical path. Pick **one** construction and document its constant: either `d3-shape` `line().curve(curveBundle.beta(β))` over `[node, CENTER-ish, dot]`, or a hand-rolled quadratic Bézier with a control point pulled a fixed fraction toward `CENTER`. Document the bundling strength (β / pull fraction): straighter for few spokes, more bundled as density grows is **out of scope** unless trivial — start with a single constant β and note it.
- **Composes with 028(a) emphasis**: bundled spokes still mute/emphasize with the adjacency set (the `.canvas--muted` / spoke-opacity logic is unchanged; only the path geometry changes). Spokes still render only for `adjacent.contextIds`.
- **No motion on the curve** (§8): the curvature is static; the existing spoke opacity/emphasis transition (≤100ms) is untouched. Reduced-motion safe by construction (geometry, not animation).
- **Endpoints unchanged**: only the *connecting path* curves — node centroids, dot positions, the 44px hit circles, and labels (023) are all unchanged. Verify bundling doesn't route a spline through a label or dot in a way that reads as a collision.

Out of scope: density-adaptive β (a single documented constant first); animating the bundle; re-laying-out nodes/dots (positions are 008's pure layout, untouched); changing the emphasis logic (028a).

## Design brief

- **Derived routing, not decoration** (principle 4, amended): the spline is computed from the endpoints + `CENTER`; it encodes the same connection a straight line did, just legibly. It is never hand-placed and never means anything a straight spoke didn't.
- **Chord/edge-bundling aesthetic, drafting restraint** (STYLE_GUIDE §7): bundle enough to de-clutter, not so much it reads as ornament. The curve stays in dimension colour (colour-is-data, §2/principle 3); no new hue, no shadow, square-world chrome elsewhere.
- **Determinism is the invariant** (ADR-0005): `spokePath` is pure and snapshot-testable; the canvas remains "same input → same output", so the layout can feed either a straight or bundled renderer.

**References**: issue 028 (phase a shipped; this is phase b — the deferred "Connections" scope + Test-first item 5) · STYLE_GUIDE §7 (Canvas "Connections", amended), §8 (motion — static curve), §2/principle 3 (colour is data), principle 4 (derived routing, amended) · ADR-0005 (pure deterministic layout) · SPEC §4.2 · issue 009 (spokes — straight-line origin), 023 (labels — bundling must not obscure them) · Prior art: D3 hierarchical edge bundling (`curveBundle.beta`).

## Test-first plan

1. **Pure (`canvasLayout.test.ts`)**: `spokePath(from, toDot)` returns a non-empty SVG path that is **not** a straight segment (asserts a control/curve command, e.g. `Q`/`C`), and is **deterministic** — identical input → byte-identical `d` (ADR-0005).
2. **Pure — bundling direction**: the curve's mid-point sits **closer to `CENTER`** than the straight chord's mid-point (it bends inward), for a spread of endpoint angles.
3. **Component (`Canvas.test.tsx`)**: an emphasized context renders its spokes as `<path>` (bundled), one per bound dot; muting/emphasis (028a) still applies to the bundled spokes; a straight-vs-bundled feature parity check (same count, same endpoints).
4. **Reduced-motion / static**: the spoke path has no animation; the existing emphasis opacity transition is unaffected.
5. **Visual/e2e (manual + a `canvas.spec` extension)**: a **dense** canvas (many contexts × bindings) screenshot shows bundled, legible spokes rather than a straight-line knot — the HANDOFF gotcha applies (geometry needs a real screenshot, not just component data).
6. **Regression**: existing canvas/selection/compose/recursion/canvas-focus specs pass unchanged (spokes still connect the right node↔dot pairs; only their shape changes).

## Acceptance criteria

- [ ] Spokes render as deterministic bundled splines from a pure `spokePath` in the layout; identical input → identical path; `Canvas` stays presentational.
- [ ] Bundling visibly de-clutters a dense canvas (verified by screenshot) without obscuring dots/labels; endpoints, hit circles, and 028(a) emphasis are unchanged.
- [ ] No animation on the curve; reduced-motion safe; colour stays dimension-data (no new hue).
- [ ] `npm run verify` green; canvas layout snapshots regenerated and reviewed.

## Implementation notes

- `Canvas.tsx` spokes are currently straight `<line>`s built from `dotPositionByKey` + the node centroid (see 009/028a). Swap to `<path d={spokePath(node, dot)}>`; keep the same `.canvas-spoke` class + emphasis/mute classes so 028(a) and existing specs keep working.
- `spokePath` options (pick one, document the constant): `d3-shape` `line().curve(d3.curveBundle.beta(β))` over `[node, CENTER, dot]` (β≈0.85 is a gentle bundle; β=1 is straight); **or** a quadratic `M node Q ctrl dot` where `ctrl = lerp(midpoint(node,dot), CENTER, pull)` with a fixed `pull` (~0.35). The quadratic is dependency-free and trivially deterministic; `curveBundle` matches the edge-bundling literature. `d3-shape` is already a dependency.
- Watch label collisions (023): a spline bending inward should not cross a parameter label sitting *outside* the arc — geometrically it bends the other way (toward centre), so this should be safe, but confirm on the dense screenshot.
- Density-adaptive β (straighter when sparse, more bundled when dense) is a possible follow-up — ship a single documented constant first and note the deferral (no silent caps).
