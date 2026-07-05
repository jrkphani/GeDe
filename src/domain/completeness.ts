// SPEC.md invariant 1 — a binding set is complete iff it covers all n
// dimensions of its canvas. Incomplete contexts are drafts, not errors.
export function isComplete(
  dimensionIds: readonly string[],
  boundDimensionIds: ReadonlySet<string>,
): boolean {
  return dimensionIds.length > 0 && dimensionIds.every((id) => boundDimensionIds.has(id))
}
