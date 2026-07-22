import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database, Querier } from './client'
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
import { getOrCreateDefaultWorkspace } from './workspaces'
import { paletteColor } from '../theme/palette'
import { computeTupleHash, nextChildSymbol, nextRootSymbol } from '../domain/symbols'
import { violatesDimensionFloor } from '../domain/writeInvariants'

// The mutation layer: every database write in the app flows through this module
// (SPEC §3 sync-readiness — row-granular mutations through a single seam).
// Components never import from src/db; they act through the store, which calls
// these functions. Enforced by the no-restricted-imports lint boundary.

export type ProjectRow = typeof projects.$inferSelect

function now(): string {
  return new Date().toISOString()
}

// Issue 034 — every project-scoped tenant table (tier1_purpose, tier1_props,
// tier2_tables, dimensions, contexts) denormalizes its owning project's
// workspace_id (migration 0008's RLS reads it directly, no join). Every
// insert function below resolves it from the project row rather than asking
// every store/component call site to thread it through — those call sites
// are unchanged by this issue (design brief: "local stays simple").
async function projectWorkspaceId(db: Database, projectId: string): Promise<string> {
  const rows = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
  return firstOrThrow(rows, 'project not found').workspaceId
}

// Issue 078 step 2 (migration 0015) — parameters/bindings/tier2_entries
// gained their own denormalized workspace_id column so Electric's read-path
// shape can scope them directly (src/domain/syncScope.ts), dropping the
// experimental allow_subqueries opt-in their old FK-chain-only scoping
// required. Every insert into these three tables must resolve and stamp a
// real workspaceId from the nearest workspace_id-bearing ancestor — these
// three helpers mirror projectWorkspaceId's own shape, one FK hop closer.
async function dimensionWorkspaceId(db: Database, dimensionId: string): Promise<string> {
  const rows = await db
    .select({ workspaceId: dimensions.workspaceId })
    .from(dimensions)
    .where(eq(dimensions.id, dimensionId))
  return firstOrThrow(rows, 'dimension not found').workspaceId
}

async function contextWorkspaceId(db: Querier, contextId: string): Promise<string> {
  const rows = await db
    .select({ workspaceId: contexts.workspaceId })
    .from(contexts)
    .where(eq(contexts.id, contextId))
  return firstOrThrow(rows, 'context not found').workspaceId
}

async function tier2TableWorkspaceId(db: Database, tableId: string): Promise<string> {
  const rows = await db
    .select({ workspaceId: tier2Tables.workspaceId })
    .from(tier2Tables)
    .where(eq(tier2Tables.id, tableId))
  return firstOrThrow(rows, 'tier2 table not found').workspaceId
}

export async function createProject(
  db: Database,
  input: { name: string; description?: string | null; workspaceId?: string },
): Promise<ProjectRow> {
  // The workspace resolve/seed is the one pre-write dependency and opens no
  // transaction — hoist it OUT so the tx wraps ONLY the two inserts (the store
  // already ensures the workspace row separately via ensureWorkspaceRow).
  const workspaceId = input.workspaceId ?? (await getOrCreateDefaultWorkspace(db))
  // 107 P5 — the project INSERT and its root-canvas seed INSERT commit as one
  // unit: a mid-sequence failure must not leave a project row with no root
  // canvas (every "the root canvas" write path — addDimension, root
  // createContext — assumes createProject seeded exactly one).
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(projects)
      .values({ id: uuidv7(), workspaceId, name: input.name, description: input.description ?? null })
      .returning()
    const project = firstOrThrow(rows)
    // Issue 090 Correction 1 — seed the project's root canvas in the same call
    // (creation seeded nothing before; a canvas is now a real row). The same
    // path covers local + cloud, enqueued like any other create (Open Question 6).
    await tx.insert(canvases).values({
      id: uuidv7(),
      projectId: project.id,
      workspaceId,
      parentContextId: null,
      name: 'Canvas 1',
      sort: 0,
    })
    return project
  })
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

// Issue 070 (fixes #9) — the counterpart read path to listProjects: archiving
// is a durable soft-delete (deleted_at, never a hard delete), but nothing
// ever surfaced the archived side of it. Ordered most-recently-archived
// first so a restore view reads like an undo stack even though it's a real,
// durable list independent of the session-scoped command log.
export async function listArchivedProjects(db: Database): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(isNotNull(projects.deletedAt))
    .orderBy(desc(projects.deletedAt), asc(projects.name))
}

// ── Canvases (issue 090) ──────────────────────────────────────────────────────
// A canvas is now a first-class row (was an implicit `(project_id, context_id)`
// composite key). parent_context_id NULL = a root canvas (many per project);
// set = the child canvas of that context (issue 011, one per context). The
// read/filter path (canvasScope/contextCanvasScope) still keys on
// context_id/parent_id in this phase — these functions only ADD canvas CRUD and
// STAMP canvas_id on writes; the read path is repointed in a later phase.

export type CanvasRow = typeof canvases.$inferSelect

// Mirrors projectWorkspaceId one FK hop closer — resolves a canvas's workspace
// from its own row (for canvas-scoped writes that only carry a canvasId).
export async function canvasWorkspaceId(db: Database, canvasId: string): Promise<string> {
  const rows = await db
    .select({ workspaceId: canvases.workspaceId })
    .from(canvases)
    .where(eq(canvases.id, canvasId))
  return firstOrThrow(rows, 'canvas not found').workspaceId
}

// The project's default (first live) root canvas. Every pre-090 write path that
// operated on "the root canvas" (addDimension, createContext for root contexts)
// stamps this. A project always has at least one — createProject seeds it.
async function rootCanvasIdOrNull(db: Querier, projectId: string): Promise<string | null> {
  const rows = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.projectId, projectId), isNull(canvases.parentContextId), isNull(canvases.deletedAt)))
    .orderBy(asc(canvases.sort), asc(canvases.createdAt))
  return rows[0]?.id ?? null
}

async function rootCanvasId(db: Database, projectId: string): Promise<string> {
  const id = await rootCanvasIdOrNull(db, projectId)
  if (id === null) throw new Error('root canvas not found')
  return id
}

// The live child canvas of a context, WITHOUT creating one (unlike
// childCanvasId). The read path uses this so a read never has the side effect
// of materializing a canvas; returns null when the context has no child canvas
// yet (e.g. never drilled, or the context row hasn't synced).
async function liveChildCanvasIdOrNull(db: Database, parentContextId: string): Promise<string | null> {
  const rows = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.parentContextId, parentContextId), isNull(canvases.deletedAt)))
  return rows[0]?.id ?? null
}

// The child canvas of a context, created on first drill-in (issue 011). Idempotent:
// returns the existing live child canvas if present, else inserts one. The
// partial unique index guarantees at most one live child canvas per context.
async function childCanvasId(db: Querier, parentContextId: string): Promise<string> {
  const existing = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.parentContextId, parentContextId), isNull(canvases.deletedAt)))
  const found = existing[0]
  if (found) return found.id
  const parent = firstOrThrow(
    await db.select().from(contexts).where(eq(contexts.id, parentContextId)),
    'parent context not found',
  )
  const rows = await db
    .insert(canvases)
    .values({
      id: uuidv7(),
      projectId: parent.projectId,
      workspaceId: parent.workspaceId,
      parentContextId,
      // name NULL ⇒ derive from the context symbol at render (Open Question 1).
      name: null,
      sort: 0,
    })
    .returning({ id: canvases.id })
  return firstOrThrow(rows).id
}

// A new root canvas in a project's Design lane (issue 090 switcher). Appends at
// the tail of the live root canvases by sort.
export async function createCanvas(
  db: Database,
  projectId: string,
  name?: string | null,
): Promise<CanvasRow> {
  const workspaceId = await projectWorkspaceId(db, projectId)
  const existing = await listCanvases(db, projectId)
  const rows = await db
    .insert(canvases)
    .values({
      id: uuidv7(),
      projectId,
      workspaceId,
      parentContextId: null,
      name: name?.trim() ? name.trim() : null,
      sort: existing.length,
    })
    .returning()
  return firstOrThrow(rows)
}

export async function archiveCanvas(db: Database, id: string): Promise<CanvasRow> {
  const rows = await db
    .update(canvases)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(canvases.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function restoreCanvas(db: Database, id: string): Promise<CanvasRow> {
  const rows = await db
    .update(canvases)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(canvases.id, id))
    .returning()
  return firstOrThrow(rows)
}

// Live ROOT canvases of a project, in lane order. Child canvases are entered by
// drilling into a context (011), not listed here.
export async function listCanvases(db: Querier, projectId: string): Promise<CanvasRow[]> {
  return db
    .select()
    .from(canvases)
    .where(and(eq(canvases.projectId, projectId), isNull(canvases.parentContextId), isNull(canvases.deletedAt)))
    .orderBy(asc(canvases.sort), asc(canvases.createdAt))
}

// Rename a root canvas (issue 090 switcher). Empty/whitespace name ⇒ NULL, so
// the render layer falls back to deriving a label (mirrors createCanvas).
export async function renameCanvas(db: Database, id: string, name: string): Promise<CanvasRow> {
  const trimmed = name.trim()
  const rows = await db
    .update(canvases)
    .set({ name: trimmed === '' ? null : trimmed, updatedAt: now() })
    .where(eq(canvases.id, id))
    .returning()
  return firstOrThrow(rows)
}

// Rewrites `sort` on every root canvas whose ordinal actually moved (mirrors
// the dimensions `rewriteSort` cascade — only touches rows that changed).
async function rewriteCanvasSort(db: Querier, ordered: CanvasRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort !== index) {
      await db.update(canvases).set({ sort: index, updatedAt: now() }).where(eq(canvases.id, row.id))
    }
  }
}

