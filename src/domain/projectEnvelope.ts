// Project export/import envelope (issue 015, SPEC §4.7, TECH_STACK §5, ADR-0006).
//
// Pure and store/DB-free, like completeness/coverage/canvasLayout. This module
// owns the ON-DISK FORMAT: the Zod-versioned envelope, its row shapes, the
// deterministic serialization, the id-remap graph rewrite, and the typed
// rejection errors. The DB layer (src/db/projectIO.ts) gathers rows into an
// EnvelopeTables and writes a remapped one back transactionally; it never
// decides format.
//
// Contents = exactly the SPEC §3 row set (all 9 tables) across every tier and
// recursion depth. NO derived data: no canvas geometry (invariant 5), no
// coverage. `tuple_hash` IS a stored binding column (SPEC §3), so it round-trips
// verbatim — losslessly, not recomputed.
import { z } from 'zod'

// Bump only with a migration path in parseEnvelope. A file whose version is
// GREATER than this is from a newer app build → NewerVersionError.
export const FORMAT_VERSION = 1 as const

// ── Row schemas — mirror src/db/schema.ts column-for-column (camelCase, as
// drizzle's $inferSelect yields). timestamps are ISO strings (schema mode
// 'string'); deleted_at is nullable everywhere it exists (bindings have none).
const iso = z.string()
const nullableIso = z.string().nullable()

