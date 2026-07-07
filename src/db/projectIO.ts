import { eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { firstOrThrow } from './util'
import {
  bindings,
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
  type Envelope,
  type EnvelopeTables,
  type EnvelopeStats,
  envelopeStats,
  remapEnvelope,
} from '../domain/projectEnvelope'
import type { ProjectRow } from './mutations'
import { getOrCreateDefaultWorkspace } from './workspaces'

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

// Import ALWAYS creates a NEW project (fresh ids, every reference rewritten) and
// is ATOMIC: the whole write runs in one transaction, so a failure at any step
// (e.g. a unique-index violation a tampered file slipped past validation) rolls
// back the lot — nothing partial ever appears. See docs/issues/015 appendix.
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
export async function importProject(
  db: Database,
  envelope: Envelope,
  targetWorkspaceId?: string,
): Promise<ImportResult> {
  const workspaceId = targetWorkspaceId ?? (await getOrCreateDefaultWorkspace(db))
  const { tables } = remapEnvelope(envelope.tables, uuidv7, workspaceId)
  const stats = envelopeStats(tables)

  const project = await db.transaction(async (tx) => {
    const insertedProject = firstOrThrow(
      await tx.insert(projects).values(withWorkspace(tables.projects)).returning(),
    )

    // parent_id deferred (self-ref) — the whole tree exists before we wire it.
    if (tables.contexts.length) {
      await tx.insert(contexts).values(withWorkspace(tables.contexts).map((c) => ({ ...c, parentId: null })))
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
      await tx.insert(tier2Entries).values(tables.tier2_entries.map((e) => ({ ...e, parentId: null })))
    }

    // source_param_id deferred (dimensions ↔ parameters cross-cycle).
    if (tables.dimensions.length) {
      await tx
        .insert(dimensions)
        .values(withWorkspace(tables.dimensions).map((d) => ({ ...d, sourceParamId: null })))
    }

    // parent_param_id deferred (self-ref); dimension_id + source_entry_id resolve now.
    if (tables.parameters.length) {
      await tx.insert(parameters).values(tables.parameters.map((p) => ({ ...p, parentParamId: null })))
    }

    if (tables.bindings.length) await tx.insert(bindings).values(tables.bindings)

    // ── Second pass: wire the deferred self/cross references now every row exists.
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

    return insertedProject
  })

  return { project, stats }
}
