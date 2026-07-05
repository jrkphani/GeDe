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

## Test-first plan

1. Property test: random canvases (2 ≤ n ≤ 5, 1 ≤ mᵢ ≤ 6) — every tuple appears exactly once across the projection's pages; documented/unexplored partition matches a brute-force oracle.
2. Unit: stat updates when a parameter is added (denominator grows), a context completes (numerator grows), a dimension is removed (both recompute).
3. Component: axis picker swap re-projects without losing filters; duplicate contexts stack in one cell.
4. e2e: click a hollow cell → composer opens pre-filled → justify → cell now shows the symbol and the stat increments (SPEC §6 M4 done-when at n = 3 and n = 4).

## Acceptance criteria

- [ ] The property test (with the brute-force oracle) is part of `npm run verify`.
- [ ] Every tuple is reachable through the UI regardless of n (capacity guarantee).
- [ ] Matrix stays responsive at ∏ mᵢ ≈ 10,000 (virtualized grid; perf budget test).
