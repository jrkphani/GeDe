import type { Tier2EntryRow } from '../db/mutations'

// 2nd-Tier architecture entries nest arbitrarily (SPEC §4.6): the DB stores a
// flat, sort-ordered list keyed by parent_id; these pure helpers assemble the
// nesting the Architecture surface renders (STYLE_GUIDE §6 — 24px indent per
// level, no tree lines). No React/DB imports.

export interface EntryNode {
  entry: Tier2EntryRow
  depth: number
  children: EntryNode[]
}

// Build the nested tree from a flat list. `parentId === null` is a top-level
// row of its table; siblings are ordered by `sort`.
export function buildEntryTree(entries: Tier2EntryRow[]): EntryNode[] {
  const byParent = new Map<string | null, Tier2EntryRow[]>()
  for (const e of entries) {
    const list = byParent.get(e.parentId) ?? []
    list.push(e)
    byParent.set(e.parentId, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort)
  function build(parentId: string | null, depth: number): EntryNode[] {
    return (byParent.get(parentId) ?? []).map((entry) => ({
      entry,
      depth,
      children: build(entry.id, depth + 1),
    }))
  }
  return build(null, 0)
}

export interface FlatEntry {
  entry: Tier2EntryRow
  depth: number
  hasChildren: boolean
}

// Depth-first flatten into the rows a single indented grid renders — each row
// carries its own depth (for the leading indent cell) and whether it has
// children (for the expand/collapse chevron). A collapsed id is emitted but
// its subtree is skipped.
export function flattenEntryTree(nodes: EntryNode[], collapsed?: Set<string>): FlatEntry[] {
  const out: FlatEntry[] = []
  function walk(list: EntryNode[]) {
    for (const n of list) {
      out.push({ entry: n.entry, depth: n.depth, hasChildren: n.children.length > 0 })
      if (!collapsed?.has(n.entry.id)) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// Every id in the subtree rooted at `rootId` (inclusive) — the unit of a
// delete cascade and of linked-parameter resolution (invariant 7).
export function subtreeIds(entries: Tier2EntryRow[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const e of entries) {
    if (e.parentId) {
      const list = childrenOf.get(e.parentId) ?? []
      list.push(e.id)
      childrenOf.set(e.parentId, list)
    }
  }
  const out: string[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    out.push(id)
    for (const childId of childrenOf.get(id) ?? []) stack.push(childId)
  }
  return out
}
