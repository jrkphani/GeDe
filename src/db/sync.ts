import { eq, sql } from 'drizzle-orm'
import type { Database } from './client'
import * as schema from './schema'
import type { RowDelta, TableName } from '../domain/syncDelta'

// The read-path apply layer (issue 032): writes ElectricSQL row-deltas
// (already merged/ordered by src/domain/syncDelta.ts's pure engine, or applied
// delta-by-delta as they stream in — either is safe, see below) into local
// PGlite. This is the ONLY module that turns a RowDelta into a real SQL write;
// everything upstream (syncDelta.ts, mutationQueue.ts, electricProtocol.ts) is
// pure and PGlite-free.
//
// Idempotent + order-independent by construction, not by caller discipline:
// every upsert is guarded by `SET ... WHERE <table>.updated_at < <incoming
// updated_at>` (Postgres' native "do update only if it's actually newer"
// upsert idiom) — the exact same last-writer-wins rule syncDelta.ts's pure
// merge already proved order-independent (test-first plan #2), just
// re-expressed as a SQL WHERE guard instead of an in-memory reduce. Applying
// the same delta twice, or a stale delta after a newer one already landed, is
// therefore always a safe no-op.
//
// FK-cycle apply order (issue 032 scope: "verify the engine's apply order or
// replicate the NULL-then-UPDATE strategy" — 015's insert-order deadlock).
// Electric does not guarantee a child row arrives only after its
// not-yet-existing parent when two different shapes race, so every batch is
// applied inside ONE transaction using the same two-pass strategy
// src/db/projectIO.ts's importProject established for the identical FK
// cycles: every deferred self/cross-referential column
// (contexts.parentId, tier2_entries.parentId, parameters.parentParamId,
// dimensions.sourceParamId + dimensions.contextId) is forced NULL on the
// first pass, then restored to its real value on a second pass — but ONLY
// for rows the guard above actually applied (a row skipped as stale must not
// have its deferred column clobbered by an already-rejected update).
//
// Issue 077 — `dimensions` carries TWO independently-nullable forward FKs
// (sourceParamId, a same-table self-cycle for child-canvas dimensions; and
// contextId, a cross-table forward FK to `contexts` for a child-canvas
// dimension bound to a drill-down tuple). RETRY_APPLY_ORDER
// (syncEngine.ts:33) is a single static order that can't simultaneously put
// `dimensions` after both `parameters` (its self-cycle parent) and
// `contexts` (its contextId parent) when contexts itself comes later in that
// same list — so contextId needs the SAME null-then-restore treatment
// sourceParamId already gets, making convergence independent of apply order
// entirely. Each table entry is therefore a LIST of deferred columns, not a
// single column.
// Issue 090 — `canvases.parentContextId` is the ONLY new deferred column. It is
// the nullable half of the canvases↔contexts FK cycle (canvases.parent_context_id
// → contexts, and contexts.canvas_id / dimensions.canvas_id → canvases). The
// NOT-NULL half (canvas_id) is NOT deferrable — nulling then failing to restore
// would leave a permanent dangling FK (the hazard warned about below) — so it is
// satisfied by apply ORDER instead: `canvases` precedes `contexts`/`dimensions`
// in ENVELOPE_TABLE_NAMES → RETRY_APPLY_ORDER, so a canvas commits before any
// child that references it.
const DEFERRED_FK_COLUMN: Partial<Record<TableName, readonly string[]>> = {
  canvases: ['parentContextId'],
  contexts: ['parentId'],
  tier2_entries: ['parentId'],
  parameters: ['parentParamId'],
  dimensions: ['sourceParamId', 'contextId'],
}

function forceDeferredNull(delta: RowDelta): Record<string, unknown> {
  const columns = DEFERRED_FK_COLUMN[delta.table]
  if (!columns || columns.length === 0) return { ...delta.row }
  const row: Record<string, unknown> = { ...delta.row }
  for (const column of columns) row[column] = null
  return row
}

