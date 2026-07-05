# 008: Circle canvas, read-only, deterministic layout

- **Status**: OPEN
- **Milestone**: M2
- **Blocked by**: 004

## Slice

As a designer I see my register as a circle: n arcs, parameter dots, context nodes at binding centroids. Same data, same picture, every time, at every screen size.

## Scope

- Pure layout module: `layout(canvasTree) → geometry` in a fixed 1000×1000 space — arc segments per dimension (sort order, gaps), dot placement, centroid node placement, synchronous d3-force collision ticks (ADR-0005).
- SVG renderer: `<Canvas>`, `<DimensionArc>`, `<ParameterDot>`, `<ContextNode>`; `viewBox` scaling; label tiers per STYLE_GUIDE § Canvas responsiveness (container queries).
- Read-only: no selection, no editing (slice 009/010).

## Design brief

- **Composition**: the circle sits directly on the graph-paper ground (no panel) — a drawing on drafting paper. Arcs 6px, butt caps, gaps between dimensions; parameter dots on the arc; labels outside in muted ink.
- **Node anatomy**: context nodes are ink circles with the mono symbol; drafts get a dashed ring; contexts with children show a small mono count. Everything readable at 40% dim (the unselected state that arrives in 009).
- **Responsiveness**: the three container-width tiers from STYLE_GUIDE § Canvas responsiveness govern labels; the circle always renders 1:1, centered on the grid; the square viewport is `min(width, available height)`.
- **Empty state**: dimmed arcs at full geometry with "Bind your first context" centered — the structure is visible before any data exists, teaching the shape of the tool.
- **Degenerate rendering**: a dimension with zero parameters draws its arc empty (no dots) with the label; nothing collapses or NaNs.
- **Performance**: layout is memoized per tree revision; a 100-context canvas renders < 16ms after layout (budget asserted in a perf test).
- **No interaction this slice** — read-only. Hover/selection vocabulary arrives in 009, which keeps this slice's visual snapshots stable.

**References**: SPEC §4.2, invariant 5 · STYLE_GUIDE §2.1, §7 · TECH_STACK §4 · ADR-0005

> **UI build convention (018–020):** the canvas is SVG, but every design value comes from tokens (`var(--…)`, `--dim-*` for data colors) — no hardcoded colors (stylelint-enforced). Any DOM chrome around the canvas (toolbar buttons, menus, breadcrumbs) uses the shared `src/components/ui/` primitives, not raw elements. See ADR-0007 · STYLE_GUIDE §11.

## Test-first plan

1. Unit: layout snapshot tests at n = 2, 3, 4 with fixed fixtures — byte-identical geometry across runs and Node versions.
2. Unit: collision — two contexts on the same tuple never overlap and always resolve to the same offsets (determinism under repetition).
3. Unit: draft context (missing binding) placed with distinct style flag; zero-parameter dimension renders an empty arc without NaN geometry.
4. Component: container resize crosses the 640px/400px label tiers — assert label rendering mode switches; circle aspect stays 1:1.
5. e2e (visual): screenshot at n = 3 fixture matching the prototype composition; Playwright snapshot at two viewport sizes.

## Acceptance criteria

- [ ] Layout module has zero imports from React or the store (pure, per SPEC invariant 5).
- [ ] Adding a context to the fixture changes only that node's geometry (no global reshuffle) — regression test.
- [ ] No stored positions anywhere — schema untouched by this slice.
