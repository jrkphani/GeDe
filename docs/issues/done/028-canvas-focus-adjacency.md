# 028: Canvas focus + adjacency (and optional spline bundling)

- **Status**: SHIPPED — phase (a) hover/focus adjacency emphasis (main, commit 3438850; e2e corrected in the follow-up). **Phase (b) spline bundling is deferred** — open a follow-up issue if the straight-spoke clutter warrants it.
- **Milestone**: M6 (Polish — canvas legibility)
- **Blocked by**: 008, 009 (SHIPPED); builds on 023 (labels) and the label de-collision fix

## Slice

As a designer reading a dense canvas I can **hover or keyboard-focus any element and instantly see everything connected to it** — a context's bindings, a parameter's contexts, a dimension's whole membership — while the unrelated rest fades back. Click **locks** that focus (the existing selection). Optionally, spokes bundle into deterministic splines so a busy interior stays readable. This is the "focus + context" grammar mature circular/graph visualizations already codify; GeDe adapts the *pattern*, not a library.

## Motivation (from design review, this session)

The canvas today only supports **click-to-select** a context (which lights its spokes) plus compose/drill. Two gaps:

1. **No reverse or lateral reading.** You cannot ask "which contexts use *this* parameter?" or "what does *this* dimension touch?" — the most common questions when auditing coverage — because hovering a dot or arc does nothing.
2. **Clutter at scale.** With many contexts binding many parameters, straight radial spokes cross the interior into an unreadable star. Chord / hierarchical-edge-bundling layouts solve this by (a) fading unrelated marks on focus and (b) bundling connections into splines.

The canvas is **not** structurally a chord diagram (chords relate circumference groups to each other; GeDe relates *inner* context nodes *out* to circumference parameter dots — a radial hub-and-spoke / bipartite association, closest kin to **hierarchical edge bundling**). But the **interaction vocabulary** from those idioms transfers directly:

- **ECharts graph** — `emphasis: { focus: 'adjacency' }`: hover a node → highlight adjacent nodes + edges, blur the rest. This is exactly the target behavior, already named.
- **nivo `@nivo/chord`** — declarative opacity states: `arcHoverOpacity` (~1) / `arcHoverOthersOpacity` (~0.25), `ribbonHoverOpacity` / `ribbonHoverOthersOpacity`, plus `onArc/RibbonMouseEnter/Leave` and `tooltip`. A clean API surface to mirror.
- **D3 hierarchical edge bundling** — hover a leaf → colour incident links, fade the rest; the canonical "highlight incoming/outgoing" pass.

STYLE_GUIDE §7 and principle 4 were amended (this session) to sanction both derived emphasis and derived spline routing.

## Scope

- **Adjacency emphasis on hover/focus**, symmetric across the three roles:
  - **context node** → its spokes + the dots it binds
  - **parameter dot** → every context bound to it + those contexts' spokes
  - **dimension arc** → its parameter dots + the contexts bound within that dimension
  Everything not adjacent fades to `--canvas-muted` (~0.2). The focused/adjacent set stays at full opacity.
