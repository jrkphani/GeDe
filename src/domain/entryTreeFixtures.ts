// Reusable scale/shape fixtures for Architecture (tier2) hierarchy tests.
// Pure and store/DB-free, like entryTree.ts itself — no React/DB imports, only
// row shapes (mirrors src/db/schema.ts's tier2Tables/tier2Entries column-for-
// column, the same convention projectEnvelope.ts's row schemas follow).
//
// Built for the design-prose-references reference-token feature's Phase 2 (a
// hierarchy search/index over tier2_entries) and later e2e specs, both of
// which need MANY-table, deep, wide-sibling, and duplicate-named scenarios —
// tedious and error-prone to hand-write inline (see projectEnvelope.test.ts's
// `fixture()` for what that looks like at even a modest, single-table scale).
// These builders are the one shared source, so Phase 2's tests and this
// phase's own sanity tests (entryTreeFixtures.test.ts) can never disagree
// about what "deep" or "wide" or "duplicate" means.
import type { Tier2EntryRow, Tier2TableRow } from '../db/mutations'

const ISO = '2026-01-01T00:00:00.000Z'

export interface TableOptions {
  workspaceId?: string
  projectId?: string
  createdAt?: string
  updatedAt?: string
}

// One fully-populated Tier2TableRow — generalizes entryTree.test.ts's own
// minimal `entry()` factory idiom to the tables side.
export function fixtureTable(id: string, name: string, sort: number, opts: TableOptions = {}): Tier2TableRow {
  return {
    id,
    projectId: opts.projectId ?? 'p1',
    workspaceId: opts.workspaceId ?? 'ws1',
    name,
    nameHeader: null,
    descriptionHeader: null,
    sort,
    createdAt: opts.createdAt ?? ISO,
    updatedAt: opts.updatedAt ?? ISO,
    deletedAt: null,
  }
}

export interface EntryOptions {
  workspaceId?: string
  name?: string
  description?: string | null
  createdAt?: string
  updatedAt?: string
}

// One Tier2EntryRow — the same field defaults as entryTree.test.ts's `entry()`,
// generalized to take an explicit table id and (optionally) an explicit name.
export function fixtureEntry(
  id: string,
  tableId: string,
  parentId: string | null,
  sort: number,
  opts: EntryOptions = {},
): Tier2EntryRow {
  return {
    id,
    tableId,
    workspaceId: opts.workspaceId ?? 'ws1',
    parentId,
    name: opts.name ?? id,
    nameRichText: null,
    description: opts.description ?? null,
    sort,
    createdAt: opts.createdAt ?? ISO,
    updatedAt: opts.updatedAt ?? ISO,
    deletedAt: null,
  }
}

// ── Dozens-of-tables scale ──────────────────────────────────────────────────

// `count` tables named `${namePrefix}${n}` (1-indexed, matching sibling
// `sort` order), ids `${idPrefix}${n}`. A hierarchy index must scale across
// the TABLE axis too, not just depth within one table — SPEC §4.6 tables are
// freely addable, so a real project can have dozens.
export function manyTables(count: number, opts: TableOptions & { idPrefix?: string; namePrefix?: string } = {}): Tier2TableRow[] {
  const { idPrefix = 'tbl-', namePrefix = 'Table ', ...tableOpts } = opts
  return Array.from({ length: count }, (_, i) => fixtureTable(`${idPrefix}${i + 1}`, `${namePrefix}${i + 1}`, i, tableOpts))
}

// ── Deep nesting ─────────────────────────────────────────────────────────────

// A single linear chain root -> child -> grandchild -> ... of `depth` entries
// (depth >= 1), each the sole child of the one before. Exercises the
// "many levels of parent/child" axis — buildEntryTree/flattenEntryTree
// (entryTree.ts) are both already unbounded-depth recursive, so this is what
// actually stresses that, at a scale no hand-written fixture would bother with.
export function deepChain(tableId: string, depth: number, opts: EntryOptions & { idPrefix?: string } = {}): Tier2EntryRow[] {
  const { idPrefix = `${tableId}-d`, ...entryOpts } = opts
  const rows: Tier2EntryRow[] = []
  let parentId: string | null = null
  for (let level = 0; level < depth; level++) {
    const id = `${idPrefix}${level}`
    rows.push(
      fixtureEntry(id, tableId, parentId, 0, {
        ...entryOpts,
        name: entryOpts.name ? `${entryOpts.name} L${level}` : `Level ${level}`,
      }),
    )
    parentId = id
  }
  return rows
}

