import { describe, expect, it } from 'vitest'
import {
  LANE_ORDER,
  computeLaneLayout,
  reorderWithinLane,
  type LaneItem,
  type LaneLayoutConfig,
  type LaneNodePosition,
} from './laneLayout'

// 089-D3 P0 — derived-layout core. Position is a PURE projection of (tier, sort);
// {x,y} is never persisted (STYLE_GUIDE §1 principle 4, SPEC invariant 5). x is a
// pure function of tier (lane column); within a lane, nodes stack downward by sort.
const CONFIG: LaneLayoutConfig = { laneWidth: 300, laneGap: 100, nodeGap: 20 }

// laneWidth + laneGap = 400 → foundation x=0, architecture x=400, design x=800.
const COLUMN_STRIDE = CONFIG.laneWidth + CONFIG.laneGap

function item(id: string, tier: LaneItem['tier'], sort: number, height: number): LaneItem {
  return { id, tier, sort, height }
}

// Lookup helper that throws rather than using a banned non-null assertion.
function byId<T extends { id: string }>(arr: readonly T[], id: string): T {
  const found = arr.find((entry) => entry.id === id)
  if (!found) throw new Error(`no entry with id ${id}`)
  return found
}

const sortOf = (items: readonly LaneItem[], id: string) => byId(items, id).sort

describe('computeLaneLayout — x is a pure function of tier', () => {
  it('gives every node in a lane the same x, and the three lanes distinct ordered x', () => {
    const items = [
      item('f1', 'foundation', 0, 50),
      item('f2', 'foundation', 1, 50),
      item('a1', 'architecture', 0, 50),
      item('d1', 'design', 0, 50),
    ]
    const pos = computeLaneLayout(items, CONFIG)
    const at = (id: string) => byId(pos, id)

    expect(at('f1').x).toBe(0)
    expect(at('f2').x).toBe(0) // same lane → same x, independent of sort/height
    expect(at('a1').x).toBe(COLUMN_STRIDE)
    expect(at('d1').x).toBe(2 * COLUMN_STRIDE)
    // strictly increasing left→right in LANE_ORDER
    expect(at('f1').x).toBeLessThan(at('a1').x)
    expect(at('a1').x).toBeLessThan(at('d1').x)
  })

  it("x follows tier only — an absent lane does not shift the other lanes' x", () => {
    // No architecture items at all. Design must still sit at column index 2.
    const items = [item('f1', 'foundation', 0, 50), item('d1', 'design', 0, 50)]
    const pos = computeLaneLayout(items, CONFIG)
    expect(byId(pos, 'f1').x).toBe(0)
    expect(byId(pos, 'd1').x).toBe(2 * COLUMN_STRIDE)
  })
})

describe('computeLaneLayout — within-lane vertical stacking by sort', () => {
  it('y increases monotonically with sort', () => {
    const items = [
      item('c', 'foundation', 2, 40),
      item('a', 'foundation', 0, 40),
      item('b', 'foundation', 1, 40),
    ]
    const pos = computeLaneLayout(items, CONFIG)
    const y = (id: string) => byId(pos, id).y
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('c'))
    expect(y('a')).toBe(0) // first node in a lane starts at the lane top
  })

  it('stacking respects each node height + the configured gap (variable heights never overlap)', () => {
    const items = [
      item('a', 'foundation', 0, 30),
      item('b', 'foundation', 1, 80),
      item('c', 'foundation', 2, 15),
    ]
    const pos = computeLaneLayout(items, CONFIG)
    const y = (id: string) => byId(pos, id).y
    // y = sum(prior heights) + nodeGap * priorCount
    expect(y('a')).toBe(0)
    expect(y('b')).toBe(30 + 20) // a.height + 1 gap
    expect(y('c')).toBe(30 + 80 + 20 * 2) // a+b heights + 2 gaps
    // no overlap: each node's top clears the previous node's bottom
    expect(y('b')).toBeGreaterThanOrEqual(y('a') + 30)
    expect(y('c')).toBeGreaterThanOrEqual(y('b') + 80)
  })

  it('each lane stacks independently from its own top', () => {
    const items = [item('f1', 'foundation', 0, 200), item('a1', 'architecture', 0, 25)]
    const pos = computeLaneLayout(items, CONFIG)
    // architecture is not pushed down by foundation's tall node
    expect(byId(pos, 'a1').y).toBe(0)
  })
})