export async function applyInboundDeltas(db: Database, deltas: readonly RowDelta[]): Promise<void> {
  if (deltas.length === 0) return

  await db.transaction(async (tx) => {
    // Issue 072 (projects) / 079 (invitations, workspace_members) —
    // `workspaces` is NOT itself an Electric-synced table (src/domain/
    // syncScope.ts), so it's never guaranteed to already be present locally
    // when a row referencing it streams in — e.g. after 063's
    // clear-on-sign-out wipes local PGlite, or for a first-time
    // (never-been-a-member) invitee whose local DB has simply never heard of
    // the inviting workspace. `projects`, `invitations`, and
    // `workspace_members` are exactly the three synced tables whose
    // workspace_id FK points OUTWARD at `workspaces` (every other synced
    // table's own workspace_id FK is already satisfied by the time its row
    // can apply, since a child row's project_id FK requires that project —
    // and therefore this same ensure step — to have already run). Shared
    // here so all three self-heal identically: idempotently ensure the
    // parent exists first, INSIDE the same tx, mirroring createProject's
    // ensureWorkspaceRow's own ON CONFLICT DO NOTHING (src/db/
    // workspaces.ts:35). Guarded on workspaceId being present so a
    // genuinely local-only row with no workspace never forces a bogus
    // workspace row into existence.
    async function ensureWorkspaceStub(workspaceId: string | null | undefined): Promise<void> {
      if (!workspaceId) return
      await tx.insert(schema.workspaces).values({ id: workspaceId, name: 'Workspace' }).onConflictDoNothing()
    }

    // Returns whether the row was actually applied (fresh insert, or an
    // update the LWW guard allowed) — a row the guard rejected as stale must
    // be excluded from the second (deferred-FK) pass below.
    async function upsertGuarded(delta: RowDelta): Promise<boolean> {
      switch (delta.table) {
        case 'projects': {
          await ensureWorkspaceStub((delta.row as { workspaceId?: string | null }).workspaceId)
          const row = forceDeferredNull(delta) as typeof schema.projects.$inferInsert
          const applied = await tx
            .insert(schema.projects)
            .values(row)
            .onConflictDoUpdate({
              target: schema.projects.id,
              set: row,
              setWhere: sql`${schema.projects.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.projects.id })
          return applied.length > 0
        }
        // Issue 090 — canvases mirrors the dimensions/contexts pattern (NOT the
        // projects/invitations outward-workspace pattern): NO ensureWorkspaceStub
        // is needed, because canvases.project_id FKs `projects`, which guarantees
        // that project's own ensureWorkspaceStub already committed. Its deferred
        // `parentContextId` (nullable half of the canvases↔contexts cycle) is
        // forced null here and restored in the second pass below.
        case 'canvases': {
          const row = forceDeferredNull(delta) as typeof schema.canvases.$inferInsert
          const applied = await tx
            .insert(schema.canvases)
            .values(row)
            .onConflictDoUpdate({
              target: schema.canvases.id,
              set: row,
              setWhere: sql`${schema.canvases.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.canvases.id })
          return applied.length > 0
        }
        case 'tier1_purpose': {
          const row = forceDeferredNull(delta) as typeof schema.tier1Purpose.$inferInsert
          const applied = await tx
            .insert(schema.tier1Purpose)
            .values(row)
            .onConflictDoUpdate({
              target: schema.tier1Purpose.id,
              set: row,
              setWhere: sql`${schema.tier1Purpose.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.tier1Purpose.id })
          return applied.length > 0
        }
        case 'tier1_props': {
          const row = forceDeferredNull(delta) as typeof schema.tier1Props.$inferInsert
          const applied = await tx
            .insert(schema.tier1Props)
            .values(row)
            .onConflictDoUpdate({
              target: schema.tier1Props.id,
              set: row,
              setWhere: sql`${schema.tier1Props.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.tier1Props.id })
          return applied.length > 0
        }
        case 'tier2_tables': {
          const row = forceDeferredNull(delta) as typeof schema.tier2Tables.$inferInsert
          const applied = await tx
            .insert(schema.tier2Tables)
            .values(row)
            .onConflictDoUpdate({
              target: schema.tier2Tables.id,
              set: row,
              setWhere: sql`${schema.tier2Tables.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.tier2Tables.id })
          return applied.length > 0
        }
        case 'tier2_entries': {
          const row = forceDeferredNull(delta) as typeof schema.tier2Entries.$inferInsert
          const applied = await tx
            .insert(schema.tier2Entries)
            .values(row)
            .onConflictDoUpdate({
              target: schema.tier2Entries.id,
              set: row,
              setWhere: sql`${schema.tier2Entries.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.tier2Entries.id })
          return applied.length > 0
        }
        case 'dimensions': {
          const row = forceDeferredNull(delta) as typeof schema.dimensions.$inferInsert
          const applied = await tx
            .insert(schema.dimensions)
            .values(row)
            .onConflictDoUpdate({
              target: schema.dimensions.id,
              set: row,
              setWhere: sql`${schema.dimensions.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.dimensions.id })
          return applied.length > 0
        }
        case 'parameters': {
          const row = forceDeferredNull(delta) as typeof schema.parameters.$inferInsert
          const applied = await tx
            .insert(schema.parameters)
            .values(row)
            .onConflictDoUpdate({
              target: schema.parameters.id,
              set: row,
              setWhere: sql`${schema.parameters.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.parameters.id })
          return applied.length > 0
        }
        case 'contexts': {
          const row = forceDeferredNull(delta) as typeof schema.contexts.$inferInsert
          const applied = await tx
            .insert(schema.contexts)
            .values(row)
            .onConflictDoUpdate({
              target: schema.contexts.id,
              set: row,
              setWhere: sql`${schema.contexts.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.contexts.id })
          return applied.length > 0
        }
        case 'bindings': {
          const row = forceDeferredNull(delta) as typeof schema.bindings.$inferInsert
          const applied = await tx
            .insert(schema.bindings)
            .values(row)
            .onConflictDoUpdate({
              target: schema.bindings.id,
              set: row,
              setWhere: sql`${schema.bindings.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.bindings.id })
          return applied.length > 0
        }
        // Issue 056 (055's Cause 2 fix) — invitations/workspace_members join
        // the same guarded-upsert shape as every other table. Neither has a
        // self/cross-referential FK (both `workspaceId`s point OUTWARD at
        // `workspaces`, never inward — src/db/schema.ts:31-45,59-75), so
        // neither needs forceDeferredNull's two-pass strategy; `row` here is
        // the delta's row verbatim, mirroring every non-cyclic case above.
        // That outward workspace_id FK does need the ensureWorkspaceStub
        // self-heal above, though (issue 079) — see that comment.
        case 'invitations': {
          await ensureWorkspaceStub((delta.row as { workspaceId?: string | null }).workspaceId)
          const row = delta.row as typeof schema.invitations.$inferInsert
          const applied = await tx
            .insert(schema.invitations)
            .values(row)
            .onConflictDoUpdate({
              target: schema.invitations.id,
              set: row,
              setWhere: sql`${schema.invitations.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.invitations.id })
          return applied.length > 0
        }
        case 'workspace_members': {
          await ensureWorkspaceStub((delta.row as { workspaceId?: string | null }).workspaceId)
          const row = delta.row as typeof schema.workspaceMembers.$inferInsert
          const applied = await tx
            .insert(schema.workspaceMembers)
            .values(row)
            .onConflictDoUpdate({
              target: schema.workspaceMembers.id,
              set: row,
              setWhere: sql`${schema.workspaceMembers.updatedAt} < ${delta.updatedAt}`,
            })
            .returning({ id: schema.workspaceMembers.id })
          return applied.length > 0
        }
      }
    }

    async function restoreDeferredColumn(delta: RowDelta): Promise<void> {
      const columns = DEFERRED_FK_COLUMN[delta.table]
      if (!columns || columns.length === 0) return
      switch (delta.table) {
        case 'canvases':
          // Issue 090 — restore the deferred `parentContextId` now that the
          // referenced context (if any) has been applied earlier in this same
          // transaction; null on a root canvas restores cleanly to null.
          await tx
            .update(schema.canvases)
            .set({ parentContextId: delta.row.parentContextId as string | null })
            .where(eq(schema.canvases.id, delta.id))
          return
        case 'contexts':
          await tx
            .update(schema.contexts)
            .set({ parentId: delta.row.parentId as string | null })
            .where(eq(schema.contexts.id, delta.id))
          return
        case 'tier2_entries':
          await tx
            .update(schema.tier2Entries)
            .set({ parentId: delta.row.parentId as string | null })
            .where(eq(schema.tier2Entries.id, delta.id))
          return
        case 'parameters':
          await tx
            .update(schema.parameters)
            .set({ parentParamId: delta.row.parentParamId as string | null })
            .where(eq(schema.parameters.id, delta.id))
          return
        case 'dimensions':
          // Both deferred columns restore together, in one UPDATE — sourceParamId
          // (same-table self-cycle) and contextId (issue 077's cross-table
          // forward FK to `contexts`) are independent and each may legitimately
          // be null on the real row, so both are always set from the delta's
          // own values here rather than conditionally.
          await tx
            .update(schema.dimensions)
            .set({
              sourceParamId: delta.row.sourceParamId as string | null,
              contextId: delta.row.contextId as string | null,
            })
            .where(eq(schema.dimensions.id, delta.id))
          return
        default:
          return
      }
    }

    const applied: RowDelta[] = []
    for (const delta of deltas) {
      if (await upsertGuarded(delta)) applied.push(delta)
    }
    for (const delta of applied) {
      await restoreDeferredColumn(delta)
    }
  })
}
