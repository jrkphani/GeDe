import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { firstOrThrow } from './util'
import { bindings, contexts, dimensions, parameters, projects } from './schema'
import { paletteColor } from '../theme/palette'
import { computeTupleHash, nextRootSymbol } from '../domain/symbols'

// The mutation layer: every database write in the app flows through this module
// (SPEC §3 sync-readiness — row-granular mutations through a single seam).
// Components never import from src/db; they act through the store, which calls
// these functions. Enforced by the no-restricted-imports lint boundary.

export type ProjectRow = typeof projects.$inferSelect

function now(): string {
  return new Date().toISOString()
}

export async function createProject(
  db: Database,
  input: { name: string; description?: string | null },
): Promise<ProjectRow> {
  const rows = await db
    .insert(projects)
    .values({ id: uuidv7(), name: input.name, description: input.description ?? null })
    .returning()
  return firstOrThrow(rows)
}

export async function renameProject(db: Database, id: string, name: string): Promise<ProjectRow> {
  const rows = await db
    .update(projects)
    .set({ name, updatedAt: now() })
    .where(eq(projects.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function archiveProject(db: Database, id: string): Promise<ProjectRow> {
  const rows = await db
    .update(projects)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(projects.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function restoreProject(db: Database, id: string): Promise<ProjectRow> {
  const rows = await db
    .update(projects)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(projects.id, id))
    .returning()
  return firstOrThrow(rows)
}

// Soft-deleted rows never leave this module (issue 001 acceptance criterion).
export async function listProjects(db: Database): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(isNull(projects.deletedAt))
    .orderBy(desc(projects.updatedAt), asc(projects.name))
}

// ── Dimensions (issue 002) ────────────────────────────────────────────────────
// contextId scoping (child canvases) arrives with issue 011; everything below
// operates on the root canvas (context_id IS NULL).

export type DimensionRow = typeof dimensions.$inferSelect

// SPEC §1: a canvas needs at least 2 dimensions. Removal at the floor is a
// typed rejection so the UI disable and the store share one source of truth.
export class DimensionFloorError extends Error {
  constructor() {
    super('A canvas needs at least 2 dimensions')
    this.name = 'DimensionFloorError'
  }
}

function rootScope(projectId: string) {
  return and(
    eq(dimensions.projectId, projectId),
    isNull(dimensions.contextId),
    isNull(dimensions.deletedAt),
  )
}

export async function listDimensions(db: Database, projectId: string): Promise<DimensionRow[]> {
  return db.select().from(dimensions).where(rootScope(projectId)).orderBy(asc(dimensions.sort))
}

export async function addDimension(db: Database, projectId: string): Promise<DimensionRow> {
  const existing = await listDimensions(db, projectId)
  // Default name continues past the highest default-numbered live row so a
  // middle removal never produces a duplicate (never "Untitled").
  const maxDefault = existing.reduce((max, d) => {
    const m = /^Dimension (\d+)$/.exec(d.name)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0)
  const rows = await db
    .insert(dimensions)
    .values({
      id: uuidv7(),
      projectId,
      name: `Dimension ${Math.max(maxDefault, existing.length) + 1}`,
      color: paletteColor(existing.length),
      sort: existing.length,
    })
    .returning()
  return firstOrThrow(rows)
}

export async function renameDimension(
  db: Database,
  id: string,
  name: string,
): Promise<DimensionRow> {
  const rows = await db
    .update(dimensions)
    .set({ name, updatedAt: now() })
    .where(eq(dimensions.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function setDimensionColor(
  db: Database,
  id: string,
  color: string,
): Promise<DimensionRow> {
  const rows = await db
    .update(dimensions)
    .set({ color, updatedAt: now() })
    .where(eq(dimensions.id, id))
    .returning()
  return firstOrThrow(rows)
}

async function rewriteSort(db: Database, ordered: DimensionRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort !== index) {
      await db
        .update(dimensions)
        .set({ sort: index, updatedAt: now() })
        .where(eq(dimensions.id, row.id))
    }
  }
}

// One gesture = one call = one future undo step (command log lands in 006).
export async function reorderDimension(
  db: Database,
  projectId: string,
  id: string,
  toIndex: number,
): Promise<DimensionRow[]> {
  const rows = await listDimensions(db, projectId)
  const from = rows.findIndex((d) => d.id === id)
  if (from === -1) return rows
  const target = Math.max(0, Math.min(rows.length - 1, toIndex))
  const moved = firstOrThrow(rows.splice(from, 1))
  rows.splice(target, 0, moved)
  await rewriteSort(db, rows)
  return listDimensions(db, projectId)
}

// The floor is a *user-facing* guard (SPEC §1): you can't manually remove
// below n = 2. It must NOT apply when the command log (issue 006) undoes an
// add() — that can legitimately take the count back through 1 or 0, the same
// below-floor guided-start states issue 002 already allows before the first
// crossing. removeDimensionUnchecked is that mechanical-replay primitive.
async function removeDimensionUnchecked(
  db: Database,
  projectId: string,
  id: string,
): Promise<DimensionRow[]> {
  const rows = await listDimensions(db, projectId)
  await db
    .update(dimensions)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(dimensions.id, id))
  await rewriteSort(
    db,
    rows.filter((d) => d.id !== id),
  )
  return listDimensions(db, projectId)
}

export async function removeDimension(
  db: Database,
  projectId: string,
  id: string,
): Promise<DimensionRow[]> {
  const rows = await listDimensions(db, projectId)
  if (rows.length <= 2) throw new DimensionFloorError()
  return removeDimensionUnchecked(db, projectId, id)
}

// Exported specifically for the command log's undo-of-add (issue 006) — see
// removeDimensionUnchecked above for why the floor check must not apply here.
export { removeDimensionUnchecked as undoAddDimension }

// The undo-of-remove / redo-of-add primitive (issue 006): un-soft-deletes the
// row AND rewrites every live row's sort to match `orderedIds` verbatim, so a
// middle removal's undo restores the exact original position instead of
// appending at the end. `orderedIds` is the full live order captured by the
// caller (store) right before the mutation being undone/redone.
export async function restoreDimension(
  db: Database,
  projectId: string,
  id: string,
  orderedIds: readonly string[],
): Promise<DimensionRow[]> {
  await db
    .update(dimensions)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(dimensions.id, id))
  const rows = await listDimensions(db, projectId)
  const byId = new Map(rows.map((d) => [d.id, d]))
  const ordered = orderedIds
    .map((oid) => byId.get(oid))
    .filter((d): d is DimensionRow => d !== undefined)
  await rewriteSort(db, ordered)
  return listDimensions(db, projectId)
}

// ── Parameters (issue 003) ────────────────────────────────────────────────────
// m (parameter count) is unbounded and independent per dimension — no floor,
// unlike dimensions' n = 2. parentParamId is accepted now but has no UI until
// sub-parameters arrive (issue 011).

export type ParameterRow = typeof parameters.$inferSelect

function parameterScope(dimensionId: string) {
  return and(eq(parameters.dimensionId, dimensionId), isNull(parameters.deletedAt))
}

export async function listParameters(db: Database, dimensionId: string): Promise<ParameterRow[]> {
  return db.select().from(parameters).where(parameterScope(dimensionId)).orderBy(asc(parameters.sort))
}

export async function addParameter(
  db: Database,
  dimensionId: string,
  name: string,
  parentParamId: string | null = null,
): Promise<ParameterRow> {
  const existing = await listParameters(db, dimensionId)
  const rows = await db
    .insert(parameters)
    .values({
      id: uuidv7(),
      dimensionId,
      parentParamId,
      name,
      sort: existing.length,
    })
    .returning()
  return firstOrThrow(rows)
}

export async function renameParameter(
  db: Database,
  id: string,
  name: string,
): Promise<ParameterRow> {
  const rows = await db
    .update(parameters)
    .set({ name, updatedAt: now() })
    .where(eq(parameters.id, id))
    .returning()
  return firstOrThrow(rows)
}

async function rewriteParameterSort(db: Database, ordered: ParameterRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort !== index) {
      await db
        .update(parameters)
        .set({ sort: index, updatedAt: now() })
        .where(eq(parameters.id, row.id))
    }
  }
}

// One gesture = one call = one future undo step (command log lands in 006).
export async function reorderParameter(
  db: Database,
  dimensionId: string,
  id: string,
  toIndex: number,
): Promise<ParameterRow[]> {
  const rows = await listParameters(db, dimensionId)
  const from = rows.findIndex((p) => p.id === id)
  if (from === -1) return rows
  const target = Math.max(0, Math.min(rows.length - 1, toIndex))
  const moved = firstOrThrow(rows.splice(from, 1))
  rows.splice(target, 0, moved)
  await rewriteParameterSort(db, rows)
  return listParameters(db, dimensionId)
}

export async function removeParameter(
  db: Database,
  dimensionId: string,
  id: string,
): Promise<ParameterRow[]> {
  const rows = await listParameters(db, dimensionId)
  await db
    .update(parameters)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(parameters.id, id))
  await rewriteParameterSort(
    db,
    rows.filter((p) => p.id !== id),
  )
  return listParameters(db, dimensionId)
}

