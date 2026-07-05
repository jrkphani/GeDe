// SPEC.md invariant 1 — a binding set is complete iff it covers all n
// dimensions of its canvas. Incomplete contexts are drafts, not errors.
export function isComplete(
  dimensionIds: readonly string[],
  boundDimensionIds: ReadonlySet<string>,
): boolean {
  return dimensionIds.length > 0 && dimensionIds.every((id) => boundDimensionIds.has(id))
}

export type DocumentedStatus = 'draft' | 'complete' | 'documented'

// STYLE_GUIDE §9/§10 dot signifier (issue 005): draft = hollow, complete-
// but-unjustified = half-filled, documented = filled. Shape + fill carry the
// state, never color alone. Never gates saving/exporting (SPEC invariant 2).
export function documentedStatus(
  complete: boolean,
  justification: string | null | undefined,
): DocumentedStatus {
  if (!complete) return 'draft'
  return justification && justification.trim() !== '' ? 'documented' : 'complete'
}
