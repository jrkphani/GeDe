# 012: Coverage matrix — documented vs unexplored tuples

- **Status**: OPEN
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

**References**: SPEC §4.5, invariant 2 · STYLE_GUIDE §2.1 (grid pitch), §6, §10 · TECH_STACK T2 (virtualization) · issue 010 (compose handoff)

## Test-first plan

1. Property test: random canvases (2 ≤ n ≤ 5, 1 ≤ mᵢ ≤ 6) — every tuple appears exactly once across the projection's pages; documented/unexplored partition matches a brute-force oracle.
2. Unit: stat updates when a parameter is added (denominator grows), a context completes (numerator grows), a dimension is removed (both recompute).
3. Component: axis picker swap re-projects without losing filters; duplicate contexts stack in one cell.
4. e2e: click a hollow cell → composer opens pre-filled → justify → cell now shows the symbol and the stat increments (SPEC §6 M4 done-when at n = 3 and n = 4).

## Acceptance criteria

- [ ] The property test (with the brute-force oracle) is part of `npm run verify`.
- [ ] Every tuple is reachable through the UI regardless of n (capacity guarantee).
- [ ] Matrix stays responsive at ∏ mᵢ ≈ 10,000 (virtualized grid; perf budget test).
