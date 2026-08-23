import { describe, expect, it } from 'vitest'
import { buildEntryTree, flattenEntryTree, siblingsOf } from './entryTree'
import { bigArchitectureFixture, deepChain, duplicateNamedEntries, manyTables, wideSiblings } from './entryTreeFixtures'

// These guard the fixture BUILDERS themselves — Phase 2's hierarchy search/
// index tests (and this phase's own e2e scale scenarios) trust these shapes
// without re-deriving them, so a broken generator here would silently
// corrupt every downstream test rather than fail loudly where it's actually
// introduced.

describe('manyTables', () => {
  it('builds a dozens-plus table set with distinct ids and sort-ordered names', () => {
    const tables = manyTables(48)
    expect(tables).toHaveLength(48)
    expect(new Set(tables.map((t) => t.id)).size).toBe(48)
    expect(tables.map((t) => t.sort)).toEqual(Array.from({ length: 48 }, (_, i) => i))
    expect(tables[0]?.name).toBe('Table 1')
    expect(tables[47]?.name).toBe('Table 48')
  })
})

describe('deepChain', () => {
  it('builds a strictly linear parent/child chain of the requested depth', () => {
    const rows = deepChain('t1', 30)
    expect(rows).toHaveLength(30)
    expect(rows[0]?.parentId).toBeNull()
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.parentId).toBe(rows[i - 1]?.id)
    }
  })

  // Ties the fixture directly to entryTree.ts's own recursion, so if either
  // drifts (a depth cap, an off-by-one) this fails here first.
  it('is exactly as deep as requested once run through buildEntryTree/flattenEntryTree', () => {
    const depth = 50
    const rows = deepChain('t1', depth)
    const flat = flattenEntryTree(buildEntryTree(rows))
    expect(flat).toHaveLength(depth)
    expect(flat[depth - 1]?.depth).toBe(depth - 1)
    expect(flat[depth - 1]?.hasChildren).toBe(false)
  })
})

describe('wideSiblings', () => {
  it('builds a large sibling set under one parent, sort-ordered', () => {
    const rows = wideSiblings('t1', 'parent-1', 200)
    expect(rows).toHaveLength(200)
    expect(rows.every((r) => r.parentId === 'parent-1')).toBe(true)
    expect(siblingsOf(rows, 'parent-1').map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('supports a top-level (null-parent) wide set too', () => {
    const rows = wideSiblings('t1', null, 10)
    expect(rows.every((r) => r.parentId === null)).toBe(true)
  })
})

describe('duplicateNamedEntries', () => {
  it('places the same name at every requested (table, parent) location, with distinct ids', () => {
    const rows = duplicateNamedEntries('Revenue', [
      { tableId: 't1', parentId: null },
      { tableId: 't2', parentId: 'p2' },
      { tableId: 't1', parentId: 'p1' },
    ])
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.name === 'Revenue')).toBe(true)
    expect(new Set(rows.map((r) => r.id)).size).toBe(3)
    expect(rows.map((r) => r.tableId)).toEqual(['t1', 't2', 't1'])
  })
})

describe('bigArchitectureFixture', () => {
  it('composes a dozens-of-tables + deep + wide + duplicate-name scenario that is internally referentially valid', () => {
    const { tables, entries } = bigArchitectureFixture()
    expect(tables.length).toBeGreaterThanOrEqual(40)

    const tableIds = new Set(tables.map((t) => t.id))
    const entryIds = new Set(entries.map((e) => e.id))
    for (const entry of entries) {
      expect(tableIds.has(entry.tableId)).toBe(true)
      if (entry.parentId !== null) expect(entryIds.has(entry.parentId)).toBe(true)
    }
  })

  it('exposes at least one deep chain, one wide sibling set, and a name duplicated across 3+ tables', () => {
    const { entries } = bigArchitectureFixture({ tableCount: 5, chainDepth: 20, siblingCount: 40 })
    const flat = flattenEntryTree(buildEntryTree(entries))
    expect(Math.max(...flat.map((f) => f.depth))).toBeGreaterThanOrEqual(19)

    const byParent = new Map<string | null, number>()
    for (const e of entries) byParent.set(e.parentId, (byParent.get(e.parentId) ?? 0) + 1)
    expect(Math.max(...byParent.values())).toBeGreaterThanOrEqual(40)

    const duplicateName = entries.find((e) => e.id === 'dup-entry-0')?.name
    const duplicates = entries.filter((e) => e.name === duplicateName)
    expect(duplicates.length).toBeGreaterThanOrEqual(3)
    expect(new Set(duplicates.map((e) => e.tableId)).size).toBeGreaterThanOrEqual(3)
  })

  it('rejects a tableCount below the 3 tables the duplicate-name scenario needs', () => {
    expect(() => bigArchitectureFixture({ tableCount: 2 })).toThrow()
  })
})
