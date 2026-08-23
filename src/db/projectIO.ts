import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { firstOrThrow } from './util'
import {
  bindings,
  canvases,
  contexts,
  dimensions,
  parameters,
  projects,
  tier1Props,
  tier1Purpose,
  tier2Entries,
  tier2Tables,
} from './schema'
import {
  ENVELOPE_TABLE_NAMES,
  type Envelope,
  type EnvelopeTables,
  type EnvelopeStats,
  envelopeStats,
  envelopeToJson,
  parseEnvelope,
  remapEnvelope,
  serializeEnvelope,
} from '../domain/projectEnvelope'
import type { ProjectRow } from './mutations'
import { getOrCreateDefaultWorkspace } from './workspaces'

// The type Database['transaction'] hands its callback — extracted rather than
// duplicated so importProject's optional onInserted hook (issue 037) and
// adoptProject below share the exact same transaction handle drizzle gives
// the callback, with no `any`.
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

function now(): string {
  return new Date().toISOString()
}

// The DB seam for project export/import (issue 015). The FORMAT lives in
// src/domain/projectEnvelope.ts; this module only READS a project's rows into an
// EnvelopeTables (export) and WRITES a remapped one back inside a single
// transaction (import). Components reach it through the store, never directly.

// Gather every row of a project across all 9 tables — including soft-deleted
// rows, so an export is a faithful clone (SPEC §4.7 backup format). No derived
// data is read (no layout, no coverage); tuple_hash is a stored binding column.
export async function gatherProjectRows(db: Database, projectId: string): Promise<EnvelopeTables> {
  const projectRows = await db.select().from(projects).where(eq(projects.id, projectId))
  const project = firstOrThrow(projectRows, 'project not found')

  // Issue 090 — every canvas of the project (root + child), so a multi-canvas
  // project round-trips losslessly.
  const canvasRows = await db.select().from(canvases).where(eq(canvases.projectId, projectId))

  const tableRows = await db.select().from(tier2Tables).where(eq(tier2Tables.projectId, projectId))
  const dimensionRows = await db.select().from(dimensions).where(eq(dimensions.projectId, projectId))
  const contextRows = await db.select().from(contexts).where(eq(contexts.projectId, projectId))

  const tableIds = tableRows.map((r) => r.id)
  const dimensionIds = dimensionRows.map((r) => r.id)
  const contextIds = contextRows.map((r) => r.id)

  const entryRows = tableIds.length
    ? await db.select().from(tier2Entries).where(inArray(tier2Entries.tableId, tableIds))
    : []
  const parameterRows = dimensionIds.length
    ? await db.select().from(parameters).where(inArray(parameters.dimensionId, dimensionIds))
    : []
  const bindingRows = contextIds.length
    ? await db.select().from(bindings).where(inArray(bindings.contextId, contextIds))
    : []

  const purposeRows = await db.select().from(tier1Purpose).where(eq(tier1Purpose.projectId, projectId))
  const propRows = await db.select().from(tier1Props).where(eq(tier1Props.projectId, projectId))

  return {
    projects: [project],
    canvases: canvasRows,
    tier1_purpose: purposeRows,
    tier1_props: propRows,
    tier2_tables: tableRows,
    tier2_entries: entryRows,
    dimensions: dimensionRows,
    parameters: parameterRows,
    contexts: contextRows,
    bindings: bindingRows,
  }
}

export interface ImportResult {
  project: ProjectRow
  stats: EnvelopeStats
  restored: boolean
}

// After remapEnvelope, every workspace-scoped table's rows carry a real
// (non-null) workspaceId — remapEnvelope always stamps targetWorkspaceId onto
// them. The envelope's own row type stays nullable (a legitimate shape before
// remap — a v1-upgraded file's rows start out null), so this narrows at the
// one point that matters: the actual INSERT into a NOT NULL DB column.
function withWorkspace<T extends { workspaceId: string | null }>(
  rows: readonly T[],
): (Omit<T, 'workspaceId'> & { workspaceId: string })[] {
  return rows.map((row) => ({ ...row, workspaceId: row.workspaceId as string }))
}

