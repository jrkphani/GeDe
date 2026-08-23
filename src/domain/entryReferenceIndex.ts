import type { Tier2EntryRow, Tier2TableRow } from '../db/mutations'
import { groupSiblingsBySort } from './entryTree'

// Phase 2 of the design-prose-references feature: a searchable, hierarchy-
// aware index over a project's Architecture (tier2_entries) rows, for a
// future `@`-mention autocomplete (later phases) to search against. Pure —
// no React/DB/store imports, same convention as entryTree.ts.

export interface EntryCandidate {
  entryId: string
  name: string
  description: string | null
  tableId: string
  tableName: string
  depth: number
  ancestorIds: readonly string[]
  ancestorNames: readonly string[]
  path: readonly string[]
  siblingIds: readonly string[]
  childIds: readonly string[]
  archived: boolean
}

export interface EntryReferenceIndex {
  candidates: readonly EntryCandidate[]
  byId: ReadonlyMap<string, EntryCandidate>
}

// Builds candidates table-by-table (ordered by table.sort), DFS-walking each
// table's siblings-by-parent map exactly once — NOT via subtreeIds/
// buildEntryTree per node, which would be O(n²) at the 40-table/25-deep/
// 60-wide scale entryTreeFixtures.ts's bigArchitectureFixture exercises.
export function buildEntryReferenceIndex(
  tables: readonly Tier2TableRow[],
  entries: readonly Tier2EntryRow[],
): EntryReferenceIndex {
  const entriesByTable = new Map<string, Tier2EntryRow[]>()
  for (const entry of entries) {
    const list = entriesByTable.get(entry.tableId)
    if (list) list.push(entry)
    else entriesByTable.set(entry.tableId, [entry])
  }

  const candidates: EntryCandidate[] = []
  const byId = new Map<string, EntryCandidate>()

  const orderedTables = [...tables].sort((a, b) => a.sort - b.sort)

  for (const table of orderedTables) {
    const tableEntries = entriesByTable.get(table.id) ?? []
    const bySort = groupSiblingsBySort(tableEntries)
    const tableArchived = table.deletedAt !== null

    const walk = (
      parentId: string | null,
      depth: number,
      ancestorIds: readonly string[],
      ancestorNames: readonly string[],
    ): void => {
      const siblings = bySort.get(parentId) ?? []
      const siblingIds = siblings.map((e) => e.id)
      for (const entry of siblings) {
        const childIds = (bySort.get(entry.id) ?? []).map((c) => c.id)
        const archived = tableArchived || entry.deletedAt !== null
        const candidate: EntryCandidate = {
          entryId: entry.id,
          name: entry.name,
          description: entry.description,
          tableId: table.id,
          tableName: table.name,
          depth,
          ancestorIds,
          ancestorNames,
          path: [table.name, ...ancestorNames, entry.name],
          siblingIds,
          childIds,
          archived,
        }
        byId.set(entry.id, candidate)
        if (!archived) candidates.push(candidate)
        walk(entry.id, depth + 1, [...ancestorIds, entry.id], [...ancestorNames, entry.name])
      }
    }

    walk(null, 0, [], [])
  }

  return { candidates, byId }
}

export interface EntryMatch {
  candidate: EntryCandidate
  score: number
}

const DEFAULT_LIMIT = 20

// Case-insensitive substring scoring, mirroring paletteRanking.ts's
// rankCommands tier structure: name-prefix beats name-substring beats
// path-substring beats description-substring; anything else doesn't match.
function scoreOf(candidate: EntryCandidate, q: string): number {
  const name = candidate.name.toLowerCase()
  if (name.startsWith(q)) return 100
  if (name.includes(q)) return 70
  const pathText = candidate.path.join(' ').toLowerCase()
  if (pathText.includes(q)) return 40
  const description = candidate.description?.toLowerCase() ?? ''
  if (description.includes(q)) return 20
  return 0
}

export function searchEntryReferences(
  index: EntryReferenceIndex,
  query: string,
  opts: { limit?: number } = {},
): EntryMatch[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const limit = opts.limit ?? DEFAULT_LIMIT

  const scored: { match: EntryMatch; index: number }[] = []
  index.candidates.forEach((candidate, i) => {
    const score = scoreOf(candidate, q)
    if (score > 0) scored.push({ match: { candidate, score }, index: i })
  })

  scored.sort((a, b) => b.match.score - a.match.score || a.index - b.index)

  return scored.slice(0, limit).map((s) => s.match)
}

export function resolveEntryReference(index: EntryReferenceIndex, entryId: string): EntryCandidate | null {
  return index.byId.get(entryId) ?? null
}
