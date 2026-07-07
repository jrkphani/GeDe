import { describe, expect, it } from 'vitest'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { openDatabase, type Database } from './client'
import * as schema from './schema'
import {
  addDimension,
  addParameter,
  addTier1Prop,
  addTier2Entry,
  addTier2Table,
  bindParameter,
  createProject,
  createContext,
  listDimensions,
  listProjects,
  openChildCanvas,
  promoteEntries,
  setContextJustification,
  setTier1Purpose,
} from './mutations'
import { gatherProjectRows, importProject } from './projectIO'
import {
  ENVELOPE_TABLE_NAMES,
  CorruptedEnvelopeError,
  envelopeToJson,
  parseEnvelope,
  serializeEnvelope,
} from '../domain/projectEnvelope'

async function freshDb(): Promise<Database> {
  const { db } = await openDatabase('memory://')
  return db
}

// A project exercising every table and both self-ref / cross-link chains,
// including a drilled child canvas (recursion, issue 011).
async function seedRichProject(db: Database): Promise<string> {
  const project = await createProject(db, { name: 'Tavalo' })
  const projectId = project.id

  await setTier1Purpose(db, projectId, 'A pizza place worth returning to')
  await addTier1Prop(db, projectId, 'Fast')

  const table = await addTier2Table(db, projectId, 'Value')
  const entryA = await addTier2Entry(db, table.id, null, 'Speed')
  await addTier2Entry(db, table.id, entryA.id, 'Sub-speed')

  const d1 = await addDimension(db, projectId)
  const d2 = await addDimension(db, projectId)
  const p1a = await addParameter(db, d1.id, 'Low')
  await addParameter(db, d1.id, 'High')
  const p2a = await addParameter(db, d2.id, 'Cheap')

  // Cross-link: promote a tier-2 entry into d1 → a parameter with sourceEntryId.
  await promoteEntries(db, {
    projectId,
    entryIds: [entryA.id],
    target: { kind: 'existing', dimensionId: d1.id },
  })

  // A complete + justified root context.
  const c1 = await createContext(db, projectId)
  await bindParameter(db, c1.id, d1.id, p1a.id)
  await bindParameter(db, c1.id, d2.id, p2a.id)
  await setContextJustification(db, c1.id, 'Because.')

  // Drill in: seeds child-canvas dimensions (contextId + sourceParamId set).
  await openChildCanvas(db, c1.id)
  const childDims = await listDimensions(db, projectId, c1.id)
  const childDim = childDims[0]
  if (childDim) {
    const subParam = await addParameter(db, childDim.id, 'Sub', childDim.sourceParamId)
    const cc = await createContext(db, projectId, c1.id)
    await bindParameter(db, cc.id, childDim.id, subParam.id)
  }

  return projectId
}

// Issue 034 — `workspaces`/`workspace_members` are account-level identity
// tables, not part of any single project's exported tree (the envelope is
// "everything under one project", SPEC §4.7); a project export/import never
// carries them, and a destination workspace is chosen by the importer, not
// bundled in the file (src/domain/projectEnvelope.ts's remapEnvelope). This
// is the one documented exclusion from the schema-coverage guard below — any
// OTHER new pgTable still breaks this test loudly, exactly as designed.
//
// Issue 035 — `invitations` is the same kind of exclusion: a pending grant is
// itself workspace-level identity/membership state (like workspace_members),
// not project content — exporting a project never carries who was invited to
// its workspace, and importing one never re-issues invitations either.
const NON_ENVELOPE_TABLES = ['workspaces', 'workspace_members', 'invitations']

describe('projectIO — schema coverage guard', () => {
  it('the envelope covers exactly every project-scoped pgTable in the schema', () => {
    const schemaTableNames = (Object.values(schema).filter((v) => is(v, PgTable)) as PgTable[])
      .map((t) => getTableName(t))
      .filter((name) => !NON_ENVELOPE_TABLES.includes(name))
      .sort()
    expect(schemaTableNames).toEqual([...ENVELOPE_TABLE_NAMES].sort())
  })
})

