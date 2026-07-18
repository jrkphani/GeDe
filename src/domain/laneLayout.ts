// 089-D3 P0 — derived-layout core (no React Flow, no store, no React, no I/O).
//
// STYLE_GUIDE §1 principle 4 / SPEC invariant 5: position is DERIVED — the app
// never persists a node's `{x,y}`. A node's position is a pure projection of
// `(tier, sort)`, recomputed on every change. The Design spike proved React
// Flow tolerates this discipline (`onNodeDragStop` recomputes `sort`, then
// re-derives ALL positions); this module is that projection in isolation so the
// later phases can trust it.
//
// Two pure functions:
//   - `computeLaneLayout` — `(tier, sort, height) → {x, y}`. x is a pure fn of
//     tier (a lane column); within a lane, nodes stack downward in `sort` order
//     using each node's caller-supplied pixel height + a fixed inter-node gap.
//   - `reorderWithinLane` — the one meaning a node-drag carries: reorder → new
//     dense `sort`. Only the moved node's lane is re-densified (0..n-1), mirror-
//     ing the `rewriteSort` cascade in db/mutations.ts (reorderDimension /
//     reorderCanvas); every other lane is left byte-for-byte untouched.
//
// No `Date.now()` / `Math.random()` / DOM / store — deterministic by design.

export type LaneTier = 'foundation' | 'architecture' | 'design'

// Fixed left→right column order (Tier 1 → 2 → 3). A tier's column index — and
// therefore its x — is this array's index, so an absent/empty lane never shifts
// another lane's x (x depends on tier alone, not on which lanes are populated).
export const LANE_ORDER: readonly LaneTier[] = ['foundation', 'architecture', 'design']

// One node in a lane. `height` is the node's measured/estimated pixel height,
// supplied by the caller — P0 does not touch the DOM. `sort` is the existing
// dense-integer ordinal (0..n-1 per lane) that already orders tier tables in
// db/schema.ts; this module's contract is to keep it dense.
export interface LaneItem {
  id: string
  tier: LaneTier
  sort: number
  height: number
}

export interface LaneLayoutConfig {
  // Width of a lane column, px. Consumed only via the column stride below —
  // node width itself is a render concern, not this projection's.
  laneWidth: number
  // Horizontal gap between adjacent lane columns, px.
  laneGap: number
  // Vertical gap between two stacked nodes in the same lane, px.
  nodeGap: number
}

export interface LaneNodePosition {
  id: string
  x: number
  y: number
}

function columnIndex(tier: LaneTier): number {
  return LANE_ORDER.indexOf(tier)
}

// x is a pure function of tier: column index × (laneWidth + laneGap). The
// leftmost lane sits at x = 0.
function laneX(tier: LaneTier, config: LaneLayoutConfig): number {
  return columnIndex(tier) * (config.laneWidth + config.laneGap)
}

// Items in one lane, ascending by `sort`, without mutating the input array.
function laneItemsSorted(items: readonly LaneItem[], tier: LaneTier): LaneItem[] {
  return items.filter((i) => i.tier === tier).sort((a, b) => a.sort - b.sort)
}

// Derive a position for every item. x = pure fn(tier); within a lane, items are
// ordered by `sort` ascending and stacked downward: the j-th node's y is the
// sum of every earlier sibling's height plus one `nodeGap` per earlier sibling.
// So variable-height nodes never overlap, and each lane stacks from its own top
// independently of the others. Output is ordered by lane then `sort` for
// determinism (independent of input array order). Pure — no mutation, no I/O.
export function computeLaneLayout(
  items: readonly LaneItem[],
  config: LaneLayoutConfig,
): LaneNodePosition[] {
  const positions: LaneNodePosition[] = []
  for (const tier of LANE_ORDER) {
    const lane = laneItemsSorted(items, tier)
    const x = laneX(tier, config)
    let y = 0
    for (const node of lane) {
      positions.push({ id: node.id, x, y })
      y += node.height + config.nodeGap
    }
  }
  return positions
}

// Reorder `movedId` to `targetIndex` within its own lane and re-densify that
// lane's `sort` to 0..n-1 (the sole meaning a node-drag carries). Only the moved
// node's lane is rewritten; every other lane keeps its exact `sort` values. Pure
// — returns a fresh array of fresh items, never mutating the input. An unknown
// `movedId` is a no-op copy. `targetIndex` is clamped to the lane bounds.
export function reorderWithinLane(
  items: readonly LaneItem[],
  movedId: string,
  targetIndex: number,
): LaneItem[] {
  const moved = items.find((i) => i.id === movedId)
  if (!moved) return items.map((i) => ({ ...i }))

  const tier = moved.tier
  const lane = laneItemsSorted(items, tier)
  const from = lane.findIndex((i) => i.id === movedId)
  const target = Math.max(0, Math.min(lane.length - 1, targetIndex))

  const [carried] = lane.splice(from, 1)
  lane.splice(target, 0, carried as LaneItem)

  // Dense 0..n-1 by post-move position — mirrors db/mutations.ts rewriteSort.
  const newSortById = new Map(lane.map((node, index) => [node.id, index]))

  return items.map((i) =>
    i.tier === tier ? { ...i, sort: newSortById.get(i.id) as number } : { ...i },
  )
}