// Mirrors restoreDimension (issue 006) — the undo-of-remove / redo-of-add
// primitive for parameters.
export async function restoreParameter(
  db: Database,
  dimensionId: string,
  id: string,
  orderedIds: readonly string[],
): Promise<ParameterRow[]> {
  await db
    .update(parameters)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(parameters.id, id))
  const rows = await listParameters(db, dimensionId)
  const byId = new Map(rows.map((p) => [p.id, p]))
  const ordered = orderedIds
    .map((oid) => byId.get(oid))
    .filter((p): p is ParameterRow => p !== undefined)
  await rewriteParameterSort(db, ordered)
  return listParameters(db, dimensionId)
}

// ── Contexts & bindings (issue 004) ──────────────────────────────────────────
// Root canvas only (parentId null) — recursion into child canvases is issue 011.

export type ContextRow = typeof contexts.$inferSelect
export type BindingRow = typeof bindings.$inferSelect

// SPEC §3: symbols are unique per canvas. Root contexts share the project's
// root canvas namespace.
export class ContextSymbolCollisionError extends Error {
  constructor(symbol: string) {
    super(`"${symbol}" is already in use on this canvas`)
    this.name = 'ContextSymbolCollisionError'
  }
}

function rootContextScope(projectId: string) {
  return and(
    eq(contexts.projectId, projectId),
    isNull(contexts.parentId),
    isNull(contexts.deletedAt),
  )
}