describe('projectIO — export gather', () => {
  it('gathers every row of the project across all 9 tables', async () => {
    const db = await freshDb()
    const projectId = await seedRichProject(db)
    const tables = gatherProjectRows(db, projectId)
    const t = await tables
    expect(t.projects).toHaveLength(1)
    expect(t.tier1_purpose).toHaveLength(1)
    expect(t.tier1_props).toHaveLength(1)
    expect(t.tier2_tables).toHaveLength(1)
    expect(t.tier2_entries).toHaveLength(2)
    // 2 root dims + 1 child-canvas dim
    expect(t.dimensions.length).toBeGreaterThanOrEqual(3)
    // params: Low/High/Cheap + promoted (Speed) + sub-param
    expect(t.parameters.length).toBeGreaterThanOrEqual(5)
    expect(t.contexts).toHaveLength(2)
    expect(t.bindings.length).toBeGreaterThanOrEqual(3)
    // A child-canvas dimension carries both a contextId and a sourceParamId.
    expect(t.dimensions.some((d) => d.contextId !== null && d.sourceParamId !== null)).toBe(true)
  })
})

describe('projectIO — import round-trip (atomic, new project)', () => {
  it('import creates a fresh project whose graph is referentially intact', async () => {
    const db = await freshDb()
    const projectId = await seedRichProject(db)

    const json = envelopeToJson(serializeEnvelope(await gatherProjectRows(db, projectId)))
    const envelope = parseEnvelope(json)
    const { project: imported, stats } = await importProject(db, envelope)

    expect(imported.id).not.toBe(projectId)
    expect(imported.name).toBe('Tavalo')
    // Root canvas + one drilled child canvas.
    expect(stats.canvases).toBe(2)
    expect(stats.contexts).toBe(2)

    // Re-gathering the imported project yields the same shape and a graph that
    // still parses cleanly (every FK resolves) — proves the remap + insert order.
    const reExport = serializeEnvelope(await gatherProjectRows(db, imported.id))
    const source = serializeEnvelope(await gatherProjectRows(db, projectId))
    for (const name of ENVELOPE_TABLE_NAMES) {
      expect(reExport.tables[name].length).toBe(source.tables[name].length)
    }
    expect(() => parseEnvelope(envelopeToJson(reExport))).not.toThrow()

    // The imported child-canvas dimension points at an imported parameter.
    const childDim = reExport.tables.dimensions.find((d) => d.sourceParamId !== null)
    expect(reExport.tables.parameters.some((p) => p.id === childDim?.sourceParamId)).toBe(true)
    // Both projects now coexist (import never overwrites).
    expect((await listProjects(db)).length).toBe(2)
  })

  it('is atomic: a constraint violation mid-import writes nothing', async () => {
    const db = await freshDb()
    const projectId = await seedRichProject(db)
    const before = (await listProjects(db)).length

    const source = serializeEnvelope(await gatherProjectRows(db, projectId))
    // Tamper: duplicate a binding so (context_id, dimension_id) collides on the
    // unique index — passes parse (refs are valid) but fails at INSERT.
    const broken = JSON.parse(envelopeToJson(source)) as {
      formatVersion: number
      tables: Record<string, Record<string, string | number | null>[]>
    }
    const bindingRows = broken.tables.bindings ?? []
    const b0 = bindingRows[0]
    if (b0) bindingRows.push({ ...b0, id: `${String(b0.id)}-dup` })
    const envelope = parseEnvelope(JSON.stringify(broken))

    await expect(importProject(db, envelope)).rejects.toThrow()
    // Rolled back: no new project, no orphaned rows.
    expect((await listProjects(db)).length).toBe(before)
  })
})

describe('projectIO — rejection', () => {
  it('a corrupted envelope never reaches the DB', () => {
    expect(() => parseEnvelope('{"formatVersion":1,"tables":{}}')).toThrow(CorruptedEnvelopeError)
  })
})
