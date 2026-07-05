// Coverage engine (issue 012, SPEC §4.5, invariant 2). Pure and store-free,
// like completeness/composeMode/canvasLayout — it builds on the same tuple
// space (computeTupleHash) so a cell and a complete context key into one
// namespace. Derived only: nothing is persisted, and coverage is informational
// (invariant 2 — never a gate). Correctness first; benchmarked in-memory vs a
// SQL anti-join and kept in-memory (see coverage.test.ts note).
import { documentedStatus, isComplete } from './completeness'
import { computeTupleHash } from './symbols'

export interface CoverageContextInput {
  id: string
  symbol: string
  // dimensionId -> parameterId, mirroring the store's per-context bindings.
  bindings: Readonly<Record<string, string>>
  justification: string | null
}

export interface DocumentedCell {
  // Stacked in input (sort) order — duplicate contexts on one tuple pile up.
  symbols: string[]
  contextIds: string[]
}

export interface CoverageStat {
  documented: number
  total: number
}

export interface AxisChoice {
  rowDimId: string
  colDimId: string
}

// The tuple hash for a full assignment (every dimension → one parameter), in
// canvas dimension-sort order — identical to the hash a complete context's
// bindings produce, so cells and contexts land in the same key space.
export function assignmentTupleHash(
  orderedDimensionIds: readonly string[],
  assignment: Readonly<Record<string, string | undefined>>,
): string {
  return computeTupleHash(orderedDimensionIds.map((id) => assignment[id] ?? ''))
}

// ∏ mᵢ. Zero if any dimension has no parameters — nothing is plottable until it
// does, a degenerate state the UI calls out rather than dividing by.
export function tupleSpaceSize(
  orderedDimensionIds: readonly string[],
  parameterIdsByDimension: Readonly<Record<string, readonly string[]>>,
): number {
  if (orderedDimensionIds.length === 0) return 0
  return orderedDimensionIds.reduce((n, id) => n * (parameterIdsByDimension[id]?.length ?? 0), 1)
}

// Map every documented tuple → its stacked context symbols. A tuple counts as
// documented iff ≥1 context binds it that is both COMPLETE (all n dimensions
// bound) and JUSTIFIED (SPEC invariant 2; confirmed by issue 012 test-plan #4:
// binding all params leaves the cell hollow until justify fills it). Draft and
// complete-but-unjustified contexts do not occupy a cell — the register tracks
// those tri-states; the matrix is a strict documented/unexplored binary.
export function documentedTuples(
  orderedDimensionIds: readonly string[],
  contexts: readonly CoverageContextInput[],
): Map<string, DocumentedCell> {
  const map = new Map<string, DocumentedCell>()
  for (const ctx of contexts) {
    const bound = new Set(Object.keys(ctx.bindings))
    if (!isComplete(orderedDimensionIds, bound)) continue
    if (documentedStatus(true, ctx.justification) !== 'documented') continue
    const hash = assignmentTupleHash(orderedDimensionIds, ctx.bindings)
    const cell = map.get(hash)
    if (cell) {
      cell.symbols.push(ctx.symbol)
      cell.contextIds.push(ctx.id)
    } else {
      map.set(hash, { symbols: [ctx.symbol], contextIds: [ctx.id] })
    }
  }
  return map
}

// Live stat for the context bar: `documented / total` (SPEC §4.5). Recomputes
// from store state each render, so any dimension/parameter/context change moves
// it in the same frame (issue 012 acceptance).
export function coverageStat(
  orderedDimensionIds: readonly string[],
  parameterIdsByDimension: Readonly<Record<string, readonly string[]>>,
  contexts: readonly CoverageContextInput[],
): CoverageStat {
  return {
    documented: documentedTuples(orderedDimensionIds, contexts).size,
    total: tupleSpaceSize(orderedDimensionIds, parameterIdsByDimension),
  }
}

// Default grid axes: the two dimensions with the most parameters (SPEC §4.5),
// ties broken by sort order (the incoming order of orderedDimensionIds). Null
// below the n = 2 floor — the design surface never reaches coverage there.
export function defaultAxes(
  orderedDimensionIds: readonly string[],
  parameterIdsByDimension: Readonly<Record<string, readonly string[]>>,
): AxisChoice | null {
  if (orderedDimensionIds.length < 2) return null
  const sorted = [...orderedDimensionIds].sort((a, b) => {
    const delta = (parameterIdsByDimension[b]?.length ?? 0) - (parameterIdsByDimension[a]?.length ?? 0)
    if (delta !== 0) return delta
    return orderedDimensionIds.indexOf(a) - orderedDimensionIds.indexOf(b)
  })
  return { rowDimId: sorted[0] as string, colDimId: sorted[1] as string }
}

// The dimensions that become filter/pager chips (SPEC §4.5) — every dimension
// not on the grid, in sort order so chips read stably as axes swap.
export function filterDimensionIds(
  orderedDimensionIds: readonly string[],
  axes: AxisChoice,
): string[] {
  return orderedDimensionIds.filter((id) => id !== axes.rowDimId && id !== axes.colDimId)
}

// Full cartesian tuple space as hashes — the brute-force capacity oracle
// (issue 012 test-plan #1). Not called on the render path (the component keys
// cells on demand); enumerating ∏ mᵢ ≈ 10⁴ objects is a test-only cost.
export function fullTupleSpace(
  orderedDimensionIds: readonly string[],
  parameterIdsByDimension: Readonly<Record<string, readonly string[]>>,
): string[] {
  let assignments: Record<string, string>[] = [{}]
  for (const dimId of orderedDimensionIds) {
    const params = parameterIdsByDimension[dimId] ?? []
    const next: Record<string, string>[] = []
    for (const partial of assignments) {
      for (const paramId of params) next.push({ ...partial, [dimId]: paramId })
    }
    assignments = next
  }
  return assignments.map((a) => assignmentTupleHash(orderedDimensionIds, a))
}
