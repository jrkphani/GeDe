import { describe, expect, it } from 'vitest'
import {
  buildEntryReferenceIndex,
  resolveEntryReference,
  searchEntryReferences,
} from './entryReferenceIndex'
import {
  bigArchitectureFixture,
  deepChain,
  duplicateNamedEntries,
  fixtureEntry,
  fixtureTable,
  manyTables,
  wideSiblings,
} from './entryTreeFixtures'

describe('buildEntryReferenceIndex', () => {
  it('threads depth/ancestors/path down a deep chain without a per-node subtree walk', () => {
    const table = fixtureTable('tbl-1', 'Table 1', 0)
    const entries = deepChain('tbl-1', 25)
    const index = buildEntryReferenceIndex([table], entries)
    const deepest = entries[entries.length - 1]
    if (!deepest) throw new Error('expected a deepest entry')
    const candidate = resolveEntryReference(index, deepest.id)
    expect(candidate?.depth).toBe(24)
    expect(candidate?.ancestorIds.length).toBe(24)
    expect(candidate?.path.length).toBe(26)
    expect(candidate?.childIds).toEqual([])
  })

  it('gives every wide sibling the full sort-ordered sibling set (self included)', () => {
    const table = fixtureTable('tbl-2', 'Table 2', 0)
    const entries = wideSiblings('tbl-2', null, 60)
    const index = buildEntryReferenceIndex([table], entries)
    const expectedIds = entries.map((e) => e.id)
    for (const entry of entries) {
      const candidate = resolveEntryReference(index, entry.id)
      expect(candidate?.siblingIds).toEqual(expectedIds)
      expect(candidate?.depth).toBe(0)
    }
  })

  it('never lets a duplicated name stand in for identity across tables', () => {
    const tables = manyTables(3)
    const [t1, t2, t3] = tables
    if (!t1 || !t2 || !t3) throw new Error('expected 3 tables')
    const entries = duplicateNamedEntries('Duplicate Entry', [
      { tableId: t1.id, parentId: null },
      { tableId: t2.id, parentId: null },
      { tableId: t3.id, parentId: null },
    ])
    const index = buildEntryReferenceIndex(tables, entries)
    const matches = searchEntryReferences(index, 'Duplicate Entry')
    expect(matches.length).toBe(3)
    expect(new Set(matches.map((m) => m.candidate.entryId)).size).toBe(3)
    expect(new Set(matches.map((m) => m.candidate.path[0])).size).toBe(3)
  })

  it('matches via description substring, and only entries that actually contain the query', () => {
    const table = fixtureTable('t1', 'Table 1', 0)
    const entries = [
      fixtureEntry('e1', 't1', null, 0, { name: 'Payment Timeout', description: 'latency budget' }),
      fixtureEntry('e2', 't1', null, 1, { name: 'Unrelated Entry', description: null }),
    ]
    const index = buildEntryReferenceIndex([table], entries)
    const matches = searchEntryReferences(index, 'latency')
    expect(matches.map((m) => m.candidate.entryId)).toEqual(['e1'])
  })

  it('orders candidates by table.sort then sibling sort, regardless of input order', () => {
    const tables = manyTables(40)
    const entries = tables.map((t, i) => fixtureEntry(`root-${i}`, t.id, null, 0))
    const index = buildEntryReferenceIndex([...tables].reverse(), [...entries].reverse())
    expect(index.candidates.map((c) => c.entryId)).toEqual(entries.map((e) => e.id))
  })

  it('ranks a name-prefix match ahead of path-only and description-only matches', () => {
    const table = fixtureTable('tbl-s', 'Sibling Table', 0)
    const entries = [
      fixtureEntry('sib-name', 'tbl-s', null, 0, { name: 'Sibling One' }),
      fixtureEntry('sib-path', 'tbl-s', null, 1, { name: 'Alpha' }),
      fixtureEntry('sib-desc', 'tbl-s', null, 2, { name: 'Beta', description: 'shares the same sibling group' }),
    ]
    const index = buildEntryReferenceIndex([table], entries)
    const matches = searchEntryReferences(index, 'Sibling')
    expect(matches.map((m) => m.candidate.entryId)).toEqual(['sib-name', 'sib-path', 'sib-desc'])
  })

  it('caps results to the requested limit, matching the head of the uncapped ranking', () => {
    const table = fixtureTable('tbl-cap', 'Table Cap', 0)
    const entries = wideSiblings('tbl-cap', null, 60)
    const index = buildEntryReferenceIndex([table], entries)
    const uncapped = searchEntryReferences(index, 'Sibling', { limit: 60 })
    const capped = searchEntryReferences(index, 'Sibling', { limit: 8 })
    expect(capped.length).toBe(8)
    expect(capped).toEqual(uncapped.slice(0, 8))
  })

  it('holds referential integrity across the full 40-table/25-deep/60-wide/3-duplicate scenario', () => {
    const { tables, entries } = bigArchitectureFixture()
    const index = buildEntryReferenceIndex(tables, entries)
    expect(index.byId.size).toBe(entries.length)
    expect(index.candidates.length).toBe(entries.length)
    for (const candidate of index.candidates) {
      for (const ancestorId of candidate.ancestorIds) {
        expect(index.byId.has(ancestorId)).toBe(true)
      }
    }
  })

  it('excludes an archived entry from candidates but still resolves it by id', () => {
    const { tables, entries } = bigArchitectureFixture()
    const target = entries[0]
    if (!target) throw new Error('expected at least one entry')
    const archivedEntries = entries.map((e) =>
      e.id === target.id ? { ...e, deletedAt: '2026-01-02T00:00:00.000Z' } : e,
    )
    const index = buildEntryReferenceIndex(tables, archivedEntries)
    expect(index.candidates.some((c) => c.entryId === target.id)).toBe(false)
    const resolved = resolveEntryReference(index, target.id)
    expect(resolved).not.toBeNull()
    expect(resolved?.archived).toBe(true)
  })

  it('treats every entry in a soft-deleted table as archived too', () => {
    const table = fixtureTable('tbl-arch', 'Archived Table', 0, {})
    const archivedTable = { ...table, deletedAt: '2026-01-02T00:00:00.000Z' }
    const entries = [fixtureEntry('e1', 'tbl-arch', null, 0)]
    const index = buildEntryReferenceIndex([archivedTable], entries)
    expect(index.candidates).toEqual([])
    expect(resolveEntryReference(index, 'e1')?.archived).toBe(true)
  })
})

describe('searchEntryReferences', () => {
  it('returns no matches for an empty or whitespace-only query', () => {
    const table = fixtureTable('t1', 'Table 1', 0)
    const entries = [fixtureEntry('e1', 't1', null, 0, { name: 'Anything' })]
    const index = buildEntryReferenceIndex([table], entries)
    expect(searchEntryReferences(index, '')).toEqual([])
    expect(searchEntryReferences(index, '   ')).toEqual([])
  })
})