function stampWorkspace(tables: EnvelopeTables, workspaceId: string): EnvelopeTables {
  const stamped = {} as EnvelopeTables
  const target = stamped as Record<string, unknown>
  for (const name of ENVELOPE_TABLE_NAMES) {
    target[name] = tables[name].map((row) => ({ ...row, workspaceId }))
  }
  return stamped
}

// A restore preserves the envelope's IDs. Insert any rows added since the
// previous restore, then update every row once all non-null FK targets exist.
// The nullable half of each cycle stays deferred until the final pass.
async function restoreProjectGraph(tx: Tx, tables: EnvelopeTables): Promise<ProjectRow> {
  const projectRows = withWorkspace(tables.projects)
  const project = firstOrThrow(projectRows)
  const existing = firstOrThrow(
    await tx.update(projects).set(project).where(eq(projects.id, project.id)).returning(),
  )

  const canvasRows = withWorkspace(tables.canvases)
  const purposeRows = withWorkspace(tables.tier1_purpose)
  const propRows = withWorkspace(tables.tier1_props)
  const tableRows = withWorkspace(tables.tier2_tables)
  const entryRows = withWorkspace(tables.tier2_entries)
  const dimensionRows = withWorkspace(tables.dimensions)
  const parameterRows = withWorkspace(tables.parameters)
  const contextRows = withWorkspace(tables.contexts)
  const bindingRows = withWorkspace(tables.bindings)

  if (canvasRows.length) await tx.insert(canvases).values(canvasRows.map((row) => ({ ...row, parentContextId: null }))).onConflictDoNothing()
  if (contextRows.length) await tx.insert(contexts).values(contextRows.map((row) => ({ ...row, parentId: null, canvasId: row.canvasId as string }))).onConflictDoNothing()
  if (purposeRows.length) await tx.insert(tier1Purpose).values(purposeRows).onConflictDoNothing()
  if (propRows.length) await tx.insert(tier1Props).values(propRows).onConflictDoNothing()
  if (tableRows.length) await tx.insert(tier2Tables).values(tableRows).onConflictDoNothing()
  if (entryRows.length) await tx.insert(tier2Entries).values(entryRows.map((row) => ({ ...row, parentId: null }))).onConflictDoNothing()
  if (dimensionRows.length) await tx.insert(dimensions).values(dimensionRows.map((row) => ({ ...row, sourceParamId: null, canvasId: row.canvasId as string }))).onConflictDoNothing()
  if (parameterRows.length) await tx.insert(parameters).values(parameterRows.map((row) => ({ ...row, parentParamId: null }))).onConflictDoNothing()
  // Bindings also have a content unique key (context + dimension), so do not
  // hide a malformed snapshot behind ON CONFLICT DO NOTHING. Only a matching
  // primary key is an existing row eligible for restore.
  for (const row of bindingRows) {
    const found = await tx.select({ id: bindings.id }).from(bindings).where(eq(bindings.id, row.id))
    if (!found.length) await tx.insert(bindings).values(row)
  }

  for (const row of canvasRows) await tx.update(canvases).set({ ...row, parentContextId: null }).where(eq(canvases.id, row.id))
  for (const row of contextRows) await tx.update(contexts).set({ ...row, parentId: null, canvasId: row.canvasId as string }).where(eq(contexts.id, row.id))
  for (const row of purposeRows) await tx.update(tier1Purpose).set(row).where(eq(tier1Purpose.id, row.id))
  for (const row of propRows) await tx.update(tier1Props).set(row).where(eq(tier1Props.id, row.id))
  for (const row of tableRows) await tx.update(tier2Tables).set(row).where(eq(tier2Tables.id, row.id))
  for (const row of entryRows) await tx.update(tier2Entries).set({ ...row, parentId: null }).where(eq(tier2Entries.id, row.id))
  for (const row of dimensionRows) await tx.update(dimensions).set({ ...row, sourceParamId: null, canvasId: row.canvasId as string }).where(eq(dimensions.id, row.id))
  for (const row of parameterRows) await tx.update(parameters).set({ ...row, parentParamId: null }).where(eq(parameters.id, row.id))
  for (const row of bindingRows) await tx.update(bindings).set(row).where(eq(bindings.id, row.id))

  for (const row of canvasRows) {
    if (row.parentContextId !== null) await tx.update(canvases).set({ parentContextId: row.parentContextId }).where(eq(canvases.id, row.id))
  }
  for (const row of contextRows) {
    if (row.parentId !== null) await tx.update(contexts).set({ parentId: row.parentId }).where(eq(contexts.id, row.id))
  }
  for (const row of entryRows) {
    if (row.parentId !== null) await tx.update(tier2Entries).set({ parentId: row.parentId }).where(eq(tier2Entries.id, row.id))
  }
  for (const row of parameterRows) {
    if (row.parentParamId !== null) await tx.update(parameters).set({ parentParamId: row.parentParamId }).where(eq(parameters.id, row.id))
  }
  for (const row of dimensionRows) {
    if (row.sourceParamId !== null) await tx.update(dimensions).set({ sourceParamId: row.sourceParamId }).where(eq(dimensions.id, row.id))
  }

  return existing
}

