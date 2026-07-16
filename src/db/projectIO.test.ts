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
import { createWorkspace } from './workspaces'
import { adoptProject, gatherProjectRows, importProject, ProjectNotFoundError } from './projectIO'
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
  const { canvasId: c1CanvasId } = await openChildCanvas(db, c1.id)
  const childDims = await listDimensions(db, projectId, c1CanvasId)
  const childDim = childDims[0]
  if (childDim) {
    const subParam = await addParameter(db, childDim.id, 'Sub', childDim.sourceParamId)
    const cc = await createContext(db, projectId, c1.id)
    await bindParameter(db, cc.id, childDim.id, subParam.id)
  }

  return projectId
}

// Tables deliberately excluded from a project's export/import envelope — they
// aren't project-domain data (SPEC §4.7's "everything under one project"):
// - Issue 034: `workspaces`/`workspace_members` are account-level identity;
//   a destination workspace is chosen by the importer, not bundled in the file.
// - Issue 035: `invitations` is workspace-level membership state, not content.
// - Issue 043: `applied_mutations` is the write-path idempotency ledger —
//   server-side replay-safety bookkeeping with no `project_id`.
// Any OTHER new pgTable still breaks this test loudly, exactly as designed.
const NON_ENVELOPE_TABLES = ['workspaces', 'workspace_members', 'invitations', 'applied_mutations']

describe('projectIO — schema coverage guard', () => {
  it('the envelope covers exactly every project-domain pgTable in the schema (infra tables excepted)', () => {
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

// Issue 037 — the local→cloud on-ramp. adoptProject reuses gatherProjectRows +
// importProject (015) on the SAME db, targeting a different workspace than
// the source project's own — this is the local single-PGlite stand-in for
// "create the rows server-side" until 032/043's client flush is wired
// (HANDOFF: no live write-path client exists anywhere in this repo yet).
describe('projectIO — adoptProject (test-first plan)', () => {
  it('throws ProjectNotFoundError for an unknown project', async () => {
    const db = await freshDb()
    const ws = await createWorkspace(db, 'Acme')
    await expect(adoptProject(db, 'nonexistent', ws.id)).rejects.toThrow(ProjectNotFoundError)
  })

  it('round-trip: moves a local project into a workspace, structure-preserving, fresh ids, source marked adopted (plan #1)', async () => {
    const db = await freshDb()
    const sourceProjectId = await seedRichProject(db)
    const cloud = await createWorkspace(db, 'Cloud Workspace')

    const { project: adopted, stats, alreadyAdopted } = await adoptProject(db, sourceProjectId, cloud.id)

    expect(alreadyAdopted).toBe(false)
    expect(adopted.id).not.toBe(sourceProjectId)
    expect(adopted.workspaceId).toBe(cloud.id)
    expect(adopted.name).toBe('Tavalo')
    expect(stats.canvases).toBe(2)
    expect(stats.contexts).toBe(2)

    // Every workspace-scoped table of the adopted copy carries the
    // destination workspace, never the source's local one.
    const adoptedTables = await gatherProjectRows(db, adopted.id)
    for (const name of ['projects', 'tier1_purpose', 'tier1_props', 'tier2_tables', 'dimensions', 'contexts'] as const) {
      for (const row of adoptedTables[name]) {
        expect((row as { workspaceId: string }).workspaceId).toBe(cloud.id)
      }
    }
    // Structurally identical to the source (same row counts every table) —
    // "reproduces identically server-side".
    const sourceTables = await gatherProjectRows(db, sourceProjectId)
    for (const name of ENVELOPE_TABLE_NAMES) {
      expect(adoptedTables[name].length).toBe(sourceTables[name].length)
    }

    // Source project stays put — untouched apart from the adoption marker —
    // "the local copy stays until the sync mirror is confirmed".
    const [source] = await listProjects(db).then((rows) => rows.filter((p) => p.id === sourceProjectId))
    expect(source?.workspaceId).not.toBe(cloud.id)
    expect(source?.adoptedIntoProjectId).toBe(adopted.id)
    expect(source?.name).toBe('Tavalo')
  })

  it('is idempotent: adopting an already-adopted project returns the same cloud copy, not a second one', async () => {
    const db = await freshDb()
    const sourceProjectId = await seedRichProject(db)
    const cloud = await createWorkspace(db, 'Cloud Workspace')
    const before = (await listProjects(db)).length

    const first = await adoptProject(db, sourceProjectId, cloud.id)
    const second = await adoptProject(db, sourceProjectId, cloud.id)

    expect(second.alreadyAdopted).toBe(true)
    expect(second.project.id).toBe(first.project.id)
    // Exactly one new project landed (the source + the one adopted copy).
    expect((await listProjects(db)).length).toBe(before + 1)
  })

  it('a second adopt into a DIFFERENT workspace still returns the original copy (adoption targets the first destination)', async () => {
    const db = await freshDb()
    const sourceProjectId = await seedRichProject(db)
    const cloudA = await createWorkspace(db, 'Cloud A')
    const cloudB = await createWorkspace(db, 'Cloud B')

    const first = await adoptProject(db, sourceProjectId, cloudA.id)
    const second = await adoptProject(db, sourceProjectId, cloudB.id)

    expect(second.project.id).toBe(first.project.id)
    expect(second.project.workspaceId).toBe(cloudA.id)
  })

  it('is atomic: adopting into a nonexistent workspace writes nothing and leaves the source unadopted (plan #3)', async () => {
    const db = await freshDb()
    const sourceProjectId = await seedRichProject(db)
    const before = (await listProjects(db)).length

    await expect(adoptProject(db, sourceProjectId, 'no-such-workspace')).rejects.toThrow()

    expect((await listProjects(db)).length).toBe(before)
    const [source] = await listProjects(db).then((rows) => rows.filter((p) => p.id === sourceProjectId))
    expect(source?.adoptedIntoProjectId).toBeNull()

    // The failed attempt didn't poison retrying for real afterward.
    const cloud = await createWorkspace(db, 'Cloud Workspace')
    const retry = await adoptProject(db, sourceProjectId, cloud.id)
    expect(retry.alreadyAdopted).toBe(false)
    expect(retry.project.workspaceId).toBe(cloud.id)
  })

  it('the adopted copy syncs like any normal workspace project — its envelope round-trips cleanly (plan #4)', async () => {
    const db = await freshDb()
    const sourceProjectId = await seedRichProject(db)
    const cloud = await createWorkspace(db, 'Cloud Workspace')

    const { project: adopted } = await adoptProject(db, sourceProjectId, cloud.id)

    const reExported = serializeEnvelope(await gatherProjectRows(db, adopted.id))
    expect(() => parseEnvelope(envelopeToJson(reExported))).not.toThrow()
  })
})