export async function listContexts(db: Database, projectId: string): Promise<ContextRow[]> {
  return db.select().from(contexts).where(rootContextScope(projectId)).orderBy(asc(contexts.sort))
}

export async function createContext(db: Database, projectId: string): Promise<ContextRow> {
  const existing = await listContexts(db, projectId)
  const symbol = nextRootSymbol(new Set(existing.map((c) => c.symbol)))
  const rows = await db
    .insert(contexts)
    .values({
      id: uuidv7(),
      projectId,
      parentId: null,
      symbol,
      sort: existing.length,
    })
    .returning()
  return firstOrThrow(rows)
}

export async function setContextSymbol(
  db: Database,
  projectId: string,
  id: string,
  symbol: string,
): Promise<ContextRow> {
  const existing = await listContexts(db, projectId)
  if (existing.some((c) => c.id !== id && c.symbol === symbol)) {
    throw new ContextSymbolCollisionError(symbol)
  }
  const rows = await db
    .update(contexts)
    .set({ symbol, updatedAt: now() })
    .where(eq(contexts.id, id))
    .returning()
  return firstOrThrow(rows)
}

// Contexts have no user-facing delete yet — this pair exists solely as the
// undo-of-create / redo-of-archive primitive (issue 006). create() always
// appends at the tail, so unlike dimensions/parameters no sort-rewrite is
// needed: archiving the just-created row never leaves a gap for a sibling to
// fill, and restoring re-takes the same (still-highest) sort slot.
export async function archiveContext(db: Database, id: string): Promise<ContextRow> {
  const rows = await db
    .update(contexts)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(contexts.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function restoreContext(db: Database, id: string): Promise<ContextRow> {
  const rows = await db
    .update(contexts)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(contexts.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function setContextJustification(
  db: Database,
  id: string,
  justification: string,
): Promise<ContextRow> {
  const rows = await db
    .update(contexts)
    .set({ justification, updatedAt: now() })
    .where(eq(contexts.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function listBindings(db: Database, contextId: string): Promise<BindingRow[]> {
  return db.select().from(bindings).where(eq(bindings.contextId, contextId))
}

// All of a context's binding rows share one tuple_hash, kept in dimension-sort
// order — a single indexed scan then finds duplicate-tuple contexts (issue 005+).
async function recomputeTupleHash(db: Database, contextId: string): Promise<void> {
  const contextRows = await db.select().from(contexts).where(eq(contexts.id, contextId))
  const contextRow = firstOrThrow(contextRows)
  const dims = await listDimensions(db, contextRow.projectId)
  const rows = await listBindings(db, contextId)
  const byDimension = new Map(rows.map((r) => [r.dimensionId, r.parameterId]))
  const ordered = dims.filter((d) => byDimension.has(d.id)).map((d) => byDimension.get(d.id) as string)
  const hash = computeTupleHash(ordered)
  for (const row of rows) {
    if (row.tupleHash !== hash) {
      await db.update(bindings).set({ tupleHash: hash, updatedAt: now() }).where(eq(bindings.id, row.id))
    }
  }
}

// Re-binding a dimension is an upsert (scope: bindings are current-state
// pointers, not history — see schema.ts).
export async function bindParameter(
  db: Database,
  contextId: string,
  dimensionId: string,
  parameterId: string,
): Promise<BindingRow[]> {
  await db
    .insert(bindings)
    .values({ id: uuidv7(), contextId, dimensionId, parameterId, tupleHash: '' })
    .onConflictDoUpdate({
      target: [bindings.contextId, bindings.dimensionId],
      set: { parameterId, updatedAt: now() },
    })
  await recomputeTupleHash(db, contextId)
  return listBindings(db, contextId)
}

export async function unbindParameter(
  db: Database,
  contextId: string,
  dimensionId: string,
): Promise<BindingRow[]> {
  await db
    .delete(bindings)
    .where(and(eq(bindings.contextId, contextId), eq(bindings.dimensionId, dimensionId)))
  await recomputeTupleHash(db, contextId)
  return listBindings(db, contextId)
}