const projectRow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const tier1PurposeRow = z.object({
  id: z.string(),
  projectId: z.string(),
  body: z.string(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const tier1PropRow = z.object({
  id: z.string(),
  projectId: z.string(),
  rank: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  sort: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const tier2TableRow = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  sort: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const tier2EntryRow = z.object({
  id: z.string(),
  tableId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  sort: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const dimensionRow = z.object({
  id: z.string(),
  projectId: z.string(),
  contextId: z.string().nullable(),
  sourceParamId: z.string().nullable(),
  name: z.string(),
  color: z.string(),
  sort: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const parameterRow = z.object({
  id: z.string(),
  dimensionId: z.string(),
  parentParamId: z.string().nullable(),
  sourceEntryId: z.string().nullable(),
  name: z.string(),
  sort: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const contextRow = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  symbol: z.string(),
  name: z.string().nullable(),
  justification: z.string().nullable(),
  sort: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: nullableIso,
})

const bindingRow = z.object({
  id: z.string(),
  contextId: z.string(),
  dimensionId: z.string(),
  parameterId: z.string(),
  tupleHash: z.string(),
  createdAt: iso,
  updatedAt: iso,
})

// One registry object keyed by SQL table name (matching schema.ts). Adding a
// pgTable without extending this is caught by projectIO.test.ts, which
// cross-checks these keys against drizzle's getTableName over the live schema —
// so a new table breaks the build loudly, as required.
const rowSchemas = {
  projects: projectRow,
  tier1_purpose: tier1PurposeRow,
  tier1_props: tier1PropRow,
  tier2_tables: tier2TableRow,
  tier2_entries: tier2EntryRow,
  dimensions: dimensionRow,
  parameters: parameterRow,
  contexts: contextRow,
  bindings: bindingRow,
} as const

export type TableName = keyof typeof rowSchemas

export const ENVELOPE_TABLE_NAMES = [
  'projects',
  'tier1_purpose',
  'tier1_props',
  'tier2_tables',
  'tier2_entries',
  'dimensions',
  'parameters',
  'contexts',
  'bindings',
] as const satisfies readonly TableName[]

// Every id-typed column per table: primary key `id` plus every FK. Remap
// rewrites exactly these; validation resolves exactly these (minus `id`).
const ID_FIELDS = {
  projects: ['id'],
  tier1_purpose: ['id', 'projectId'],
  tier1_props: ['id', 'projectId'],
  tier2_tables: ['id', 'projectId'],
  tier2_entries: ['id', 'tableId', 'parentId'],
  dimensions: ['id', 'projectId', 'contextId', 'sourceParamId'],
  parameters: ['id', 'dimensionId', 'parentParamId', 'sourceEntryId'],
  contexts: ['id', 'projectId', 'parentId'],
  bindings: ['id', 'contextId', 'dimensionId', 'parameterId'],
} as const satisfies Record<TableName, readonly string[]>

// FK field → the table it references. Self-referential chains
// (tier2_entries.parentId, parameters.parentParamId, contexts.parentId) and
// cross-links (dimensions.sourceParamId, parameters.sourceEntryId) are here too;
// remap/validation treat them uniformly through the global id map.
const FK_TARGETS: Record<TableName, Record<string, TableName>> = {
  projects: {},
  tier1_purpose: { projectId: 'projects' },
  tier1_props: { projectId: 'projects' },
  tier2_tables: { projectId: 'projects' },
  tier2_entries: { tableId: 'tier2_tables', parentId: 'tier2_entries' },
  dimensions: { projectId: 'projects', contextId: 'contexts', sourceParamId: 'parameters' },
  parameters: { dimensionId: 'dimensions', parentParamId: 'parameters', sourceEntryId: 'tier2_entries' },
  contexts: { projectId: 'projects', parentId: 'contexts' },
  bindings: { contextId: 'contexts', dimensionId: 'dimensions', parameterId: 'parameters' },
}

// The one self-referential parent column per table (for cycle detection).
const SELF_PARENT_FIELD: Partial<Record<TableName, string>> = {
  tier2_entries: 'parentId',
  parameters: 'parentParamId',
  contexts: 'parentId',
}

export type ProjectRowData = z.infer<typeof projectRow>
export type Row = Record<string, string | number | null>

export type EnvelopeTables = { [K in TableName]: z.infer<(typeof rowSchemas)[K]>[] }

export interface Envelope {
  formatVersion: typeof FORMAT_VERSION
  tables: EnvelopeTables
}

const envelopeSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION),
  tables: z.object({
    projects: z.array(projectRow),
    tier1_purpose: z.array(tier1PurposeRow),
    tier1_props: z.array(tier1PropRow),
    tier2_tables: z.array(tier2TableRow),
    tier2_entries: z.array(tier2EntryRow),
    dimensions: z.array(dimensionRow),
    parameters: z.array(parameterRow),
    contexts: z.array(contextRow),
    bindings: z.array(bindingRow),
  }),
})

// ── Typed rejections — calm, specific, one action each (STYLE_GUIDE §9). The
// UI renders `.message` verbatim.

export class NotGeDeExportError extends Error {
  constructor() {
    super('Not a GeDe export')
    this.name = 'NotGeDeExportError'
  }
}

export class NewerVersionError extends Error {
  constructor(public readonly fileVersion: number) {
    super('This file is from a newer version of GeDe — update to open it')
    this.name = 'NewerVersionError'
  }
}

export class CorruptedEnvelopeError extends Error {
  constructor(public readonly location: string) {
    super(`File damaged at \`${location}\` — nothing was imported`)
    this.name = 'CorruptedEnvelopeError'
  }
}

// Zod issue path → a short, user-facing location like `contexts[4]`. Drops the
// leading `tables` segment and stops at the row index (SPEC §9 examples).
function formatLocation(path: readonly PropertyKey[]): string {
  const segments = path[0] === 'tables' ? path.slice(1) : path
  const table = segments[0]
  if (table === undefined) return 'file'
  const index = segments[1]
  return typeof index === 'number' ? `${String(table)}[${index}]` : String(table)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Parse untrusted text → a fully validated Envelope, or throw a typed rejection.
// Order matters: JSON/shape marker first (Not a GeDe export), then version
// (newer), then schema + graph integrity (corrupted at a location). Never
// returns a partially-valid envelope.
export function parseEnvelope(text: string): Envelope {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new NotGeDeExportError()
  }
  if (!isRecord(raw) || typeof raw.formatVersion !== 'number') throw new NotGeDeExportError()
  if (raw.formatVersion > FORMAT_VERSION) throw new NewerVersionError(raw.formatVersion)
  if (raw.formatVersion !== FORMAT_VERSION) throw new NotGeDeExportError()

  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new CorruptedEnvelopeError(formatLocation(parsed.error.issues[0]?.path ?? []))
  }
  const envelope = parsed.data
  if (envelope.tables.projects.length !== 1) throw new CorruptedEnvelopeError('projects')
  validateReferences(envelope.tables)
  validateAcyclic(envelope.tables)
  return envelope
}

// Every non-null FK must resolve to a row in the table it references — catches a
// binding pointing at a stranger id, a dangling parent, etc.
function validateReferences(tables: EnvelopeTables): void {
  const idsByTable: Record<TableName, Set<string>> = {} as Record<TableName, Set<string>>
  for (const name of ENVELOPE_TABLE_NAMES) {
    idsByTable[name] = new Set((tables[name] as Row[]).map((r) => r.id as string))
  }
  for (const name of ENVELOPE_TABLE_NAMES) {
    const fks = FK_TARGETS[name]
    const rows = tables[name] as Row[]
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as Row
      for (const field of Object.keys(fks)) {
        const value = row[field]
        if (value === null || value === undefined) continue
        if (!idsByTable[fks[field] as TableName].has(value as string)) {
          throw new CorruptedEnvelopeError(`${name}[${i}]`)
        }
      }
    }
  }
}

// Self-referential parent chains must be acyclic (a tampered α→β→α loop).
function validateAcyclic(tables: EnvelopeTables): void {
  for (const name of ENVELOPE_TABLE_NAMES) {
    const field = SELF_PARENT_FIELD[name]
    if (!field) continue
    const rows = tables[name] as Row[]
    const parentById = new Map<string, string | null>()
    const indexById = new Map<string, number>()
    rows.forEach((r, i) => {
      parentById.set(r.id as string, (r[field] as string | null) ?? null)
      indexById.set(r.id as string, i)
    })
    for (const start of parentById.keys()) {
      const seen = new Set<string>()
      let current: string | null = start
      while (current !== null) {
        if (seen.has(current)) throw new CorruptedEnvelopeError(`${name}[${indexById.get(start) ?? 0}]`)
        seen.add(current)
        current = parentById.get(current) ?? null
      }
    }
  }
}

// ── Serialization — deterministic so re-export of the same rows is byte-stable.
// Rows sorted by id; fields emitted in schema order.

function fieldOrder(name: TableName): string[] {
  return Object.keys(rowSchemas[name].shape)
}

function normalizeRow(name: TableName, row: Row): Row {
  const out: Row = {}
  for (const field of fieldOrder(name)) out[field] = row[field] ?? null
  return out
}

function sortRows(name: TableName, rows: readonly Row[]): Row[] {
  return [...rows]
    .map((r) => normalizeRow(name, r))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

// Wrap gathered rows into a versioned, canonicalized envelope.
export function serializeEnvelope(tables: EnvelopeTables): Envelope {
  const normalized: Record<string, Row[]> = {}
  for (const name of ENVELOPE_TABLE_NAMES) {
    normalized[name] = sortRows(name, tables[name])
  }
  return { formatVersion: FORMAT_VERSION, tables: normalized as unknown as EnvelopeTables }
}

export function envelopeToJson(envelope: Envelope): string {
  return JSON.stringify(envelope, null, 2)
}

// ── Id remap — fresh ids everywhere, every reference rewritten. The whole
// system's ids are globally unique, so one old→new map drives every field
// (pk + fk + self-ref + cross-link) uniformly.
export interface RemapResult {
  tables: EnvelopeTables
  idMap: Map<string, string>
}

export function remapEnvelope(tables: EnvelopeTables, newId: () => string): RemapResult {
  const idMap = new Map<string, string>()
  for (const name of ENVELOPE_TABLE_NAMES) {
    for (const row of tables[name] as Row[]) idMap.set(row.id as string, newId())
  }
  const out: Record<string, Row[]> = {}
  for (const name of ENVELOPE_TABLE_NAMES) {
    const fields = ID_FIELDS[name] as readonly string[]
    out[name] = (tables[name] as Row[]).map((row) => {
      const copy: Row = { ...row }
      for (const field of fields) {
        const value = copy[field]
        if (typeof value === 'string') copy[field] = idMap.get(value) ?? value
      }
      return copy
    })
  }
  return { tables: out as unknown as EnvelopeTables, idMap }
}

// ── Friendly stats for the import status line ("… — 4 canvases, 23 contexts").
export interface EnvelopeStats {
  canvases: number
  contexts: number
}

export function envelopeStats(tables: EnvelopeTables): EnvelopeStats {
  // A canvas = a design surface: the always-present root canvas plus each
  // drilled-into child canvas (a distinct non-null dimension.context_id).
  const childCanvases = new Set(
    tables.dimensions.map((d) => d.contextId).filter((id): id is string => id !== null),
  )
  const liveContexts = tables.contexts.filter((c) => c.deletedAt === null).length
  return { canvases: 1 + childCanvases.size, contexts: liveContexts }
}

export function projectName(tables: EnvelopeTables): string {
  return tables.projects[0]?.name ?? 'project'
}

// Re-exported for the DB layer's insert plan and the schema cross-check test.
export { ID_FIELDS, FK_TARGETS, SELF_PARENT_FIELD }
