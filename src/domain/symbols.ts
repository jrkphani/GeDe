// SPEC.md §3 — root contexts cycle these Greek letters; children get
// parent-symbol + index (α1, α2). Both skip symbols already taken by a live
// sibling so a deleted gap never produces a collision on reassignment.
export const GREEK_CYCLE = ['α', 'β', 'γ', 'δ', 'ε', 'λ', 'μ', 'θ', 'π']

export function nextRootSymbol(taken: ReadonlySet<string>): string {
  for (let wrap = 0; ; wrap++) {
    for (const letter of GREEK_CYCLE) {
      const candidate = wrap === 0 ? letter : `${letter}${'′'.repeat(wrap)}`
      if (!taken.has(candidate)) return candidate
    }
  }
}

export function nextChildSymbol(parentSymbol: string, taken: ReadonlySet<string>): string {
  for (let index = 1; ; index++) {
    const candidate = `${parentSymbol}${index}`
    if (!taken.has(candidate)) return candidate
  }
}

// Deterministic over the ordered (by canvas dimension sort) list of bound
// parameter ids — used to detect duplicate-tuple contexts on the same canvas
// (invariant 2, issue 005+). Not cryptographic: a stable join is enough.
export function computeTupleHash(orderedParameterIds: readonly string[]): string {
  return orderedParameterIds.join('|')
}
