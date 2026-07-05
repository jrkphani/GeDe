import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { dimensions, projects } from './schema'
import { paletteColor } from '../theme/palette'

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
  return rows[0] as ProjectRow
}

export async function renameProject(db: Database, id: string, name: string): Promise<ProjectRow> {
  const rows = await db
    .update(projects)
    .set({ name, updatedAt: now() })
    .where(eq(projects.id, id))
    .returning()
  return rows[0] as ProjectRow
}

export async function archiveProject(db: Database, id: string): Promise<ProjectRow> {
  const rows = await db
    .update(projects)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(projects.id, id))
    .returning()
  return rows[0] as ProjectRow
}

export async function restoreProject(db: Database, id: string): Promise<ProjectRow> {
  const rows = await db
    .update(projects)
    .set({ deletedAt: null, updatedAt: now() })
    .where(eq(projects.id, id))
    .returning()
  return rows[0] as ProjectRow
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
  return rows[0] as DimensionRow
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
  return rows[0] as DimensionRow
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
  return rows[0] as DimensionRow
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
  const [moved] = rows.splice(from, 1)
  rows.splice(target, 0, moved as DimensionRow)
  await rewriteSort(db, rows)
  return listDimensions(db, projectId)
}

export async function removeDimension(
  db: Database,
  projectId: string,
  id: string,
): Promise<DimensionRow[]> {
  const rows = await listDimensions(db, projectId)
  if (rows.length <= 2) throw new DimensionFloorError()
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