// Import restores a project whose stable exported ID already exists in the
// destination workspace. Otherwise it creates a NEW project (fresh ids, every
// reference rewritten). Both paths are ATOMIC: a failure rolls back the lot —
// nothing partial ever appears. See docs/issues/015 appendix.
//
// Insert order sidesteps FK cycles without touching the (non-deferrable) schema:
// the self-referential parent columns and the dimensions↔parameters cross-cycle
// column (sourceParamId) are inserted NULL, then set in a second UPDATE pass
// once every row exists.
//
// Issue 034 — every imported row is remapped into `targetWorkspaceId` (never
// the exporting workspace's original id, which the importer may not even
// belong to — "remap into the importer's chosen workspace" per the issue's
// implementation notes). Defaults to the local single-user default workspace
// (getOrCreateDefaultWorkspace) so pre-034 callers (the drag-drop/button
// import flow, issue 015) keep working unchanged; a future workspace-aware UI
// (035+) can pass an explicit destination.
export interface ImportOptions {
  // Issue 037 (local→cloud on-ramp) — runs INSIDE the same transaction as the
  // insert, right after the deferred-FK second pass, before the transaction
  // commits. adoptProject's only current caller uses this to stamp the
  // SOURCE project (a different row, in the same `projects` table) with a
  // pointer to the copy just created — so a mid-transaction failure rolls
  // back the stamp along with every inserted row, never leaving the source
  // half-adopted (test-first plan #3). Every other importProject caller
  // (the drag-drop/button import flow) passes nothing.
  onInserted?: (tx: Tx, insertedProject: ProjectRow) => Promise<void>
}

