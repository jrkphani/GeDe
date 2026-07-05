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
