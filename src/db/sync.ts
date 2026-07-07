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
// cycles: the deferred self/cross-referential column
// (contexts.parentId, tier2_entries.parentId, parameters.parentParamId,
// dimensions.sourceParamId) is forced NULL on the first pass, then restored
// to its real value on a second pass — but ONLY for rows the guard above
// actually applied (a row skipped as stale must not have its deferred column
// clobbered by an already-rejected update).
const DEFERRED_FK_COLUMN: Partial<Record<TableName, string>> = {
  contexts: 'parentId',
  tier2_entries: 'parentId',
  parameters: 'parentParamId',
  dimensions: 'sourceParamId',
}

function forceDeferredNull(delta: RowDelta): Record<string, unknown> {
  const column = DEFERRED_FK_COLUMN[delta.table]
  if (!column) return { ...delta.row }
  return { ...delta.row, [column]: null }
}

export async function applyInboundDeltas(db: Database, deltas: readonly RowDelta[]): Promise<void> {
  if (deltas.length === 0) return

  await db.transaction(async (tx) => {
    // Returns whether the row was actually applied (fresh insert, or an
    // update the LWW guard allowed) — a row the guard rejected as stale must
    // be excluded from the second (deferred-FK) pass below.
    async function upsertGuarded(delta: RowDelta): Promise<boolean> {
      switch (delta.table) {
        case 'projects': {
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
      }
    }

    async function restoreDeferredColumn(delta: RowDelta): Promise<void> {
      const column = DEFERRED_FK_COLUMN[delta.table]
      if (!column) return
      const value = delta.row[column]
      switch (delta.table) {
        case 'contexts':
          await tx
            .update(schema.contexts)
            .set({ parentId: value as string | null })
            .where(eq(schema.contexts.id, delta.id))
          return
        case 'tier2_entries':
          await tx
            .update(schema.tier2Entries)
            .set({ parentId: value as string | null })
            .where(eq(schema.tier2Entries.id, delta.id))
          return
        case 'parameters':
          await tx
            .update(schema.parameters)
            .set({ parentParamId: value as string | null })
            .where(eq(schema.parameters.id, delta.id))
          return
        case 'dimensions':
          await tx
            .update(schema.dimensions)
            .set({ sourceParamId: value as string | null })
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
