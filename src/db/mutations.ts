import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { firstOrThrow } from './util'
import { bindings, contexts, dimensions, parameters, projects, tier1Props, tier1Purpose } from './schema'
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

export interface DimensionRemoveResult {
  dimensions: DimensionRow[]
  deletedBindings: BindingRow[]
}

// SPEC invariant 4 (issue 007) — bindings have no deletedAt (schema.ts), so a
// dimension removal hard-deletes every binding pointing at it and recomputes
// the remaining tuple hash for each context that had one, keeping the
// duplicate-tuple index (issue 005) correct with the shrunk dimension set.
// Returns the deleted rows verbatim so the caller can restore them exactly on
// undo (restoreDimension below).
async function cascadeDeleteBindingsForDimension(
  db: Database,
  dimensionId: string,
): Promise<BindingRow[]> {
  const rows = await db.select().from(bindings).where(eq(bindings.dimensionId, dimensionId))
  if (rows.length === 0) return rows
  await db.delete(bindings).where(eq(bindings.dimensionId, dimensionId))
  const contextIds = [...new Set(rows.map((r) => r.contextId))]
  for (const contextId of contextIds) await recomputeTupleHash(db, contextId)
  return rows
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
): Promise<DimensionRemoveResult> {
  const rows = await listDimensions(db, projectId)
  const deletedBindings = await cascadeDeleteBindingsForDimension(db, id)
  await db
    .update(dimensions)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(dimensions.id, id))
  await rewriteSort(
    db,
    rows.filter((d) => d.id !== id),
  )
  return { dimensions: await listDimensions(db, projectId), deletedBindings }
}

export async function removeDimension(
  db: Database,
  projectId: string,
  id: string,
): Promise<DimensionRemoveResult> {
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
// `bindingsToRestore` (issue 007) reinserts the exact rows a cascade delete
// removed and recomputes their contexts' tuple hashes back to the original.
export async function restoreDimension(
  db: Database,
  projectId: string,
  id: string,
  orderedIds: readonly string[],
  bindingsToRestore: readonly BindingRow[] = [],
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
  if (bindingsToRestore.length > 0) {
    await db.insert(bindings).values(
      bindingsToRestore.map((row) => ({
        id: row.id,
        contextId: row.contextId,
        dimensionId: row.dimensionId,
        parameterId: row.parameterId,
        tupleHash: row.tupleHash,
      })),
    )
    const contextIds = [...new Set(bindingsToRestore.map((r) => r.contextId))]
    for (const contextId of contextIds) await recomputeTupleHash(db, contextId)
  }
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

// ── Tier 1 Foundation (issue 013) ────────────────────────────────────────────
// The most document-like tier: one purpose statement per project + a table of
// ranked value propositions. No linkage to tiers 2–3 in this slice.

export type Tier1PurposeRow = typeof tier1Purpose.$inferSelect
export type Tier1PropRow = typeof tier1Props.$inferSelect

// SPEC §4.6 — a single body per project (the schema's unique project_id index
// makes the setter a true upsert, never a second purpose row).
export async function getTier1Purpose(
  db: Database,
  projectId: string,
): Promise<Tier1PurposeRow | null> {
  const rows = await db
    .select()
    .from(tier1Purpose)
    .where(and(eq(tier1Purpose.projectId, projectId), isNull(tier1Purpose.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

export async function setTier1Purpose(
  db: Database,
  projectId: string,
  body: string,
): Promise<Tier1PurposeRow | null> {
  await db
    .insert(tier1Purpose)
    .values({ id: uuidv7(), projectId, body })
    .onConflictDoUpdate({ target: tier1Purpose.projectId, set: { body, updatedAt: now() } })
  return getTier1Purpose(db, projectId)
}

function tier1PropScope(projectId: string) {
  return and(eq(tier1Props.projectId, projectId), isNull(tier1Props.deletedAt))
}

export async function listTier1Props(db: Database, projectId: string): Promise<Tier1PropRow[]> {
  return db.select().from(tier1Props).where(tier1PropScope(projectId)).orderBy(asc(tier1Props.sort))
}

// rank (1-based, degree notation) and sort (0-based order) move in lockstep in
// this tier — rewritten to their positional index on every add/reorder/remove
// so both stay contiguous (issue 013 unit test).
async function rewriteTier1PropRanks(db: Database, ordered: Tier1PropRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort !== index || row.rank !== index + 1) {
      await db
        .update(tier1Props)
        .set({ sort: index, rank: index + 1, updatedAt: now() })
        .where(eq(tier1Props.id, row.id))
    }
  }
}

export async function addTier1Prop(
  db: Database,
  projectId: string,
  name: string,
): Promise<Tier1PropRow> {
  const existing = await listTier1Props(db, projectId)
  const rows = await db
    .insert(tier1Props)
    .values({
      id: uuidv7(),
      projectId,
      name,
      description: null,
      rank: existing.length + 1,
      sort: existing.length,
    })
    .returning()
  return firstOrThrow(rows)
}

export async function renameTier1Prop(
  db: Database,
  id: string,
  name: string,
): Promise<Tier1PropRow> {
  const rows = await db
    .update(tier1Props)
    .set({ name, updatedAt: now() })
    .where(eq(tier1Props.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function setTier1PropDescription(
  db: Database,
  id: string,
  description: string,
): Promise<Tier1PropRow> {
  const rows = await db
    .update(tier1Props)
    .set({ description, updatedAt: now() })
    .where(eq(tier1Props.id, id))
    .returning()
  return firstOrThrow(rows)
}

// One drag gesture = one call = one future undo step (command log, issue 006).
export async function reorderTier1Prop(
  db: Database,
  projectId: string,
  id: string,
  toIndex: number,
): Promise<Tier1PropRow[]> {
  const rows = await listTier1Props(db, projectId)
  const from = rows.findIndex((p) => p.id === id)
  if (from === -1) return rows
  const target = Math.max(0, Math.min(rows.length - 1, toIndex))
  const moved = firstOrThrow(rows.splice(from, 1))
  rows.splice(target, 0, moved)
  await rewriteTier1PropRanks(db, rows)
  return listTier1Props(db, projectId)
}

export async function removeTier1Prop(
  db: Database,
  projectId: string,
  id: string,
): Promise<Tier1PropRow[]> {
  const rows = await listTier1Props(db, projectId)
  await db
    .update(tier1Props)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(tier1Props.id, id))
  await rewriteTier1PropRanks(
    db,
    rows.filter((p) => p.id !== id),
  )
  return listTier1Props(db, projectId)
}

// Mirrors restoreParameter (issue 006) — the undo-of-remove / redo-of-add
// primitive: un-soft-deletes the row and rewrites every live row's rank/sort
// to match `orderedIds` verbatim, so a middle removal's undo restores the
// exact original position instead of appending at the end.
export async function restoreTier1Prop(
  db: Database,
  projectId: string,
  id: string,
  orderedIds: readonly string[],
): Promise<Tier1PropRow[]> {
  await db
    .update(tier1Props)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(tier1Props.id, id))
  const rows = await listTier1Props(db, projectId)
  const byId = new Map(rows.map((p) => [p.id, p]))
  const ordered = orderedIds
    .map((oid) => byId.get(oid))
    .filter((p): p is Tier1PropRow => p !== undefined)
  await rewriteTier1PropRanks(db, ordered)
  return listTier1Props(db, projectId)
}