export async function importProject(
  db: Database,
  envelope: Envelope,
  targetWorkspaceId?: string,
  options?: ImportOptions,
): Promise<ImportResult> {
  const workspaceId = targetWorkspaceId ?? (await getOrCreateDefaultWorkspace(db))
  const sourceProject = envelope.tables.projects[0]
  if (!sourceProject) throw new Error('project envelope has no project')
  const existing = await db.select().from(projects).where(eq(projects.id, sourceProject.id))
  const restoresExisting = existing[0]?.workspaceId === workspaceId
  const tables = restoresExisting
    ? stampWorkspace(envelope.tables, workspaceId)
    : remapEnvelope(envelope.tables, uuidv7, workspaceId).tables
  const stats = envelopeStats(tables)

  const project = await db.transaction(async (tx) => {
    if (restoresExisting) return restoreProjectGraph(tx, tables)
    const insertedProject = firstOrThrow(
      await tx.insert(projects).values(withWorkspace(tables.projects)).returning(),
    )

    // Issue 090 — canvases insert BEFORE contexts/dimensions so their NOT-NULL
    // (hence non-deferrable) canvas_id resolves. parent_context_id (the nullable
    // half of the canvases↔contexts cycle) is deferred NULL and restored in the
    // second pass, mirroring the contexts.parentId / dimensions.sourceParamId
    // treatment below.
    if (tables.canvases.length) {
      await tx.insert(canvases).values(withWorkspace(tables.canvases).map((c) => ({ ...c, parentContextId: null })))
    }

    // parent_id deferred (self-ref) — the whole tree exists before we wire it.
    // canvas_id resolves now (canvases inserted above); it is NOT NULL after
    // remap (real data always sets it; a v4-upgraded file has it synthesized).
    if (tables.contexts.length) {
      await tx
        .insert(contexts)
        .values(withWorkspace(tables.contexts).map((c) => ({ ...c, parentId: null, canvasId: c.canvasId as string })))
    }

    if (tables.tier1_purpose.length) {
      await tx.insert(tier1Purpose).values(withWorkspace(tables.tier1_purpose))
    }
    if (tables.tier1_props.length) {
      await tx.insert(tier1Props).values(withWorkspace(tables.tier1_props))
    }
    if (tables.tier2_tables.length) {
      await tx.insert(tier2Tables).values(withWorkspace(tables.tier2_tables))
    }

    // parent_id deferred (self-ref).
    if (tables.tier2_entries.length) {
      await tx.insert(tier2Entries).values(withWorkspace(tables.tier2_entries).map((e) => ({ ...e, parentId: null })))
    }

    // source_param_id deferred (dimensions ↔ parameters cross-cycle); canvas_id
    // resolves now (canvases inserted above) and is NOT NULL after remap.
    if (tables.dimensions.length) {
      await tx
        .insert(dimensions)
        .values(withWorkspace(tables.dimensions).map((d) => ({ ...d, sourceParamId: null, canvasId: d.canvasId as string })))
    }

    // parent_param_id deferred (self-ref); dimension_id + source_entry_id resolve now.
    if (tables.parameters.length) {
      await tx.insert(parameters).values(withWorkspace(tables.parameters).map((p) => ({ ...p, parentParamId: null })))
    }

    if (tables.bindings.length) await tx.insert(bindings).values(withWorkspace(tables.bindings))

    // ── Second pass: wire the deferred self/cross references now every row exists.
    // Issue 090 — a child canvas's parent_context_id (deferred NULL above) now
    // that every context row exists; a root canvas restores cleanly to null.
    for (const cv of tables.canvases) {
      if (cv.parentContextId !== null) {
        await tx.update(canvases).set({ parentContextId: cv.parentContextId }).where(eq(canvases.id, cv.id))
      }
    }
    for (const c of tables.contexts) {
      if (c.parentId !== null) {
        await tx.update(contexts).set({ parentId: c.parentId }).where(eq(contexts.id, c.id))
      }
    }
    for (const e of tables.tier2_entries) {
      if (e.parentId !== null) {
        await tx.update(tier2Entries).set({ parentId: e.parentId }).where(eq(tier2Entries.id, e.id))
      }
    }
    for (const p of tables.parameters) {
      if (p.parentParamId !== null) {
        await tx.update(parameters).set({ parentParamId: p.parentParamId }).where(eq(parameters.id, p.id))
      }
    }
    for (const d of tables.dimensions) {
      if (d.sourceParamId !== null) {
        await tx.update(dimensions).set({ sourceParamId: d.sourceParamId }).where(eq(dimensions.id, d.id))
      }
    }

    await options?.onInserted?.(tx, insertedProject)

    return insertedProject
  })

  return { project, stats, restored: restoresExisting }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found')
    this.name = 'ProjectNotFoundError'
  }
}

