// SPEC invariant 4 — pure, non-mutating preview of a dimension removal's
// blast radius, so the confirm popover's numbers are the same numbers the
// cascade delete in db/mutations.ts actually produces (issue 007).
export interface RemovalImpact {
  bindingCount: number
}

export function computeRemovalImpact(
  dimensionId: string,
  bindingsByContext: Readonly<Record<string, Readonly<Record<string, string>>>>,
): RemovalImpact {
  let bindingCount = 0
  for (const bindings of Object.values(bindingsByContext)) {
    if (bindings[dimensionId] !== undefined) bindingCount += 1
  }
  return { bindingCount }
}