// Move a root canvas to `toIndex` within its project's Design lane (mirrors
// reorderDimension). Returns the full re-sorted list so the store can diff it.
export async function reorderCanvas(
  db: Database,
  projectId: string,
  id: string,
  toIndex: number,
): Promise<CanvasRow[]> {
  const rows = await listCanvases(db, projectId)
  if (rows.findIndex((c) => c.id === id) === -1) return rows
  // 107 P3 — every `sort` rewrite in the densify loop commits as one unit: a
  // mid-loop failure must not leave the lane half-re-sorted. The ordering read
  // runs on `tx` so it sees a consistent snapshot; the authoritative final read
  // runs on `db` after commit.
  await db.transaction(async (tx) => {
    const current = await listCanvases(tx, projectId)
    const from = current.findIndex((c) => c.id === id)
    if (from === -1) return
    const target = Math.max(0, Math.min(current.length - 1, toIndex))
    const moved = firstOrThrow(current.splice(from, 1))
    current.splice(target, 0, moved)
    await rewriteCanvasSort(tx, current)
  })
  return listCanvases(db, projectId)
}

// Issue 090 Phase 4a — resolve a legacy CONTEXT selector (the pre-090
// navigation key the store still carries: null = the project's default root
// canvas; a context id = that context's child canvas) into the concrete
// canvas id the read path now keys on. This is the seam the store layer reads
// through until Phase 4b threads a real canvas id through the URL/switcher.
// READ-only: never creates a canvas, and returns null when none exists yet
// (root canvas or the child canvas hasn't synced), so a store read before the
// canvas lands yields [] exactly as the pre-090 `IS NULL` predicate did.
export async function resolveReadCanvasId(
  db: Database,
  projectId: string,
  contextId: string | null | undefined,
): Promise<string | null> {
  if (contextId === null || contextId === undefined) return rootCanvasIdOrNull(db, projectId)
  return liveChildCanvasIdOrNull(db, contextId)
}

// A single live canvas by id (root or child), or null if absent/tombstoned.
export async function getCanvas(db: Database, id: string): Promise<CanvasRow | null> {
  const rows = await db
    .select()
    .from(canvases)
    .where(and(eq(canvases.id, id), isNull(canvases.deletedAt)))
  return rows[0] ?? null
}

// Issue 090 Phase 4b — resolve a canvas NAVIGATION SELECTOR to its concrete
// canvas ROW, spanning the whole 090 transition in one place:
//   • null/undefined  → the project's default root canvas (the pre-090 default);
//   • a live canvas id → that canvas (the root switcher / a real Phase 4b
//     canvasId, root OR child);
//   • otherwise        → a legacy CONTEXT-id selector (the still-unmigrated
//     DesignSurface drill-in, which passes the URL context id): resolve it to
//     that context's child canvas.
// Returns null when nothing resolves yet (root/child canvas not synced), so a
// store read before the canvas lands yields [] exactly as before. Phase 4c
// collapses this to a plain id pass-through once the surface threads real
// canvas ids for both root and child navigation.
export async function resolveCanvasScope(
  db: Database,
  projectId: string,
  selector: string | null | undefined,
): Promise<CanvasRow | null> {
  if (selector === null || selector === undefined) {
    const rootId = await rootCanvasIdOrNull(db, projectId)
    return rootId === null ? null : getCanvas(db, rootId)
  }
  const direct = await getCanvas(db, selector)
  if (direct) return direct
  const childId = await liveChildCanvasIdOrNull(db, selector)
  return childId === null ? null : getCanvas(db, childId)
}

// SPEC — a project must always keep at least one live ROOT canvas (createProject
// seeds one; the switcher can never delete the last). Typed rejection mirroring
// DimensionFloorError so the UI disable and the store share one source of truth.
export class RootCanvasFloorError extends Error {
  constructor() {
    super('A project needs at least one design canvas')
    this.name = 'RootCanvasFloorError'
  }
}

// The verbatim rows a cascade touched, so a store can enqueue a sync op per row
// AND restore each exactly on undo (mirrors DimensionRemoveResult's contract).
export interface CanvasCascadeResult {
  canvas: CanvasRow
  dimensions: DimensionRow[]
  contexts: ContextRow[]
  bindings: BindingRow[]
}

async function liveRootCanvasCount(db: Querier, projectId: string): Promise<number> {
  const rows = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.projectId, projectId), isNull(canvases.parentContextId), isNull(canvases.deletedAt)))
  return rows.length
}

// Soft-delete a canvas AND everything on it — its dimensions, contexts, and
// those contexts' bindings — in one gesture (mirrors
// cascadeDeleteBindingsForDimension's tombstone-and-return shape). Returns the
// affected rows verbatim (as they were live) so a store can enqueue a delete
// per row and undo via restoreCanvasCascade. Archiving a ROOT canvas is floor-
// guarded: a project must keep >= 1 live root canvas (RootCanvasFloorError).
// Child canvases (parent_context_id set) have no floor.
export async function archiveCanvasCascade(db: Database, id: string): Promise<CanvasCascadeResult> {
  // 107 P4 — the canvas tombstone and its up-to-three cascade UPDATEs (dims +
  // contexts + bindings) commit as one unit: a mid-sequence failure must not
  // leave a tombstoned canvas whose dimensions/contexts/bindings are still live
  // (or vice versa). The floor guard reads on `tx` so it sees a snapshot
  // consistent with the writes; a throw (not-found or floor) just rolls back an
  // empty transaction.
  return db.transaction(async (tx) => {
    const canvasRow = firstOrThrow(
      await tx.select().from(canvases).where(eq(canvases.id, id)),
      'canvas not found',
    )
    if (canvasRow.parentContextId === null && (await liveRootCanvasCount(tx, canvasRow.projectId)) <= 1) {
      throw new RootCanvasFloorError()
    }
    const affectedDimensions = await tx
      .select()
      .from(dimensions)
      .where(and(eq(dimensions.canvasId, id), isNull(dimensions.deletedAt)))
    const affectedContexts = await tx
      .select()
      .from(contexts)
      .where(and(eq(contexts.canvasId, id), isNull(contexts.deletedAt)))
    const contextIds = affectedContexts.map((c) => c.id)
    const affectedBindings =
      contextIds.length > 0
        ? await tx
            .select()
            .from(bindings)
            .where(and(inArray(bindings.contextId, contextIds), isNull(bindings.deletedAt)))
        : []
    const ts = now()
    const canvasRows = await tx
      .update(canvases)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(eq(canvases.id, id))
      .returning()
    if (affectedDimensions.length > 0) {
      await tx
        .update(dimensions)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(inArray(dimensions.id, affectedDimensions.map((d) => d.id)))
    }
    if (affectedContexts.length > 0) {
      await tx
        .update(contexts)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(inArray(contexts.id, contextIds))
    }
    if (affectedBindings.length > 0) {
      await tx
        .update(bindings)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(inArray(bindings.id, affectedBindings.map((b) => b.id)))
    }
    return {
      canvas: firstOrThrow(canvasRows),
      dimensions: affectedDimensions,
      contexts: affectedContexts,
      bindings: affectedBindings,
    }
  })
}