describe('computeLaneLayout — determinism & edge cases', () => {
  it('same input → same output', () => {
    const items = [
      item('a', 'foundation', 0, 40),
      item('b', 'architecture', 1, 60),
      item('c', 'design', 0, 20),
    ]
    expect(computeLaneLayout(items, CONFIG)).toEqual(computeLaneLayout(items, CONFIG))
  })

  it('does not depend on input array order (sort is the only ordering)', () => {
    const a = [item('x', 'foundation', 0, 40), item('y', 'foundation', 1, 40)]
    const b = [item('y', 'foundation', 1, 40), item('x', 'foundation', 0, 40)]
    const posA = computeLaneLayout(a, CONFIG)
    const posB = computeLaneLayout(b, CONFIG)
    const yOf = (p: LaneNodePosition[], id: string) => byId(p, id).y
    expect(yOf(posA, 'x')).toBe(yOf(posB, 'x'))
    expect(yOf(posA, 'y')).toBe(yOf(posB, 'y'))
  })

  it('breaks a duplicate-sort tie deterministically by id, independent of input order', () => {
    // Two nodes sharing a `sort` in one lane. The DB keeps sort dense so this
    // "can't" happen, but computeLaneLayout documents itself as a pure projection
    // "independent of input array order" — a duplicate sort must therefore resolve
    // by a stable key (id ascending), not by which array slot the caller passed.
    const a = [item('zzz', 'foundation', 0, 40), item('aaa', 'foundation', 0, 40)]
    const b = [item('aaa', 'foundation', 0, 40), item('zzz', 'foundation', 0, 40)]
    const yIn = (arr: LaneItem[], id: string) => byId(computeLaneLayout(arr, CONFIG), id).y
    // identical result regardless of input array order
    expect(yIn(a, 'aaa')).toBe(yIn(b, 'aaa'))
    expect(yIn(a, 'zzz')).toBe(yIn(b, 'zzz'))
    // id ascending: 'aaa' stacks above 'zzz'
    expect(yIn(a, 'aaa')).toBeLessThan(yIn(a, 'zzz'))
  })

  it('empty input yields an empty layout', () => {
    expect(computeLaneLayout([], CONFIG)).toEqual([])
  })

  it('a single item sits at the top of its lane column', () => {
    const pos = computeLaneLayout([item('only', 'design', 0, 99)], CONFIG)
    expect(pos).toEqual([{ id: 'only', x: 2 * COLUMN_STRIDE, y: 0 }])
  })

  it('does not mutate the input items', () => {
    const items = [item('a', 'foundation', 0, 40)]
    const snapshot = structuredClone(items)
    computeLaneLayout(items, CONFIG)
    expect(items).toEqual(snapshot)
  })
})

describe('reorderWithinLane — changes only sort, dense 0..n-1', () => {
  const lane = (): LaneItem[] => [
    item('a', 'foundation', 0, 40),
    item('b', 'foundation', 1, 40),
    item('c', 'foundation', 2, 40),
    item('d', 'foundation', 3, 40),
  ]

  it('moving an item DOWN reorders exactly as expected and re-densifies sort', () => {
    // move 'a' (index 0) to index 2 → order b, c, a, d
    const out = reorderWithinLane(lane(), 'a', 2)
    expect(sortOf(out, 'b')).toBe(0)
    expect(sortOf(out, 'c')).toBe(1)
    expect(sortOf(out, 'a')).toBe(2)
    expect(sortOf(out, 'd')).toBe(3)
  })

  it('moving an item UP reorders exactly as expected', () => {
    // move 'd' (index 3) to index 1 → order a, d, b, c
    const out = reorderWithinLane(lane(), 'd', 1)
    expect(sortOf(out, 'a')).toBe(0)
    expect(sortOf(out, 'd')).toBe(1)
    expect(sortOf(out, 'b')).toBe(2)
    expect(sortOf(out, 'c')).toBe(3)
  })

  it('a no-op move (same index) leaves the dense sequence unchanged', () => {
    const out = reorderWithinLane(lane(), 'b', 1)
    expect(out.map((i) => [i.id, i.sort])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ])
  })

  it('produces a dense 0..n-1 ordinal with no gaps or duplicates', () => {
    const out = reorderWithinLane(lane(), 'c', 0)
    const sorts = out.map((i) => i.sort).sort((x, y) => x - y)
    expect(sorts).toEqual([0, 1, 2, 3])
  })

  it('clamps an out-of-range target index to the lane bounds', () => {
    const out = reorderWithinLane(lane(), 'a', 99) // → last
    expect(sortOf(out, 'a')).toBe(3)
  })

  it('leaves tier / height invariant (only sort changes), so derived x is invariant', () => {
    const before = lane()
    const out = reorderWithinLane(before, 'a', 2)
    for (const b of before) {
      const a = byId(out, b.id)
      expect(a.tier).toBe(b.tier)
      expect(a.height).toBe(b.height)
    }
    // x is derived from tier, so it is invariant across a within-lane reorder
    const xBefore = computeLaneLayout(before, CONFIG).map((p) => p.x)
    const xAfter = computeLaneLayout(out, CONFIG).map((p) => p.x)
    expect(new Set(xAfter)).toEqual(new Set(xBefore))
  })

  it('touches ONLY the moved item lane — other lanes are untouched', () => {
    const items = [
      item('f0', 'foundation', 0, 40),
      item('f1', 'foundation', 1, 40),
      item('f2', 'foundation', 2, 40),
      item('a0', 'architecture', 0, 40),
      item('a1', 'architecture', 1, 40),
      item('d0', 'design', 5, 40), // deliberately non-dense in another lane
    ]
    const out = reorderWithinLane(items, 'f0', 2)
    // architecture + design sort values are byte-for-byte preserved
    expect(sortOf(out, 'a0')).toBe(0)
    expect(sortOf(out, 'a1')).toBe(1)
    expect(sortOf(out, 'd0')).toBe(5)
  })

  it('does not mutate the input array or its items', () => {
    const items = lane()
    const snapshot = structuredClone(items)
    reorderWithinLane(items, 'a', 3)
    expect(items).toEqual(snapshot)
  })

  it('an absent movedId is a no-op (returns the same dense ordering, no throw)', () => {
    const out = reorderWithinLane(lane(), 'ghost', 0)
    expect(out.map((i) => [i.id, i.sort])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ])
  })
})

describe('LANE_ORDER', () => {
  it('is the fixed Foundation → Architecture → Design column order', () => {
    expect(LANE_ORDER).toEqual(['foundation', 'architecture', 'design'])
  })
})