export interface AdoptResult {
  // The project row as it exists in the destination workspace — either the
  // fresh copy this call just created, or (idempotent replay) the copy a
  // prior call already created.
  project: ProjectRow
  stats: EnvelopeStats
  // True when the source project was already adopted — this call found the
  // existing cloud copy and returned it untouched; no new rows were written
  // (test-first plan: "don't double-import").
  alreadyAdopted: boolean
  // Every row of the destination copy, across all 9 tables — envelope-
  // shaped (schema columns only, e.g. never carries adoptedIntoProjectId).
  // The store layer (src/store/projects.ts) walks this to enqueue each row
  // onto the optimistic-write queue (src/domain/mutationQueue.ts) — "push
  // through the sync/write-path" reusing 032's existing queue plumbing,
  // since no live client→server write flush exists yet in this repo
  // (HANDOFF: deferred until the queue actually flushes to /write).
  tables: EnvelopeTables
}

// Issue 037 (the local→cloud on-ramp, SPEC §1/§4) — moves a LOCAL project
// into a workspace by reusing 015's exact export/import machinery ON ITSELF:
// gather the source project's own rows, round-trip them through the same
// serialize → JSON → parse path the drag-drop export/import flow already
// exercises (so adoption is caught by parseEnvelope's referential-integrity
// and acyclic checks too, not a lighter parallel path), then let
// importProject's fresh-id remap + atomic transactional write land a
// brand-new copy in `targetWorkspaceId` — "reuse, don't rebuild" (design
// brief).
//
// Idempotent for sequential calls: a project whose `adoptedIntoProjectId` is
// already set short-circuits to the existing cloud copy instead of writing a
// second one — a repeated "Move to workspace…" gesture (e.g. a retried
// click after the first one already landed) is a no-op. The marker is
// stamped on the SOURCE row inside the SAME transaction that inserts the
// copy (importProject's `onInserted` hook above), so a failure anywhere in
// that transaction rolls back BOTH — the source is left exactly as it was,
// same as any other importProject failure (test-first plan #3: "a failure
// leaves the local project untouched"). Guarding true concurrent (in-flight
// overlapping) double-adoption is the caller's job — the store/UI disables
// the gesture while a call is outstanding; this function only guarantees
// that completed calls never compound.
export async function adoptProject(
  db: Database,
  sourceProjectId: string,
  targetWorkspaceId: string,
): Promise<AdoptResult> {
  const sourceRows = await db.select().from(projects).where(eq(projects.id, sourceProjectId))
  const source = sourceRows[0]
  if (!source) throw new ProjectNotFoundError()

  if (source.adoptedIntoProjectId !== null) {
    const existingTables = await gatherProjectRows(db, source.adoptedIntoProjectId)
    const existingRows = await db.select().from(projects).where(eq(projects.id, source.adoptedIntoProjectId))
    const existingProject = existingRows[0]
    if (!existingProject) throw new ProjectNotFoundError()
    return {
      project: existingProject,
      stats: envelopeStats(existingTables),
      alreadyAdopted: true,
      tables: existingTables,
    }
  }

  const envelope = parseEnvelope(envelopeToJson(serializeEnvelope(await gatherProjectRows(db, sourceProjectId))))

  const { project, stats } = await importProject(db, envelope, targetWorkspaceId, {
    async onInserted(tx, insertedProject) {
      await tx
        .update(projects)
        .set({ adoptedIntoProjectId: insertedProject.id, updatedAt: now() })
        .where(eq(projects.id, sourceProjectId))
    },
  })

  const tables = await gatherProjectRows(db, project.id)
  return { project, stats, alreadyAdopted: false, tables }
}