// Undo of archiveCanvasCascade: revive exactly the rows it tombstoned (the
// captured result), clearing deleted_at on each. Mirrors restoreDimension —
// no floor check, it's a mechanical inverse.
export async function restoreCanvasCascade(
  db: Database,
  captured: CanvasCascadeResult,
): Promise<CanvasCascadeResult> {
  const ts = now()
  // 107 P4 — reviving the canvas and its captured dimensions/contexts/bindings
  // commit as one unit: a mid-sequence failure must not leave the canvas revived
  // while its rows stay tombstoned (or vice versa). The inverse of the archive
  // cascade, so it carries the same atomicity guarantee.
  await db.transaction(async (tx) => {
    await tx.update(canvases).set({ deletedAt: null, updatedAt: ts }).where(eq(canvases.id, captured.canvas.id))
    if (captured.dimensions.length > 0) {
      await tx
        .update(dimensions)
        .set({ deletedAt: null, updatedAt: ts })
        .where(inArray(dimensions.id, captured.dimensions.map((d) => d.id)))
    }
    if (captured.contexts.length > 0) {
      await tx
        .update(contexts)
        .set({ deletedAt: null, updatedAt: ts })
        .where(inArray(contexts.id, captured.contexts.map((c) => c.id)))
    }
    if (captured.bindings.length > 0) {
      await tx
        .update(bindings)
        .set({ deletedAt: null, updatedAt: ts })
        .where(inArray(bindings.id, captured.bindings.map((b) => b.id)))
    }
  })
  return captured
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

// Issue 090 Phase 4a — the read/scope path now keys on the explicit
// `canvas_id` membership FK, NOT `context_id IS NULL`. The old predicate made
// every root canvas of a project (all `context_id NULL`) collide, leaking rows
// between them; keying on canvas_id makes the N root canvases fully
// independent. projectId stays in the predicate as a cheap guard — the
// canvasId is the real key.
function canvasScope(projectId: string, canvasId: string) {
  return and(
    eq(dimensions.projectId, projectId),
    eq(dimensions.canvasId, canvasId),
    isNull(dimensions.deletedAt),
  )
}

// `canvasId` omitted (or null) means "the project's default root canvas" — the
// pre-090 root-canvas default, resolved to a concrete canvas id here so every
// caller that only knows a projectId keeps working unchanged.
export async function listDimensions(
  db: Querier,
  projectId: string,
  canvasId: string | null = null,
): Promise<DimensionRow[]> {
  // Tolerant default: a read before the root canvas has synced yields [] (the
  // pre-090 `isNull(context_id)` behavior), never a throw.
  const resolved = canvasId ?? (await rootCanvasIdOrNull(db, projectId))
  if (resolved === null) return []
  return db.select().from(dimensions).where(canvasScope(projectId, resolved)).orderBy(asc(dimensions.sort))
}

// Issue 082 Phase 1 — `name` lets the phantom-row add grammar (the same
// pattern parameters/contexts already use) commit the typed name in the same
// insert, one undo step, instead of add-then-rename as two. Omitted entirely
// (every pre-082 caller), the default-numbered "Dimension N" behavior is
// unchanged byte-for-byte.
// Issue 090 Phase 4a — `targetCanvasId` names the canvas the new dimension
// lands on; omitted, it defaults to the project's root canvas, so every
// pre-090 caller (`addDimension(db, projectId, name?)`) is unchanged.
export async function addDimension(
  db: Database,
  projectId: string,
  name?: string,
  targetCanvasId?: string,
): Promise<DimensionRow> {
  const canvasId = targetCanvasId ?? (await rootCanvasId(db, projectId))
  const existing = await listDimensions(db, projectId, canvasId)
  // Default name continues past the highest default-numbered live row so a
  // middle removal never produces a duplicate (never "Untitled").
  const maxDefault = existing.reduce((max, d) => {
    const m = /^Dimension (\d+)$/.exec(d.name)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0)
  const workspaceId = await projectWorkspaceId(db, projectId)
  const defaultName = `Dimension ${Math.max(maxDefault, existing.length) + 1}`
  const trimmedName = name?.trim()
  const finalName = trimmedName === undefined || trimmedName === '' ? defaultName : trimmedName
  const rows = await db
    .insert(dimensions)
    .values({
      id: uuidv7(),
      projectId,
      workspaceId,
      canvasId,
      name: finalName,
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

async function rewriteSort(db: Querier, ordered: DimensionRow[]): Promise<void> {
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
// Issue 090 Phase 4c — `canvasId` scopes the reorder to a specific root canvas
// (omitted ⇒ the project's default root canvas, so every pre-4c caller that
// only knows a projectId is unchanged). Without it a reorder on a non-default
// root canvas would list/rewrite the DEFAULT canvas's dimensions instead.
export async function reorderDimension(
  db: Database,
  projectId: string,
  id: string,
  toIndex: number,
  canvasId?: string,
): Promise<DimensionRow[]> {
  const rows = await listDimensions(db, projectId, canvasId ?? null)
  if (rows.findIndex((d) => d.id === id) === -1) return rows
  // 107 P3 — every `sort` rewrite in the densify loop commits as one unit: a
  // mid-loop failure must not leave the lane half-re-sorted. The ordering read
  // runs on `tx` so it sees a consistent snapshot; the authoritative final read
  // runs on `db` after commit.
  await db.transaction(async (tx) => {
    const current = await listDimensions(tx, projectId, canvasId ?? null)
    const from = current.findIndex((d) => d.id === id)
    if (from === -1) return
    const target = Math.max(0, Math.min(current.length - 1, toIndex))
    const moved = firstOrThrow(current.splice(from, 1))
    current.splice(target, 0, moved)
    await rewriteSort(tx, current)
  })
  return listDimensions(db, projectId, canvasId ?? null)
}

export interface DimensionRemoveResult {
  dimensions: DimensionRow[]
  deletedBindings: BindingRow[]
}

// SPEC invariant 4 (issue 007) — a dimension removal cascades to every binding
// pointing at it and recomputes the remaining tuple hash for each context that
// had one, keeping the duplicate-tuple index (issue 005) correct with the
// shrunk dimension set.
//
// Issue 032 (migration 0007): this cascade TOMBSTONES the bindings
// (`deleted_at`) rather than hard-deleting them, diverging from 007's original
// hard-delete — a hard-deleted row emits no row-delta, so ElectricSQL's
// read-path sync would have nothing to propagate a binding's removal to other
// clients. Every other read path (listBindings, recomputeTupleHash) already
// filters `deleted_at IS NULL`, so a tombstoned row disappears from every live
// view exactly as a hard-deleted one did; only this cascade + its undo
// counterpart (restoreDimension) know tombstones exist. Direct unbind
// (unbindParameter) and the parameter-delete cascade (deleteParametersUnbinding)
// are unchanged (still hard-delete) — 032 scopes the tombstone conversion to
// this cascade specifically (docs/issues/032).
// Returns the tombstoned rows verbatim so the caller can restore them exactly
// on undo (restoreDimension below).
async function cascadeDeleteBindingsForDimension(
  db: Querier,
  dimensionId: string,
): Promise<BindingRow[]> {
  const rows = await db
    .select()
    .from(bindings)
    .where(and(eq(bindings.dimensionId, dimensionId), isNull(bindings.deletedAt)))
  if (rows.length === 0) return rows
  const tombstoned = await db
    .update(bindings)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(and(eq(bindings.dimensionId, dimensionId), isNull(bindings.deletedAt)))
    .returning()
  const contextIds = [...new Set(rows.map((r) => r.contextId))]
  for (const contextId of contextIds) await recomputeTupleHash(db, contextId)
  return tombstoned
}

// The floor is a *user-facing* guard (SPEC §1): you can't manually remove
// below n = 2. It must NOT apply when the command log (issue 006) undoes an
// add() — that can legitimately take the count back through 1 or 0, the same
// below-floor guided-start states issue 002 already allows before the first
// crossing. removeDimensionUnchecked is that mechanical-replay primitive.
// Issue 090 Phase 4c — `canvasId` scopes the removal (and its sibling-sort
// rewrite) to a specific root canvas; omitted ⇒ the default root canvas.
async function removeDimensionUnchecked(
  db: Querier,
  projectId: string,
  id: string,
  canvasId?: string,
): Promise<DimensionRemoveResult> {
  const rows = await listDimensions(db, projectId, canvasId ?? null)
  const deletedBindings = await cascadeDeleteBindingsForDimension(db, id)
  await db
    .update(dimensions)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(dimensions.id, id))
  await rewriteSort(
    db,
    rows.filter((d) => d.id !== id),
  )
  return { dimensions: await listDimensions(db, projectId, canvasId ?? null), deletedBindings }
}

// Issue 090 Phase 4c — the floor count MUST be scoped to `canvasId`, else
// removing from a non-default root canvas would count the DEFAULT canvas's
// dimensions and mis-apply (or mis-skip) the n=2 floor.
export async function removeDimension(
  db: Database,
  projectId: string,
  id: string,
  canvasId?: string,
): Promise<DimensionRemoveResult> {
  const rows = await listDimensions(db, projectId, canvasId ?? null)
  // Shared with the server write-path (src/domain/writeInvariants.ts, issue
  // 043) — one predicate, enforced identically client-side (here) and
  // server-side, per ADR-0010's "share the rules, don't fork them".
  if (violatesDimensionFloor(rows.length)) throw new DimensionFloorError()
  // 107 P4 — the whole unchecked cascade (binding tombstones + their tuple-hash
  // recompute, the dimension tombstone, the sibling-sort rewrite) commits as one
  // unit: a mid-sequence failure must not leave a dimension tombstoned with its
  // bindings still live, or a half-densified sort. The floor pre-check reads on
  // `db`; the delegate runs entirely on `tx` (it must NOT open its own
  // transaction — undoAddDimension still calls it un-wrapped on the top-level db).
  return db.transaction((tx) => removeDimensionUnchecked(tx, projectId, id, canvasId))
}

// Exported specifically for the command log's undo-of-add (issue 006) — see
// removeDimensionUnchecked above for why the floor check must not apply here.
export { removeDimensionUnchecked as undoAddDimension }

// The undo-of-remove / redo-of-add primitive (issue 006): un-soft-deletes the
// row AND rewrites every live row's sort to match `orderedIds` verbatim, so a
// middle removal's undo restores the exact original position instead of
// appending at the end. `orderedIds` is the full live order captured by the
// caller (store) right before the mutation being undone/redone.
// `bindingsToRestore` (issue 007) un-tombstones the exact rows the cascade
// (cascadeDeleteBindingsForDimension) set `deleted_at` on — issue 032 changed
// that cascade from a hard delete to a tombstone, so undo now clears
// `deleted_at` on the same row ids (they still exist) rather than
// re-inserting fresh rows — and recomputes their contexts' tuple hashes back
// to the original.
// Issue 090 Phase 4c — `canvasId` scopes the sibling-sort rewrite to the same
// root canvas the removal came from; omitted ⇒ the default root canvas.
export async function restoreDimension(
  db: Database,
  projectId: string,
  id: string,
  orderedIds: readonly string[],
  bindingsToRestore: readonly BindingRow[] = [],
  canvasId?: string,
): Promise<DimensionRow[]> {
  // 107 P4 — the un-delete, the full sibling-sort rewrite, every binding
  // restore, and each affected context's tuple-hash recompute commit as one
  // unit: a mid-sequence failure must not leave the dimension revived with a
  // half-rewritten sort or only some bindings restored. Reads inside the
  // callback use `tx` so they see the un-delete; the authoritative final read
  // runs on `db` after commit.
  await db.transaction(async (tx) => {
    await tx
      .update(dimensions)
      .set({ deletedAt: null, updatedAt: now() })
      .where(eq(dimensions.id, id))
    const rows = await listDimensions(tx, projectId, canvasId ?? null)
    const byId = new Map(rows.map((d) => [d.id, d]))
    const ordered = orderedIds
      .map((oid) => byId.get(oid))
      .filter((d): d is DimensionRow => d !== undefined)
    await rewriteSort(tx, ordered)
    if (bindingsToRestore.length > 0) {
      // Restore each binding to its captured state — not merely un-tombstone.
      // The binding rows are unique per (context, dimension); while this
      // dimension was removed, a bind onto the same (context, dimension) — which
      // the parameters store still permits, since a removed dimension's
      // parameters linger there — can have revived and re-pointed the SAME row to
      // a different parameter. Clearing deleted_at alone would then revive it with
      // the WRONG parameter (caught by undoRedo.property). Rewriting parameterId
      // from the captured row makes undo-of-remove a faithful inverse regardless.
      for (const b of bindingsToRestore) {
        await tx
          .update(bindings)
          .set({ deletedAt: null, parameterId: b.parameterId, updatedAt: now() })
          .where(eq(bindings.id, b.id))
      }
      const contextIds = [...new Set(bindingsToRestore.map((r) => r.contextId))]
      for (const contextId of contextIds) await recomputeTupleHash(tx, contextId)
    }
  })
  return listDimensions(db, projectId, canvasId ?? null)
}

// ── Parameters (issue 003) ────────────────────────────────────────────────────
// m (parameter count) is unbounded and independent per dimension — no floor,
// unlike dimensions' n = 2. parentParamId is accepted now but has no UI until
// sub-parameters arrive (issue 011).

export type ParameterRow = typeof parameters.$inferSelect

function parameterScope(dimensionId: string) {
  return and(eq(parameters.dimensionId, dimensionId), isNull(parameters.deletedAt))
}

export async function listParameters(db: Querier, dimensionId: string): Promise<ParameterRow[]> {
  return db.select().from(parameters).where(parameterScope(dimensionId)).orderBy(asc(parameters.sort))
}

export async function addParameter(
  db: Database,
  dimensionId: string,
  name: string,
  parentParamId: string | null = null,
): Promise<ParameterRow> {
  const existing = await listParameters(db, dimensionId)
  const workspaceId = await dimensionWorkspaceId(db, dimensionId)
  const rows = await db
    .insert(parameters)
    .values({
      id: uuidv7(),
      dimensionId,
      workspaceId,
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

async function rewriteParameterSort(db: Querier, ordered: ParameterRow[]): Promise<void> {
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
  if (rows.findIndex((p) => p.id === id) === -1) return rows
  // 107 P3 — every `sort` rewrite in the densify loop commits as one unit: a
  // mid-loop failure must not leave the group half-re-sorted. The ordering read
  // runs on `tx` so it sees a consistent snapshot; the authoritative final read
  // runs on `db` after commit.
  await db.transaction(async (tx) => {
    const current = await listParameters(tx, dimensionId)
    const from = current.findIndex((p) => p.id === id)
    if (from === -1) return
    const target = Math.max(0, Math.min(current.length - 1, toIndex))
    const moved = firstOrThrow(current.splice(from, 1))
    current.splice(target, 0, moved)
    await rewriteParameterSort(tx, current)
  })
  return listParameters(db, dimensionId)
}

// 107 P5 — widened to `Querier` so deleteParametersUnbinding can compose it
// INSIDE its transaction (passing `tx`) without opening a nested one. It is not
// itself a 107 wrap target: its OTHER callers (undo-of-add in store/parameters
// + tier2, and the parameters tests) still pass the top-level `db` (Database ⊆
// Querier), each an atomic single-gesture call that needs no wrap of its own.
export async function removeParameter(
  db: Querier,
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

// Issue 090 Phase 4a — the exact analog of canvasScope: contexts are now
// scoped by the explicit `canvas_id` FK, not `parent_id IS NULL`. Symbols are
// unique per canvas, so the collision check and the auto-assign both scope
// here. projectId is a cheap guard; canvasId is the real key.
function contextCanvasScope(projectId: string, canvasId: string) {
  return and(
    eq(contexts.projectId, projectId),
    eq(contexts.canvasId, canvasId),
    isNull(contexts.deletedAt),
  )
}

// `canvasId` omitted (or null) = the project's default root canvas.
export async function listContexts(
  db: Database,
  projectId: string,
  canvasId: string | null = null,
): Promise<ContextRow[]> {
  // Tolerant default (see listDimensions): [] before the root canvas has synced.
  const resolved = canvasId ?? (await rootCanvasIdOrNull(db, projectId))
  if (resolved === null) return []
  return db
    .select()
    .from(contexts)
    .where(contextCanvasScope(projectId, resolved))
    .orderBy(asc(contexts.sort))
}

// Issue 089 D1 Phase 4 — every LIVE context in the project, across ALL canvases
// (root + child). Unlike listContexts (scoped to a single canvas), the rich-text
// heal-on-load normalizes the whole project's justification prose in one pass, so
// it must see contexts on child canvases too. Live rows only: a tombstoned
// context's prose never renders, so it never needs converting.
export async function listContextsForHeal(db: Database, projectId: string): Promise<ContextRow[]> {
  return db
    .select()
    .from(contexts)
    .where(and(eq(contexts.projectId, projectId), isNull(contexts.deletedAt)))
}

// Root contexts cycle the Greek alphabet; a child context (parent set) is named
// parent-symbol + index (α1, α2 — SPEC §3, issue 011), both scoped to the
// canvas's live siblings so a deleted gap never collides on reassignment.
// Issue 090 Phase 4a — the root branch accepts an explicit `targetCanvasId`
// (which root canvas to create the context on); omitted, it defaults to the
// project's root canvas. The child branch always resolves the parent context's
// child canvas (childCanvasId), so `targetCanvasId` is ignored there.
export async function createContext(
  db: Database,
  projectId: string,
  parentId: string | null = null,
  targetCanvasId?: string,
): Promise<ContextRow> {
  const parentSymbol = parentId
    ? firstOrThrow(await db.select().from(contexts).where(eq(contexts.id, parentId))).symbol
    : null
  // Resolve the canvas the new context lives on FIRST, then scope siblings +
  // the symbol namespace to it (symbols are unique per canvas).
  const canvasId = parentId
    ? await childCanvasId(db, parentId)
    : (targetCanvasId ?? (await rootCanvasId(db, projectId)))
  const existing = await listContexts(db, projectId, canvasId)
  const taken = new Set(existing.map((c) => c.symbol))
  const symbol = parentSymbol ? nextChildSymbol(parentSymbol, taken) : nextRootSymbol(taken)
  const workspaceId = await projectWorkspaceId(db, projectId)
  const rows = await db
    .insert(contexts)
    .values({
      id: uuidv7(),
      projectId,
      workspaceId,
      canvasId,
      parentId,
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
  const target = firstOrThrow(await db.select().from(contexts).where(eq(contexts.id, id)))
  // Issue 090 Phase 4a — scope the collision check to the target's canvas.
  const existing = await listContexts(db, projectId, target.canvasId)
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

// Live bindings only — a tombstoned row (issue 032: cascadeDeleteBindingsForDimension
// below) never surfaces through this read path. recomputeTupleHash, the register,
// and the sync read-path all key off this same filter.
export async function listBindings(db: Querier, contextId: string): Promise<BindingRow[]> {
  return db
    .select()
    .from(bindings)
    .where(and(eq(bindings.contextId, contextId), isNull(bindings.deletedAt)))
}

// All of a context's binding rows share one tuple_hash, kept in dimension-sort
// order — a single indexed scan then finds duplicate-tuple contexts (issue 005+).
async function recomputeTupleHash(db: Querier, contextId: string): Promise<void> {
  const contextRows = await db.select().from(contexts).where(eq(contexts.id, contextId))
  const contextRow = firstOrThrow(contextRows)
  // A context's tuple is over the dimensions of ITS canvas (its canvas_id),
  // not the project's root canvas — critical once bindings live on a child
  // canvas (issue 011). Issue 090 Phase 4a: key on canvas_id, not parent_id.
  const dims = await listDimensions(db, contextRow.projectId, contextRow.canvasId)
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
  // 107 P5 — the binding upsert and the tuple-hash recompute it invalidates
  // commit as one unit: a mid-sequence failure must not leave a re-pointed
  // binding carrying the pre-bind tuple_hash (duplicate-tuple detection reads it
  // directly — issue 005+). The workspace read runs on `tx` so the whole
  // mutation sees one snapshot; the authoritative final read runs on `db` after
  // commit.
  await db.transaction(async (tx) => {
    const workspaceId = await contextWorkspaceId(tx, contextId)
    await tx
      .insert(bindings)
      .values({ id: uuidv7(), contextId, dimensionId, parameterId, workspaceId, tupleHash: '' })
      .onConflictDoUpdate({
        target: [bindings.contextId, bindings.dimensionId],
        // Bindings are current-state pointers, not history (schema.ts). Since
        // issue 032 made cascadeDeleteBindingsForDimension tombstone rows
        // (deleted_at) instead of hard-deleting, a re-bind can land on a
        // tombstoned pointer — clear deleted_at so the upsert always yields a
        // LIVE binding (else it updates parameterId but stays soft-deleted and
        // invisible to every live read).
        set: { parameterId, deletedAt: null, updatedAt: now() },
      })
    await recomputeTupleHash(tx, contextId)
  })
  return listBindings(db, contextId)
}

export async function unbindParameter(
  db: Database,
  contextId: string,
  dimensionId: string,
): Promise<BindingRow[]> {
  // Tombstone, not hard-delete (issue 032): a hard delete emits no row-delta
  // for ElectricSQL's read-path sync (same rationale as the dimension cascade),
  // AND it destroys the row that a still-pending dimension-remove undo expects
  // to restore by id — so a re-bind onto a removed dimension's stale parameter,
  // then undo, could orphan a binding a later remove-undo could no longer bring
  // back (caught by undoRedo.property). Soft-deleting keeps the row addressable
  // by id; every live read already filters `deleted_at IS NULL`.
  // 107 P5 — the binding tombstone and the tuple-hash recompute it invalidates
  // commit as one unit: a mid-sequence failure must not leave a tombstoned
  // binding while the surviving siblings keep the pre-unbind tuple_hash.
  await db.transaction(async (tx) => {
    await tx
      .update(bindings)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(
        and(
          eq(bindings.contextId, contextId),
          eq(bindings.dimensionId, dimensionId),
          isNull(bindings.deletedAt),
        ),
      )
    await recomputeTupleHash(tx, contextId)
  })
  return listBindings(db, contextId)
}

// ── Recursion: child canvases (issue 011) ────────────────────────────────────
// Drilling into a context α opens its child canvas: one dimension per α binding
// (SPEC recursion rule, invariant 3), each seeded from the bound parameter and
// carrying source_param_id so a re-open maps back to the same rows (idempotent)
// and a parent re-bind is detectable. Sub-parameters of a source parameter live
// AS the child dimension's parameters (dimension_id = child dim, parent_param_id
// = source), so the parameters/register/canvas layers reuse unchanged.

export interface StaleRebindEvent {
  childDimensionId: string
  fromParameterId: string
  toParameterId: string
  fromName: string
  toName: string
  // Sub-bindings hard-deleted because they pointed at the old parameter's
  // sub-parameters (bindings have no deleted_at — schema.ts). Kept verbatim so
  // revertStaleRebind can re-insert them exactly.
  retiredBindings: BindingRow[]
}

export interface ChildCanvasResult {
  // Issue 090 Phase 4a — the resolved child canvas id (created on first open),
  // so the UI/store can load this canvas's stores by its real id later.
  canvasId: string
  dimensions: DimensionRow[]
  stale: StaleRebindEvent[]
}

async function getParameter(db: Querier, id: string): Promise<ParameterRow> {
  return firstOrThrow(await db.select().from(parameters).where(eq(parameters.id, id)))
}

// Idempotent open/reconcile. First call seeds child dimensions; later calls
// reconcile each against the parent's CURRENT bindings (the stale-rebind rule:
// child dimension follows the new parameter, its sub-bindings retired) and add
// any missing ones — never duplicating (acceptance criterion 1).
export async function openChildCanvas(
  db: Database,
  parentContextId: string,
): Promise<ChildCanvasResult> {
  // 107 P5 — the heaviest wrap: the child canvas materialization (childCanvasId
  // may INSERT), every seeded/reconciled child-dimension write, the retired
  // sub-binding hard-deletes and their tuple-hash recomputes all commit as one
  // unit. A mid-sequence failure must not leave the child canvas half-seeded
  // (some dimensions in, others not) or a dimension re-pointed with its retired
  // sub-bindings still live. Every intra-callback read + write runs on `tx`; the
  // returned dimensions are read on `tx` just before commit (identical to a
  // post-commit `db` read on success).
  return db.transaction(async (tx) => {
    const parent = firstOrThrow(await tx.select().from(contexts).where(eq(contexts.id, parentContextId)))
    const projectId = parent.projectId
    // Issue 090 — the child canvas backing this drill-in (created on first open).
    const canvasId = await childCanvasId(tx, parentContextId)
    // Parent dimensions live on the PARENT context's canvas (Phase 4a: key on
    // canvas_id, not parent_id).
    const parentDims = await listDimensions(tx, projectId, parent.canvasId)
    const parentBindings = await listBindings(tx, parentContextId)
    const boundByDim = new Map(parentBindings.map((b) => [b.dimensionId, b.parameterId]))
    // One prospective child dimension per parent binding, in parent dim order.
    const slots = parentDims
      .filter((d) => boundByDim.has(d.id))
      .map((d, i) => ({
        parentDimensionId: d.id,
        parameterId: boundByDim.get(d.id) as string,
        color: d.color,
        sort: i,
      }))

    const existing = await listDimensions(tx, projectId, canvasId)
    // Each existing child dimension maps to a parent dimension via its source
    // parameter (a parameter belongs to exactly one dimension, stable across a
    // re-bind since parameters never change dimension).
    const existingByParentDim = new Map<string, DimensionRow>()
    for (const child of existing) {
      if (!child.sourceParamId) continue
      const src = await getParameter(tx, child.sourceParamId)
      existingByParentDim.set(src.dimensionId, child)
    }

    const stale: StaleRebindEvent[] = []
    for (const slot of slots) {
      const paramRow = await getParameter(tx, slot.parameterId)
      const child = existingByParentDim.get(slot.parentDimensionId)
      if (!child) {
        await tx.insert(dimensions).values({
          id: uuidv7(),
          projectId,
          workspaceId: parent.workspaceId,
          canvasId,
          contextId: parentContextId,
          sourceParamId: slot.parameterId,
          name: paramRow.name,
          color: slot.color,
          sort: slot.sort,
        })
        continue
      }
      if (child.sourceParamId !== slot.parameterId) {
        const retiredBindings = await tx
          .select()
          .from(bindings)
          .where(and(eq(bindings.dimensionId, child.id), isNull(bindings.deletedAt)))
        const fromParam = child.sourceParamId ? await getParameter(tx, child.sourceParamId) : null
        if (retiredBindings.length > 0) {
          await tx.delete(bindings).where(eq(bindings.dimensionId, child.id))
          for (const cid of new Set(retiredBindings.map((r) => r.contextId))) {
            await recomputeTupleHash(tx, cid)
          }
        }
        await tx
          .update(dimensions)
          .set({ sourceParamId: slot.parameterId, name: paramRow.name, sort: slot.sort, updatedAt: now() })
          .where(eq(dimensions.id, child.id))
        stale.push({
          childDimensionId: child.id,
          fromParameterId: child.sourceParamId as string,
          toParameterId: slot.parameterId,
          fromName: fromParam?.name ?? '',
          toName: paramRow.name,
          retiredBindings,
        })
      } else if (child.sort !== slot.sort || child.name !== paramRow.name) {
        // Keep order/name synced with the parent binding (parent reorder/rename).
        await tx
          .update(dimensions)
          .set({ sort: slot.sort, name: paramRow.name, updatedAt: now() })
          .where(eq(dimensions.id, child.id))
      }
    }

    return { canvasId, dimensions: await listDimensions(tx, projectId, canvasId), stale }
  })
}

// The banner Undo (issue 011): restores a child dimension to the parameter it
// refined before the parent re-bind and re-inserts the retired sub-bindings.
export async function revertStaleRebind(db: Database, event: StaleRebindEvent): Promise<void> {
  // 107 P5 — the child-dimension re-point, the retired-binding re-inserts, and
  // each affected context's tuple-hash recompute commit as one unit: a
  // mid-sequence failure must not leave the dimension pointing back at its
  // pre-rebind parameter while its sub-bindings are only partly restored.
  await db.transaction(async (tx) => {
    await tx
      .update(dimensions)
      .set({ sourceParamId: event.fromParameterId, name: event.fromName, updatedAt: now() })
      .where(eq(dimensions.id, event.childDimensionId))
    if (event.retiredBindings.length > 0) {
      await tx.insert(bindings).values(
        event.retiredBindings.map((r) => ({
          id: r.id,
          contextId: r.contextId,
          dimensionId: r.dimensionId,
          parameterId: r.parameterId,
          // Issue 078 step 2 — the captured BindingRow already carries its own
          // workspaceId (stamped when it was originally bound); reinsert it
          // verbatim rather than re-resolving via contextWorkspaceId, since
          // this row is a faithful restore, not a new bind.
          workspaceId: r.workspaceId,
          tupleHash: r.tupleHash,
        })),
      )
      for (const cid of new Set(event.retiredBindings.map((r) => r.contextId))) {
        await recomputeTupleHash(tx, cid)
      }
    }
  })
}

// Resolve a recursion path (context ids, in depth order) to its context rows,
// dropping any id that no longer resolves — backs the breadcrumb trail's
// symbols (URL segments are ids; breadcrumbs display symbols — SITEMAP §1).
export async function getContextsByIds(db: Database, ids: readonly string[]): Promise<ContextRow[]> {
  const rows: ContextRow[] = []
  for (const id of ids) {
    const found = await db.select().from(contexts).where(eq(contexts.id, id)).limit(1)
    if (found[0]) rows.push(found[0])
  }
  return rows
}

// Child count per context on a canvas — backs the node's child badge (SPEC
// §4.2) and the register's Children column (issue 011). Issue 090 Phase 4a:
// the canvas being viewed is now keyed by `canvasId` (null = root canvas); a
// context's child count is the number of live contexts whose `parent_id`
// points at it (the kept parent_id column IS the child-membership pointer —
// see doc Correction 2), so counting children never needs to materialize a
// child canvas.
export async function childCountsByContext(
  db: Database,
  projectId: string,
  canvasId: string | null = null,
): Promise<Record<string, number>> {
  const canvasContexts = await listContexts(db, projectId, canvasId)
  const counts: Record<string, number> = {}
  for (const ctx of canvasContexts) {
    const kids = await db
      .select({ id: contexts.id })
      .from(contexts)
      .where(and(eq(contexts.parentId, ctx.id), isNull(contexts.deletedAt)))
    if (kids.length > 0) counts[ctx.id] = kids.length
  }
  return counts
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

// Issue 089 D1 Phase 5 — the rich-text heal reader for tier1_purpose.body. The
// unique project_id index means there is at most ONE purpose row per project,
// so this returns [] or [row], mirroring listContextsForHeal's live-rows-only
// contract (getTier1Purpose already excludes tombstones). The heal converts
// `body` in place; `existing_scenario` on the same row is already rich and is
// never touched by the body write (setTier1Purpose's upsert sets body only).
export async function listTier1PurposeForHeal(
  db: Database,
  projectId: string,
): Promise<Tier1PurposeRow[]> {
  const row = await getTier1Purpose(db, projectId)
  return row ? [row] : []
}

export async function setTier1Purpose(
  db: Database,
  projectId: string,
  body: string,
): Promise<Tier1PurposeRow | null> {
  const workspaceId = await projectWorkspaceId(db, projectId)
  await db
    .insert(tier1Purpose)
    .values({ id: uuidv7(), projectId, workspaceId, body })
    .onConflictDoUpdate({ target: tier1Purpose.projectId, set: { body, updatedAt: now() } })
  return getTier1Purpose(db, projectId)
}

// Issue 081 — Purpose and Existing Scenario are edited independently
// (separate editors, separate commit gestures per the design brief), so
// this is its own setter rather than a parameter on setTier1Purpose — the
// same split as setDescription/renameTier1Prop above. `body` is NOT NULL
// (schema.ts), so a first-ever save (no purpose row exists yet) must carry
// the current row's body (or '') into the insert values, never a bare
// insert of just {id, projectId, workspaceId, existingScenario} — that
// would violate the NOT NULL constraint.
export async function setTier1ExistingScenario(
  db: Database,
  projectId: string,
  existingScenario: string | null,
): Promise<Tier1PurposeRow | null> {
  const workspaceId = await projectWorkspaceId(db, projectId)
  const current = await getTier1Purpose(db, projectId)
  await db
    .insert(tier1Purpose)
    .values({ id: uuidv7(), projectId, workspaceId, body: current?.body ?? '', existingScenario })
    .onConflictDoUpdate({ target: tier1Purpose.projectId, set: { existingScenario, updatedAt: now() } })
  return getTier1Purpose(db, projectId)
}

function tier1PropScope(projectId: string) {
  return and(eq(tier1Props.projectId, projectId), isNull(tier1Props.deletedAt))
}

export async function listTier1Props(db: Querier, projectId: string): Promise<Tier1PropRow[]> {
  return db.select().from(tier1Props).where(tier1PropScope(projectId)).orderBy(asc(tier1Props.sort))
}

// rank (1-based, degree notation) and sort (0-based order) move in lockstep in
// this tier — rewritten to their positional index on every add/reorder/remove
// so both stay contiguous (issue 013 unit test).
async function rewriteTier1PropRanks(db: Querier, ordered: Tier1PropRow[]): Promise<void> {
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
  const workspaceId = await projectWorkspaceId(db, projectId)
  const rows = await db
    .insert(tier1Props)
    .values({
      id: uuidv7(),
      projectId,
      workspaceId,
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
  if (rows.findIndex((p) => p.id === id) === -1) return rows
  // 107 P3 — sort+rank move in lockstep across the rewrite loop; every row's
  // rewrite commits as one unit so a mid-loop failure can't leave rank/sort
  // half-densified. The ordering read runs on `tx` for a consistent snapshot;
  // the authoritative final read runs on `db` after commit.
  await db.transaction(async (tx) => {
    const current = await listTier1Props(tx, projectId)
    const from = current.findIndex((p) => p.id === id)
    if (from === -1) return
    const target = Math.max(0, Math.min(current.length - 1, toIndex))
    const moved = firstOrThrow(current.splice(from, 1))
    current.splice(target, 0, moved)
    await rewriteTier1PropRanks(tx, current)
  })
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

// ── Tier 2 Architecture (issue 014) ──────────────────────────────────────────
// One nested-row table per intended dimension (Value / Stakeholders / Process
// in the example). Selected entries promote into 3rd-Tier dimensions +
// parameters, each parameter keeping a source_entry_id back-reference
// (SPEC §4.6, invariant 7 — tier linkage). Root canvas only (child canvases 011).

export type Tier2TableRow = typeof tier2Tables.$inferSelect
export type Tier2EntryRow = typeof tier2Entries.$inferSelect

function tier2TableScope(projectId: string) {
  return and(eq(tier2Tables.projectId, projectId), isNull(tier2Tables.deletedAt))
}

export async function listTier2Tables(db: Querier, projectId: string): Promise<Tier2TableRow[]> {
  return db.select().from(tier2Tables).where(tier2TableScope(projectId)).orderBy(asc(tier2Tables.sort))
}

export async function addTier2Table(
  db: Database,
  projectId: string,
  name: string,
): Promise<Tier2TableRow> {
  const existing = await listTier2Tables(db, projectId)
  const workspaceId = await projectWorkspaceId(db, projectId)
  const rows = await db
    .insert(tier2Tables)
    .values({ id: uuidv7(), projectId, workspaceId, name, sort: existing.length })
    .returning()
  return firstOrThrow(rows)
}

export async function renameTier2Table(
  db: Database,
  id: string,
  name: string,
): Promise<Tier2TableRow> {
  const rows = await db
    .update(tier2Tables)
    .set({ name, updatedAt: now() })
    .where(eq(tier2Tables.id, id))
    .returning()
  return firstOrThrow(rows)
}

async function rewriteTier2TableSort(db: Querier, ordered: Tier2TableRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort !== index) {
      await db.update(tier2Tables).set({ sort: index, updatedAt: now() }).where(eq(tier2Tables.id, row.id))
    }
  }
}

// The undo-of-add primitive (issue 006): add always appends an empty table, so
// its undo soft-deletes that row and closes the sort gap for siblings.
export async function removeTier2Table(
  db: Database,
  projectId: string,
  id: string,
): Promise<Tier2TableRow[]> {
  const rows = await listTier2Tables(db, projectId)
  await db.update(tier2Tables).set({ deletedAt: now(), updatedAt: now() }).where(eq(tier2Tables.id, id))
  await rewriteTier2TableSort(
    db,
    rows.filter((t) => t.id !== id),
  )
  return listTier2Tables(db, projectId)
}

export async function restoreTier2Table(
  db: Database,
  projectId: string,
  id: string,
  orderedIds: readonly string[],
): Promise<Tier2TableRow[]> {
  await db.update(tier2Tables).set({ deletedAt: null, updatedAt: now() }).where(eq(tier2Tables.id, id))
  const rows = await listTier2Tables(db, projectId)
  const byId = new Map(rows.map((t) => [t.id, t]))
  const ordered = orderedIds
    .map((oid) => byId.get(oid))
    .filter((t): t is Tier2TableRow => t !== undefined)
  await rewriteTier2TableSort(db, ordered)
  return listTier2Tables(db, projectId)
}

// Issue 089 D3 P3.4 — move a table to `toIndex` within its project's
// Architecture lane and re-densify `sort` to 0..n-1 (mirrors reorderDimension /
// reorderCanvas). A table node dragged up/down its lane carries exactly one
// meaning — reorder — so ONLY `sort` is ever rewritten; the node's `{x,y}` is a
// pure derived projection of `(tier, sort)` and is never persisted (SPEC
// invariant 5 / STYLE_GUIDE §1 principle 4). Returns the full re-sorted list so
// the store can diff which rows actually moved. An unknown id is a no-op; a
// `toIndex` past the lane bounds is clamped.
export async function reorderTier2Table(
  db: Database,
  projectId: string,
  id: string,
  toIndex: number,
): Promise<Tier2TableRow[]> {
  const rows = await listTier2Tables(db, projectId)
  if (rows.findIndex((t) => t.id === id) === -1) return rows
  // 107 P3 — every `sort` rewrite in the densify loop commits as one unit: a
  // mid-loop failure must not leave the lane half-re-sorted. The ordering read
  // runs on `tx` so it sees a consistent snapshot; the authoritative final read
  // runs on `db` after commit.
  await db.transaction(async (tx) => {
    const current = await listTier2Tables(tx, projectId)
    const from = current.findIndex((t) => t.id === id)
    if (from === -1) return
    const target = Math.max(0, Math.min(current.length - 1, toIndex))
    const moved = firstOrThrow(current.splice(from, 1))
    current.splice(target, 0, moved)
    await rewriteTier2TableSort(tx, current)
  })
  return listTier2Tables(db, projectId)
}

// ── Entries ──────────────────────────────────────────────────────────────────

function tier2EntryScope(tableId: string) {
  return and(eq(tier2Entries.tableId, tableId), isNull(tier2Entries.deletedAt))
}

// All live entries of a table (every level); the nesting is assembled purely in
// domain/entryTree.ts. `sort` orders siblings within a parent.
export async function listTier2Entries(db: Querier, tableId: string): Promise<Tier2EntryRow[]> {
  return db.select().from(tier2Entries).where(tier2EntryScope(tableId)).orderBy(asc(tier2Entries.sort))
}

// Issue 089 D1 Phase 5 — every LIVE entry across ALL of the project's live
// tables (listTier2Entries is scoped to one table). The rich-text heal-on-load
// normalizes the whole project's description prose in one pass, so it walks
// each live table's entries. Live rows only (both table and entry): a
// tombstoned entry's prose never renders, so it never needs converting.
export async function listTier2EntriesForHeal(
  db: Database,
  projectId: string,
): Promise<Tier2EntryRow[]> {
  const tables = await listTier2Tables(db, projectId)
  const all: Tier2EntryRow[] = []
  for (const table of tables) all.push(...(await listTier2Entries(db, table.id)))
  return all
}

function siblingsOf(entries: Tier2EntryRow[], parentId: string | null): Tier2EntryRow[] {
  return entries.filter((e) => e.parentId === parentId).sort((a, b) => a.sort - b.sort)
}

async function rewriteEntrySiblingSort(db: Querier, ordered: Tier2EntryRow[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort !== index) {
      await db.update(tier2Entries).set({ sort: index, updatedAt: now() }).where(eq(tier2Entries.id, row.id))
    }
  }
}

export async function addTier2Entry(
  db: Database,
  tableId: string,
  parentId: string | null,
  name: string,
): Promise<Tier2EntryRow> {
  const existing = await listTier2Entries(db, tableId)
  const workspaceId = await tier2TableWorkspaceId(db, tableId)
  const rows = await db
    .insert(tier2Entries)
    .values({
      id: uuidv7(),
      tableId,
      workspaceId,
      parentId,
      name,
      description: null,
      sort: siblingsOf(existing, parentId).length,
    })
    .returning()
  return firstOrThrow(rows)
}

export async function renameTier2Entry(db: Database, id: string, name: string): Promise<Tier2EntryRow> {
  const rows = await db
    .update(tier2Entries)
    .set({ name, updatedAt: now() })
    .where(eq(tier2Entries.id, id))
    .returning()
  return firstOrThrow(rows)
}

export async function setTier2EntryDescription(
  db: Database,
  id: string,
  description: string,
): Promise<Tier2EntryRow> {
  const rows = await db
    .update(tier2Entries)
    .set({ description, updatedAt: now() })
    .where(eq(tier2Entries.id, id))
    .returning()
  return firstOrThrow(rows)
}

// Re-parent + reorder an entry among its (new) siblings. Descendants reference
// the moved entry by id, so the subtree follows intact — only the two affected
// sibling groups' sorts are rewritten contiguous.
export async function moveTier2Entry(
  db: Database,
  tableId: string,
  id: string,
  newParentId: string | null,
  toIndex: number,
): Promise<Tier2EntryRow[]> {
  const before = await listTier2Entries(db, tableId)
  const moved = before.find((e) => e.id === id)
  if (!moved) return before
  const oldParentId = moved.parentId

  // 105 P1 — the reparent UPDATE and both sibling-group sort rewrites commit as
  // one unit: a mid-sequence failure must not leave a changed parent_id or a
  // half-densified sort behind. Reads inside the callback use `tx` so they see
  // the uncommitted writes; the authoritative final read below runs after commit.
  await db.transaction(async (tx) => {
    await tx
      .update(tier2Entries)
      .set({ parentId: newParentId, updatedAt: now() })
      .where(eq(tier2Entries.id, id))

    const after = await listTier2Entries(tx, tableId)
    // Order the destination group with the moved entry spliced to toIndex.
    const destOthers = siblingsOf(after, newParentId).filter((e) => e.id !== id)
    const target = Math.max(0, Math.min(destOthers.length, toIndex))
    const movedRow = after.find((e) => e.id === id)
    if (!movedRow) throw new Error('moved entry vanished mid-transaction')
    destOthers.splice(target, 0, movedRow)
    await rewriteEntrySiblingSort(tx, destOthers)
    if (oldParentId !== newParentId) {
      await rewriteEntrySiblingSort(tx, siblingsOf(await listTier2Entries(tx, tableId), oldParentId))
    }
  })
  return listTier2Entries(db, tableId)
}

// Soft-delete an entry and every descendant, closing the sort gap left in the
// removed root's sibling group. Returns the removed ids so the caller (store)
// can restore the exact subtree on undo and audit linkage (invariant 7).
export async function removeTier2EntrySubtree(
  db: Database,
  tableId: string,
  id: string,
): Promise<{ entries: Tier2EntryRow[]; removedIds: string[] }> {
  const before = await listTier2Entries(db, tableId)
  const childrenOf = new Map<string, string[]>()
  for (const e of before) {
    if (e.parentId) childrenOf.set(e.parentId, [...(childrenOf.get(e.parentId) ?? []), e.id])
  }
  const removedIds: string[] = []
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop() as string
    removedIds.push(current)
    for (const childId of childrenOf.get(current) ?? []) stack.push(childId)
  }
  const removedRoot = before.find((e) => e.id === id)

  // 107 P2 — the subtree soft-delete UPDATE and the removed root's sibling
  // re-densify commit as one unit: a mid-sequence failure must not leave
  // tombstoned rows with a half-closed sort gap. The densify read uses `tx` so
  // it sees the soft-delete; the authoritative final read runs after commit.
  await db.transaction(async (tx) => {
    await tx
      .update(tier2Entries)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(inArray(tier2Entries.id, removedIds))
    await rewriteEntrySiblingSort(
      tx,
      siblingsOf(await listTier2Entries(tx, tableId), removedRoot?.parentId ?? null),
    )
  })
  return { entries: await listTier2Entries(db, tableId), removedIds }
}

export async function restoreTier2EntrySubtree(
  db: Database,
  tableId: string,
  removedIds: readonly string[],
): Promise<Tier2EntryRow[]> {
  // 107 P2 — the un-delete UPDATE and every affected parent's sibling re-densify
  // commit as one unit: a mid-sequence failure must not leave rows restored with
  // a half-rewritten sort. Reads inside the callback use `tx` so they see the
  // un-delete; the authoritative final read runs on `db` after commit.
  await db.transaction(async (tx) => {
    await tx
      .update(tier2Entries)
      .set({ deletedAt: null, updatedAt: now() })
      .where(inArray(tier2Entries.id, [...removedIds]))
    const restored = await listTier2Entries(tx, tableId)
    // Re-close each affected sibling group so restored rows regain contiguous sort.
    const parents = new Set(restored.filter((e) => removedIds.includes(e.id)).map((e) => e.parentId))
    for (const parentId of parents) await rewriteEntrySiblingSort(tx, siblingsOf(restored, parentId))
  })
  return listTier2Entries(db, tableId)
}

// ── Promote to Design (invariant 7) ──────────────────────────────────────────

export interface PromoteInput {
  projectId: string
  entryIds: string[]
  target: { kind: 'new'; name: string } | { kind: 'existing'; dimensionId: string }
}

export interface PromoteOutcome {
  dimensionId: string
  // Non-null only when a new dimension was created (undo must remove it).
  createdDimension: DimensionRow | null
  createdParameters: ParameterRow[]
  // Entries skipped because a live parameter already links to them.
  skippedEntryIds: string[]
}

// Live parameters (across all dimensions) whose source_entry_id is in the set —
// used both to skip already-linked entries on re-promote and to find the
// parameters that a to-be-deleted entry subtree links to.
export async function listParametersBySourceEntries(
  db: Querier,
  entryIds: readonly string[],
): Promise<ParameterRow[]> {
  if (entryIds.length === 0) return []
  return db
    .select()
    .from(parameters)
    .where(and(inArray(parameters.sourceEntryId, [...entryIds]), isNull(parameters.deletedAt)))
}

// Seeds (kind 'new') or extends (kind 'existing') a root-canvas dimension with
// one parameter per selected entry, skipping entries already linked. Returns
// everything the command log needs to undo the whole gesture as one step.
export async function promoteEntries(db: Database, input: PromoteInput): Promise<PromoteOutcome> {
  const { projectId, entryIds, target } = input

  let createdDimension: DimensionRow | null = null
  let dimensionId: string
  // Issue 078 step 2 — hoisted OUT of the `target.kind === 'new'` branch
  // below: workspaceId used to be computed only there, so the far more
  // common `existing` branch (promoting into an already-created dimension)
  // crashed on parameters' new NOT NULL workspace_id constraint. Both
  // branches now resolve it the same way, just from a different starting
  // point (a fresh dimension already carries it; an existing one is looked
  // up the same way addParameter does).
  let workspaceId: string
  // Read-only target resolution stays on `db` — it depends on no write below.
  // For a 'new' dimension, the id is generated here so `dimensionId` is definitely
  // assigned before the transaction (the INSERT itself runs on `tx` inside it).
  let dimensionInsert: typeof dimensions.$inferInsert | null = null
  if (target.kind === 'new') {
    const existingDims = await listDimensions(db, projectId)
    workspaceId = await projectWorkspaceId(db, projectId)
    // Issue 090 — promotion seeds a root-canvas dimension; stamp the root canvas.
    const canvasId = await rootCanvasId(db, projectId)
    dimensionId = uuidv7()
    dimensionInsert = {
      id: dimensionId,
      projectId,
      workspaceId,
      canvasId,
      name: target.name,
      color: paletteColor(existingDims.length),
      sort: existingDims.length,
    }
  } else {
    dimensionId = target.dimensionId
    workspaceId = await dimensionWorkspaceId(db, dimensionId)
  }

  const skippedEntryIds: string[] = []
  const createdParameters: ParameterRow[] = []

  // 107 P2 — the (optional) new-dimension INSERT and every parameter INSERT commit
  // as one unit: a mid-sequence failure must not leave a dimension seeded with
  // only some of its parameters (invariant 7 links entries ↔ parameters). Reads
  // inside the callback use `tx` so they see the uncommitted dimension/parameters.
  await db.transaction(async (tx) => {
    if (dimensionInsert) {
      const rows = await tx.insert(dimensions).values(dimensionInsert).returning()
      createdDimension = firstOrThrow(rows)
    }

    const alreadyLinked = new Set(
      (await listParametersBySourceEntries(tx, entryIds)).map((p) => p.sourceEntryId),
    )
    let sort = (await listParameters(tx, dimensionId)).length
    for (const entryId of entryIds) {
      if (alreadyLinked.has(entryId)) {
        skippedEntryIds.push(entryId)
        continue
      }
      const entryRows = await tx.select().from(tier2Entries).where(eq(tier2Entries.id, entryId)).limit(1)
      const entry = entryRows[0]
      if (!entry) continue
      const inserted = await tx
        .insert(parameters)
        .values({ id: uuidv7(), dimensionId, workspaceId, name: entry.name, sort, sourceEntryId: entryId })
        .returning()
      createdParameters.push(firstOrThrow(inserted))
      sort += 1
    }
  })

  return { dimensionId, createdDimension, createdParameters, skippedEntryIds }
}

export interface PromotedLink {
  entryId: string
  parameterId: string
  dimensionId: string
  dimensionName: string
}

// Every live root-canvas parameter that carries a source_entry_id, with its
// dimension's current name — powers the `→ Stake` source badge on 2nd-Tier
// entries (both sides of the link stay visible, invariant 7).
export async function listPromotedLinks(db: Database, projectId: string): Promise<PromotedLink[]> {
  const dims = await listDimensions(db, projectId)
  const dimById = new Map(dims.map((d) => [d.id, d]))
  const linkedParams = await db
    .select()
    .from(parameters)
    .where(and(isNotNull(parameters.sourceEntryId), isNull(parameters.deletedAt)))
  const out: PromotedLink[] = []
  for (const p of linkedParams) {
    const dim = dimById.get(p.dimensionId)
    if (dim && p.sourceEntryId) {
      out.push({ entryId: p.sourceEntryId, parameterId: p.id, dimensionId: dim.id, dimensionName: dim.name })
    }
  }
  return out
}

// ── Linked-parameter resolution ──────────────────────────────────────────────

export async function countBindingsForParameter(db: Database, parameterId: string): Promise<number> {
  const rows = await db
    .select()
    .from(bindings)
    .where(and(eq(bindings.parameterId, parameterId), isNull(bindings.deletedAt)))
  return rows.length
}

// "Keep parameter as unlinked copy" — the parameter survives, its source link
// is cleared so deleting the entry leaves no orphan reference. Returns the
// prior (id → entryId) pairs so undo can re-link.
export async function unlinkParametersFromEntries(
  db: Database,
  parameterIds: readonly string[],
): Promise<{ id: string; sourceEntryId: string | null }[]> {
  if (parameterIds.length === 0) return []
  const before = await db
    .select()
    .from(parameters)
    .where(inArray(parameters.id, [...parameterIds]))
  await db
    .update(parameters)
    .set({ sourceEntryId: null, updatedAt: now() })
    .where(inArray(parameters.id, [...parameterIds]))
  return before.map((p) => ({ id: p.id, sourceEntryId: p.sourceEntryId }))
}

export async function relinkParameters(
  db: Database,
  links: readonly { id: string; sourceEntryId: string | null }[],
): Promise<void> {
  // 107 P5 — the whole re-link loop commits as one unit: a mid-loop failure must
  // not leave some parameters re-linked to their source entry and others not
  // (this is the exact inverse of unlinkParametersFromEntries — undo restores
  // every link or none, keeping invariant 7's entry↔parameter pairing whole).
  await db.transaction(async (tx) => {
    for (const link of links) {
      await tx
        .update(parameters)
        .set({ sourceEntryId: link.sourceEntryId, updatedAt: now() })
        .where(eq(parameters.id, link.id))
    }
  })
}

export interface DeleteParametersResult {
  affectedContextIds: string[]
  deletedBindings: BindingRow[]
  // Enough to restore each parameter (id + dimensionId + prior linkage) on undo.
  removedParameters: { id: string; dimensionId: string; sourceEntryId: string | null }[]
}

// "Delete parameter — unbinds N contexts" — hard-deletes every binding pointing
// at the parameter (bindings carry no deleted_at, schema.ts), recomputes the
// affected contexts' tuple hashes, then soft-deletes the parameter. Returns the
// removed bindings + parameters so the caller can restore both on undo.
export async function deleteParametersUnbinding(
  db: Database,
  parameterIds: readonly string[],
): Promise<DeleteParametersResult> {
  const affected = new Set<string>()
  const deletedBindings: BindingRow[] = []
  const removedParameters: DeleteParametersResult['removedParameters'] = []
  // 107 P5 — per parameter this hard-deletes its bindings AND soft-deletes the
  // parameter (via removeParameter, composed on `tx` — NOT its own transaction),
  // then recomputes every affected context's tuple hash. All of it commits as
  // one unit: a mid-sequence failure must not leave bindings hard-deleted (they
  // carry no deleted_at — schema.ts, so a partial commit is unrecoverable) while
  // the parameter they pointed at survives. Reads inside the callback use `tx`.
  await db.transaction(async (tx) => {
    for (const parameterId of parameterIds) {
      const paramRows = await tx.select().from(parameters).where(eq(parameters.id, parameterId)).limit(1)
      const param = paramRows[0]
      if (!param) continue
      const boundRows = await tx
        .select()
        .from(bindings)
        .where(and(eq(bindings.parameterId, parameterId), isNull(bindings.deletedAt)))
      deletedBindings.push(...boundRows)
      for (const b of boundRows) affected.add(b.contextId)
      await tx.delete(bindings).where(eq(bindings.parameterId, parameterId))
      await removeParameter(tx, param.dimensionId, parameterId)
      removedParameters.push({ id: param.id, dimensionId: param.dimensionId, sourceEntryId: param.sourceEntryId })
    }
    for (const contextId of affected) await recomputeTupleHash(tx, contextId)
  })
  return { affectedContextIds: [...affected], deletedBindings, removedParameters }
}

// Undo of deleteParametersUnbinding: un-soft-delete the parameters (restoring
// linkage), reinsert the exact bindings, recompute the affected tuple hashes.
export async function restoreParametersWithBindings(
  db: Database,
  removedParameters: readonly { id: string; dimensionId: string; sourceEntryId: string | null }[],
  deletedBindings: readonly BindingRow[],
): Promise<string[]> {
  // 107 P5 — the exact inverse of deleteParametersUnbinding: un-soft-delete the
  // parameters (restoring linkage), reinsert the captured bindings, recompute
  // the affected tuple hashes. All commit as one unit so undo is atomic — a
  // mid-sequence failure must not revive the parameters while their bindings are
  // only partly reinserted. `affected` derives purely from the input, so it is
  // computed outside the callback and returned after commit.
  const affected = [...new Set(deletedBindings.map((b) => b.contextId))]
  await db.transaction(async (tx) => {
    for (const p of removedParameters) {
      await tx
        .update(parameters)
        .set({ deletedAt: null, sourceEntryId: p.sourceEntryId, updatedAt: now() })
        .where(eq(parameters.id, p.id))
    }
    if (deletedBindings.length > 0) {
      await tx.insert(bindings).values(
        deletedBindings.map((b) => ({
          id: b.id,
          contextId: b.contextId,
          dimensionId: b.dimensionId,
          parameterId: b.parameterId,
          // Issue 078 step 2 — reinsert the captured row's own workspaceId
          // verbatim (see revertStaleRebind's identical comment above).
          workspaceId: b.workspaceId,
          tupleHash: b.tupleHash,
        })),
      )
    }
    for (const contextId of affected) await recomputeTupleHash(tx, contextId)
  })
  return affected
}
