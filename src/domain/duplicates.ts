import { computeTupleHash } from './symbols'

// SPEC.md invariant 2 — a duplicate is two or more contexts sharing the same
// ordered tuple of bound parameters. Detection never blocks a save; it only
// surfaces siblings so the register/composer can show a non-blocking badge
// (issue 005). Mirrors the `tuple_hash` computed in db/mutations.ts, but
// purely over already-loaded store state so the register needs no extra read.
export function tupleKeyFor(
  dimensionIds: readonly string[],
  bindings: Readonly<Record<string, string>>,
): string | null {
  const ordered = dimensionIds.filter((id) => bindings[id]).map((id) => bindings[id] as string)
  return ordered.length > 0 ? computeTupleHash(ordered) : null
}

// contextId -> sibling context ids sharing its tuple (empty/absent when unique).
export function findDuplicateContextIds(
  dimensionIds: readonly string[],
  bindingsByContext: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Record<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const [contextId, bindings] of Object.entries(bindingsByContext)) {
    const key = tupleKeyFor(dimensionIds, bindings)
    if (key === null) continue
    const ids = byKey.get(key)
    if (ids) ids.push(contextId)
    else byKey.set(key, [contextId])
  }

  const result: Record<string, string[]> = {}
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue
    for (const id of ids) result[id] = ids.filter((other) => other !== id)
  }
  return result
}