- **Keyboard parity**: the roving-tabindex focus already on nodes/dots (008–010) triggers the same emphasis; blur clears it.
- **Click locks** the focus — reuse `selectedContextId` for context nodes; extend selection to a dot/arc focus where it makes sense (or keep lock = context-only and dots/arcs hover-only in phase 1).
- **Transient vs locked**: hover is transient (clears on mouseleave/blur); selection persists (existing). A locked selection + a hover compose predictably (hover previews, does not clobber the lock).
- **Reduced-motion-safe by construction**: emphasis only ever *mutes others*; the resting state shows all marks at full opacity, so `prefers-reduced-motion` (instant, no transition) strands nothing.
- **Phase 2 (optional, behind the same interaction): spline bundling.** Render spokes as deterministic splines curved toward the interior instead of straight lines, to cut crossing-clutter. Geometry stays in the pure layout (ADR-0005).
- **Truncated-label reveal** (ties to 023's responsive tiers): a hovered/focused element with a truncated label reveals its full label (tooltip or un-truncate), consistent with the §7 responsiveness table.

Out of scope: changing dot/arc/node **positions** (the pure `layout()` placement is unchanged); compose-mode binding behaviour (010); adopting a charting library (adapt patterns only — keep `Canvas` presentational SVG and the deterministic layout).

## Design brief

- **Emphasis model** (STYLE_GUIDE §7, amended): a single `emphasisId` + role (`context | parameter | dimension`) drives a pure **adjacency predicate**; adjacent marks keep full opacity, the rest get a `.canvas--muted` class (`opacity: var(--canvas-muted)`). No colour change, no scale change — opacity only (principle 3: colour is data; §4: emphasis via fade, not hue).
- **Motion** (§8, amended): opacity transition ≤ 100ms ease-out; reduced-motion → instant; resting state fully legible.
- **Determinism** (ADR-0005): adjacency is derived from the same `bindingsByContext` the layout already consumes — a pure function, unit-testable without the DOM. If splines ship, their control points are a fixed function of the two endpoints (e.g. a quadratic toward `CENTER`, or `d3` bundle), never random, never animated.
- **Presentational `Canvas`** (008/009): `Canvas` stays props-only — `DesignSurface` owns the hover/selection state and passes `emphasisId`/`hoveredId` down, exactly as it already owns `selectedContextId`. `Canvas` tests need no store/DB.
- **Accessibility** (§10): emphasis pairs with the existing focus ring / selection cues; fading is never the *sole* signal (the focus ring and spokes still carry meaning); muted marks keep ≥ 3:1 where they remain meaningful, or are inert.

**References**: STYLE_GUIDE §7 (Canvas — focus+adjacency + connections, amended by this issue), §4 (selection/elevation), §8 (motion — opacity emphasis, amended), §10 (a11y), principle 4 (derived emphasis/routing, amended) · SPEC §4.2 (canvas projection) · ADR-0005 (pure deterministic layout) · issues 008 (layout), 009 (selection/spokes), 010 (compose), 023 (labels) · Prior art: ECharts `focus:'adjacency'`, nivo chord hover-opacity, D3 hierarchical edge bundling.

> **UI build convention (018–020):** `Canvas` is the sanctioned SVG surface (not a `ui/` primitive); style only via design tokens — add `--canvas-muted` to `tokens.css` (both themes) rather than a hardcoded opacity. No charting library.

## Test-first plan

1. **Pure (`canvasAdjacency.test.ts`, new)**: `adjacentSet(emphasis, { bindingsByContext, dots, ... })` returns the correct element ids for each role — a context's bound dots + its spoke ids; a parameter's bound context ids; a dimension's dot + context ids. Deterministic; boundary cases (unbound context, parameter no context uses, empty dimension).
2. **Component (`Canvas.test.tsx`)**: hovering a context node adds `.canvas--muted` to non-adjacent marks and leaves adjacent ones un-muted; `mouseleave` clears it. Same for a parameter dot and a dimension arc.
3. **Component**: keyboard focus (roving tabindex) produces the same emphasis; blur clears it; a locked selection composes with a transient hover without being cleared.
4. **Reduced-motion / resting**: with no hover and no selection, **no** mark carries `.canvas--muted` (full legibility) — guards the §8 "resting state fully legible" contract (and the reduced-motion gotcha).
5. **(Phase 2) Unit (`canvasLayout.test.ts`)**: a spoke's path is a deterministic spline given its endpoints; identical input → identical path (ADR-0005).
6. **e2e (`canvas-focus.spec.ts`, new)**: bind two contexts across two dimensions; hover a parameter dot and assert the bound contexts' spokes are emphasized while an unrelated arc is muted (opacity), the exact "who uses this parameter" read.
7. **Regression**: existing canvas/selection/compose/recursion specs pass unchanged (selection, spokes, drill, compose untouched).

## Acceptance criteria

- [ ] Hovering/focusing a context, parameter dot, or dimension arc emphasizes its adjacent marks and fades the rest; leaving/blurring restores.
- [ ] Click still locks selection (existing behaviour); a transient hover never clobbers a lock.
- [ ] The resting state (no hover/selection) shows every mark at full opacity; `prefers-reduced-motion` strands nothing.
- [ ] Adjacency is a pure, unit-tested function; `Canvas` stays presentational; no charting library added; `--canvas-muted` is token-driven in both themes.
- [ ] (If phase 2 ships) spokes render as deterministic splines; layout snapshots regenerated and reviewed.
- [ ] `npm run verify` green; manual browser verification of a dense canvas (HANDOFF gotcha: geometry/opacity need a real screenshot, not just component data).

## Implementation notes

- **State seam**: `DesignSurface` already owns `selectedContextId`; add a transient `hoveredMark` ({ id, role }) and pass a resolved `emphasisId`/`role` (hover ?? selection) into `Canvas` as props. `Canvas` stays store-free.
- **Adjacency predicate**: derive from `bindingsByContext` (already in scope for the layout). Precompute an adjacency map once per render; each mark checks membership → `.canvas--muted` or not. O(bindings), well within the frame budget.
- **CSS**: `.canvas--muted { opacity: var(--canvas-muted); transition: opacity var(--motion-fast) ease-out; }`; add `--canvas-muted` (~0.2 light / ~0.22 dark) to `tokens.css`. The blanket reduced-motion rule already kills the transition; the resting (un-muted) state is correct with `transition: none`.
- **Spokes today** are straight lines in `Canvas.tsx` computed per bound dimension. For phase-2 splines, move the path construction into the pure layout (a `spokePath(from, toDot)` returning an SVG `d`), so `Canvas` stays presentational and the curve is testable. Consider `d3-shape` `line().curve(curveBundle.beta(…))` or a hand-rolled quadratic toward `CENTER` — pick one, keep it deterministic, document beta.
- **Adapt, don't adopt**: the opacity constants can start from nivo's (focused ~1 / others ~0.25) tuned to the drafting palette; the `focus: 'adjacency'` semantics come from ECharts; the incident-highlight pass from D3 edge bundling. None of those libraries are added as dependencies.
- **Phasing** (≤ 5-file rule): land **(a) adjacency emphasis** first (highest value, lowest risk — opacity + a pure predicate, no geometry change), then **(b) spline bundling** as a separate slice if the straight-spoke clutter still warrants it.
