import type { DocumentedStatus } from './completeness'

const PLACEHOLDER = '—'

// SPEC §4.2/§4.4 — the mono tuple readout, in dimension sort order. Backs
// both the composer bar's read-mode display and the canvas node's a11y
// description; an unbound dimension (or a binding pointing at a parameter id
// with no known name) renders the same placeholder the composer uses for
// drafts, never blocking on incompleteness (SPEC invariant 2).
export function tupleReadout(
  dimensions: readonly { id: string }[],
  bindings: Readonly<Record<string, string>>,
  paramNameById: Readonly<Record<string, string>>,
): string[] {
  return dimensions.map((d) => {
    const paramId = bindings[d.id]
    const name = paramId ? paramNameById[paramId] : undefined
    return name ?? PLACEHOLDER
  })
}

// Issue 009 — one string for both the canvas node's aria-label and the
// status-bar selection announcement, so the two can never drift apart:
// "α — Comfort, Users, Engagement, draft".
export function describeContext(symbol: string, tuple: readonly string[], status: DocumentedStatus): string {
  return `${symbol} — ${[...tuple, status].join(', ')}`
}