// ── Wide sibling sets ────────────────────────────────────────────────────────

// `count` entries all sharing `parentId` (null = top-level), sort-ordered
// 0..count-1 — the "many children under one parent" axis, orthogonal to depth.
export function wideSiblings(
  tableId: string,
  parentId: string | null,
  count: number,
  opts: EntryOptions & { idPrefix?: string; namePrefix?: string } = {},
): Tier2EntryRow[] {
  const { idPrefix = `${tableId}-s`, namePrefix = 'Sibling ', ...entryOpts } = opts
  return Array.from({ length: count }, (_, i) => fixtureEntry(`${idPrefix}${i}`, tableId, parentId, i, { ...entryOpts, name: `${namePrefix}${i}` }))
}

// ── Duplicate names across tables/branches ──────────────────────────────────

// One entry sharing `name` at EACH of `locations` — a (tableId, parentId) pair
// per occurrence. tier2_entries.name carries no uniqueness constraint (only
// `id` is a PK — see schema.ts), so a hierarchy-aware reference index MUST
// disambiguate by table + ancestor path, never by name alone. This is a
// realistic input to test that against, not an adversarial one.
export function duplicateNamedEntries(
  name: string,
  locations: readonly { tableId: string; parentId: string | null }[],
  opts: EntryOptions & { idPrefix?: string } = {},
): Tier2EntryRow[] {
  const { idPrefix = 'dup-', ...entryOpts } = opts
  return locations.map((loc, i) => fixtureEntry(`${idPrefix}${i}`, loc.tableId, loc.parentId, 0, { ...entryOpts, name }))
}

// ── Composite scale scenario ─────────────────────────────────────────────────

export interface BigArchitectureFixtureOptions {
  tableCount?: number
  chainDepth?: number
  siblingCount?: number
  duplicateName?: string
  workspaceId?: string
  projectId?: string
}

export interface BigArchitectureFixture {
  tables: Tier2TableRow[]
  entries: Tier2EntryRow[]
}

// The composed scenario a hierarchy search/index test (or a perf-oriented e2e
// spec seeding via project import — src/domain/projectEnvelope.ts's envelope
// format, not clicking through the UI dozens of times) most needs in one call:
// dozens of tables, one deep chain, one wide sibling set, and one name
// duplicated across three different tables — every axis this phase's brief
// calls out, composed into ONE referentially valid dataset (every entry's
// tableId resolves in `tables`, every non-null parentId resolves to another
// entry's id in `entries` — see entryTreeFixtures.test.ts's own integrity
// check, which walks these exact invariants).
export function bigArchitectureFixture(opts: BigArchitectureFixtureOptions = {}): BigArchitectureFixture {
  const { tableCount = 40, chainDepth = 25, siblingCount = 60, duplicateName = 'Duplicate Entry', workspaceId = 'ws1', projectId = 'p1' } = opts

  const tables = manyTables(tableCount, { workspaceId, projectId })
  const [firstTable, secondTable, thirdTable] = tables
  if (!firstTable || !secondTable || !thirdTable) {
    throw new Error('bigArchitectureFixture requires tableCount >= 3')
  }

  const entries: Tier2EntryRow[] = [
    ...deepChain(firstTable.id, chainDepth, { workspaceId }),
    ...wideSiblings(secondTable.id, null, siblingCount, { workspaceId }),
    ...duplicateNamedEntries(
      duplicateName,
      [
        { tableId: firstTable.id, parentId: null },
        { tableId: secondTable.id, parentId: null },
        { tableId: thirdTable.id, parentId: null },
      ],
      { workspaceId, idPrefix: 'dup-entry-' },
    ),
  ]

  return { tables, entries }
}
