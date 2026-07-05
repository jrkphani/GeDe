# 012: Coverage matrix — documented vs unexplored tuples

- **Status**: SHIPPED
- **Milestone**: M4
- **Blocked by**: 010

## Slice

As a designer I see the whole tuple space (∏ mᵢ) of the current canvas — which combinations have contexts and which are unexplored — and clicking any hollow cell opens the composer pre-filled with that tuple.

## Scope

- Coverage engine: cross-product minus documented tuples, computed as a store selector (SQL anti-join or in-memory — benchmark decides, correctness first).
- 2-D projection: user picks the two grid dimensions (default: the two largest); remaining dimensions become filter/pager chips; n = 2 renders a plain grid.
- Cells: documented show context symbol(s) (multiples stack); hollow cells clickable → compose mode (slice 010) with all n parameters pre-selected.
- Live stat: `12 / 45 tuples documented`, recomputed on any dimension/parameter/context change.
- Informational only — nothing gates on coverage (SPEC invariant 2).

## Design brief

- **Surface**: a paper panel; cells are 24px squares aligned to the graph-paper pitch — the matrix literally reads as plotted graph paper. Documented cells: mono symbol on ink fill; unexplored: hairline hollow square. Shape + fill carry state (colorblind-safe); dimension colors appear only in the axis headers' swatches.
- **Projection controls**: two segmented pickers ("Rows: Value · Columns: Process"); remaining dimensions render as filter chips with mono parameter values; swapping axes preserves filters.
- **Hierarchy**: the coverage stat leads the header in mono ("12 / 45 documented"); the grid is the body; controls stay quiet.
- **Interaction**: hover/focus previews the full tuple in a tooltip; Enter/click on a hollow cell jumps to the canvas in compose mode, pre-filled (gap → composer); on a documented cell it selects that context (stacked symbols cycle on repeated Enter).
- **Keyboard**: the grid is a 2-D roving-tabindex widget — arrows move, Home/End jump, typing a symbol jumps to that context's cell.
- **Empty/degenerate states**: a dimension with no parameters shows "Add parameters to *Stake* to plot coverage" linking to the manager; a filtered-to-zero view says which filter caused it.
- **Performance**: virtualized beyond the viewport; ∏ mᵢ ≈ 10,000 target with no scroll jank (budget test); stat recomputes in the same frame as any mutation.

**References**: SPEC §4.5, invariant 2 · SITEMAP §1 (`?view=coverage`), §2 (view toggle + stat in context bar), §4 (`v` key) · STYLE_GUIDE §2.1 (grid pitch), §6, §10 · TECH_STACK T2 (virtualization) · issue 010 (compose handoff)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Property test: random canvases (2 ≤ n ≤ 5, 1 ≤ mᵢ ≤ 6) — every tuple appears exactly once across the projection's pages; documented/unexplored partition matches a brute-force oracle.
2. Unit: stat updates when a parameter is added (denominator grows), a context completes (numerator grows), a dimension is removed (both recompute).
3. Component: axis picker swap re-projects without losing filters; duplicate contexts stack in one cell.
4. e2e: click a hollow cell → composer opens pre-filled → justify → cell now shows the symbol and the stat increments (SPEC §6 M4 done-when at n = 3 and n = 4).

## Acceptance criteria

- [x] The property test (with the brute-force oracle) is part of `npm run verify`.
- [x] Every tuple is reachable through the UI regardless of n (capacity guarantee).
- [x] Matrix stays responsive at ∏ mᵢ ≈ 10,000 (virtualized grid; perf budget test).

## Shipped notes

- **Pure engine** (`src/domain/coverage.ts`): `documentedTuples`, `coverageStat`, `defaultAxes`, `filterDimensionIds`, `fullTupleSpace`, `tupleSpaceSize` — store-free, keyed into the same `computeTupleHash` space as complete contexts. Property-tested against a brute-force oracle (every tuple reachable exactly once for any axis choice; documented/unexplored partition matches). `src/domain/gridWindow.ts` = pure fixed-pitch windowing for both-axis virtualization.
- **In-memory, not SQL**: the documented set is O(#contexts) and ∏ mᵢ is pure arithmetic never materialized (cells keyed on demand). A SQL anti-join would materialize the full ~10k cross-product in PGlite to subtract a few rows and couple a pure derivation to the DB — strictly worse. No migration.
- **`CoverageMatrix.tsx`**: two-largest-default axes with swap, remaining dimensions as filter chips, 24px graph-paper-pitch cells, roving-tabindex grid, both-axis virtualization. Documented = mono symbol on ink fill; unexplored = hairline hollow (shape+fill carry state, colorblind-safe); dimension color only in axis-header swatches.
- **"Documented" = complete AND justified** (matches issue 005's `documentedStatus()` tri-state): a complete-but-unjustified context leaves its cell hollow. Keeps the matrix a strict binary per the brief.
- **Compose seam** (`DesignSurface.tsx`, additive): `enterCompose(initialBindings?)` — a hollow-cell click navigates to the canvas and enters compose pre-filled with that tuple; the create + n binds are one undoable `batch('compose from gap', …)`. Also added the `v` view toggle (capture-phase, text-field-guarded), the Canvas/Coverage toggle + live `n / m documented` stat + draft count in the context bar. `routes.ts`/`router.ts` unchanged (the `coverage` view already existed).
- **Verified**: full `npm run verify` green on main (unit/component incl. the property + perf-budget tests, e2e incl. `e2e/coverage.spec.ts`). Manual chromium screenshots confirmed the matrix, projection controls, live stat, and gap→compose.
