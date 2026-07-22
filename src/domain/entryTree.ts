import type { Tier2EntryRow } from '../db/mutations'

// 2nd-Tier architecture entries nest arbitrarily (SPEC §4.6): the DB stores a
// flat, sort-ordered list keyed by parent_id; these pure helpers assemble the
// nesting the Architecture surface renders (STYLE_GUIDE §6 — 24px indent per
// level, no tree lines). No React/DB imports.

// The live siblings under `parentId`, ordered by `sort` — the ONE canonical
// sibling ordering shared by the store's sort-delta enqueue (tier2.moveEntry)
// and the Architecture surface's tree verbs (issue 105). `parentId === null` is
// a top-level row of its table.
export function siblingsOf(
  entries: readonly Tier2EntryRow[],
  parentId: string | null,
): Tier2EntryRow[] {
  return entries.filter((e) => e.parentId === parentId).sort((a, b) => a.sort - b.sort)
}

// Group a flat entry list into { parentId → siblings sorted by `sort` } in ONE
// pass — the shared index behind buildEntryTree and the Architecture surface's
// per-render sibling lookups (four tree-move targets per row).
export function groupSiblingsBySort(
  entries: readonly Tier2EntryRow[],
): Map<string | null, Tier2EntryRow[]> {
  const byParent = new Map<string | null, Tier2EntryRow[]>()
  for (const e of entries) {
    const list = byParent.get(e.parentId)
    if (list) list.push(e)
    else byParent.set(e.parentId, [e])
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort)
  return byParent
}

export interface EntryNode {
  entry: Tier2EntryRow
  depth: number
  children: EntryNode[]
}

// Build the nested tree from a flat list. `parentId === null` is a top-level
// row of its table; siblings are ordered by `sort`.
export function buildEntryTree(entries: Tier2EntryRow[]): EntryNode[] {
  const byParent = groupSiblingsBySort(entries)
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
