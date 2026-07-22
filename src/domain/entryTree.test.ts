import { describe, expect, it } from 'vitest'
import type { Tier2EntryRow } from '../db/mutations'
import {
  buildEntryTree,
  flattenEntryTree,
  groupSiblingsBySort,
  siblingsOf,
  subtreeIds,
} from './entryTree'

// A minimal row factory — the tree helpers only read id/parentId/sort/name.
function entry(id: string, parentId: string | null, sort: number): Tier2EntryRow {
  return {
    id,
    tableId: 't',
    workspaceId: 'ws1',
    parentId,
    name: id,
    description: null,
    sort,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

describe('buildEntryTree', () => {
  it('nests arbitrary depth and orders siblings by sort', () => {
    const rows = [
      entry('a', null, 0),
      entry('b', null, 1),
      entry('a1', 'a', 0),
      entry('a2', 'a', 1),
      entry('a1x', 'a1', 0),
    ]
    const tree = buildEntryTree(rows)
    expect(tree.map((n) => n.entry.id)).toEqual(['a', 'b'])
    expect(tree[0]?.children.map((n) => n.entry.id)).toEqual(['a1', 'a2'])
    expect(tree[0]?.children[0]?.children.map((n) => n.entry.id)).toEqual(['a1x'])
    // depth increments per level
    expect(tree[0]?.depth).toBe(0)
    expect(tree[0]?.children[0]?.depth).toBe(1)
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2)
  })
})

describe('siblingsOf', () => {
  it('returns only the rows under the given parent, sorted by sort', () => {
    const rows = [
      entry('b', null, 1),
      entry('a', null, 0),
      entry('a2', 'a', 1),
      entry('a1', 'a', 0),
    ]
    expect(siblingsOf(rows, null).map((e) => e.id)).toEqual(['a', 'b'])
    expect(siblingsOf(rows, 'a').map((e) => e.id)).toEqual(['a1', 'a2'])
    expect(siblingsOf(rows, 'missing')).toEqual([])
  })
})

describe('groupSiblingsBySort', () => {
  it('groups every parent bucket in one pass, each sorted by sort', () => {
    const rows = [
      entry('b', null, 1),
      entry('a', null, 0),
      entry('a2', 'a', 1),
      entry('a1', 'a', 0),
    ]
    const map = groupSiblingsBySort(rows)
    expect(map.get(null)?.map((e) => e.id)).toEqual(['a', 'b'])
    expect(map.get('a')?.map((e) => e.id)).toEqual(['a1', 'a2'])
    expect(map.get('missing')).toBeUndefined()
  })

  it('agrees with siblingsOf for every present parent (shared ordering)', () => {
    const rows = [entry('a', null, 0), entry('b', null, 1), entry('a1', 'a', 0)]
    const map = groupSiblingsBySort(rows)
    for (const parentId of [null, 'a']) {
      expect(map.get(parentId)?.map((e) => e.id)).toEqual(
        siblingsOf(rows, parentId).map((e) => e.id),
      )
    }
  })
})

describe('flattenEntryTree', () => {
  it('depth-first flattens with hasChildren and depth, preserving order', () => {
    const rows = [entry('a', null, 0), entry('a1', 'a', 0), entry('b', null, 1)]
    const flat = flattenEntryTree(buildEntryTree(rows))
    expect(flat.map((f) => f.entry.id)).toEqual(['a', 'a1', 'b'])
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 0])
    expect(flat.find((f) => f.entry.id === 'a')?.hasChildren).toBe(true)
    expect(flat.find((f) => f.entry.id === 'a1')?.hasChildren).toBe(false)
  })

  it('a collapsed node is included but its subtree is hidden', () => {
    const rows = [entry('a', null, 0), entry('a1', 'a', 0), entry('a1x', 'a1', 0), entry('b', null, 1)]
    const flat = flattenEntryTree(buildEntryTree(rows), new Set(['a']))
    expect(flat.map((f) => f.entry.id)).toEqual(['a', 'b'])
  })
})

describe('subtreeIds', () => {
  it('returns the root plus every descendant (round-trip, subtree intact)', () => {
    const rows = [
      entry('a', null, 0),
      entry('a1', 'a', 0),
      entry('a1x', 'a1', 0),
      entry('a2', 'a', 1),
      entry('b', null, 1),
    ]
    expect(subtreeIds(rows, 'a').sort()).toEqual(['a', 'a1', 'a1x', 'a2'])
    expect(subtreeIds(rows, 'a1').sort()).toEqual(['a1', 'a1x'])
    expect(subtreeIds(rows, 'b')).toEqual(['b'])
  })
})
