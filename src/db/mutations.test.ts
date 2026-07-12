import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import { bindings } from './schema'
import {
  addDimension,
  addParameter,
  addTier2Entry,
  addTier2Table,
  archiveProject,
  bindParameter,
  createContext,
  createProject,
  deleteParametersUnbinding,
  listArchivedProjects,
  listProjects,
  promoteEntries,
  renameProject,
  restoreParametersWithBindings,
  restoreProject,
  revertStaleRebind,
} from './mutations'

async function freshDb() {
  const { db } = await openDatabase('memory://')
  return db
}

describe('project mutations', () => {
  it('createProject returns a row with a UUIDv7 id and timestamps', async () => {
    const db = await freshDb()
    const row = await createProject(db, { name: 'Tavalo' })
    // UUIDv7: version nibble is 7
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(row.name).toBe('Tavalo')
    expect(row.createdAt).toBeTruthy()
    expect(row.updatedAt).toBeTruthy()
    expect(row.deletedAt).toBeNull()
  })

  it('listProjects returns most recently touched first and excludes archived', async () => {
    const db = await freshDb()
    const a = await createProject(db, { name: 'Alpha' })
    const b = await createProject(db, { name: 'Beta' })
    await renameProject(db, a.id, 'Alpha 2')

    let rows = await listProjects(db)
    expect(rows.map((r) => r.name)).toEqual(['Alpha 2', 'Beta'])

    await archiveProject(db, b.id)
    rows = await listProjects(db)
    expect(rows.map((r) => r.name)).toEqual(['Alpha 2'])
  })

  it('archiveProject soft-deletes; restoreProject brings it back', async () => {
    const db = await freshDb()
    const row = await createProject(db, { name: 'Tavalo' })
    await archiveProject(db, row.id)
    expect(await listProjects(db)).toHaveLength(0)

    await restoreProject(db, row.id)
    const rows = await listProjects(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(row.id)
  })

  // Issue 070 (fixes #9) — listProjects only ever surfaces live rows; nothing
  // read the archived side of the same soft-delete until now, so a project
  // archived more than one action ago was unreachable.
  it('listArchivedProjects returns all archived rows, most-recently-archived first', async () => {
    const db = await freshDb()
    const a = await createProject(db, { name: 'A' })
    const b = await createProject(db, { name: 'B' })
    const c = await createProject(db, { name: 'C' })

    await archiveProject(db, a.id)
    await new Promise((r) => setTimeout(r, 5))
    await archiveProject(db, c.id)
    await new Promise((r) => setTimeout(r, 5))
    await archiveProject(db, b.id)

    const archived = await listArchivedProjects(db)
    expect(archived.map((r) => r.id)).toEqual([b.id, c.id, a.id])

    expect(await listProjects(db)).toEqual([])
  })

  it('renameProject updates name and bumps updated_at', async () => {
    const db = await freshDb()
    const row = await createProject(db, { name: 'Old' })
    await new Promise((r) => setTimeout(r, 5))
    const renamed = await renameProject(db, row.id, 'New')
    expect(renamed.name).toBe('New')
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThan(
      new Date(row.updatedAt).getTime(),
    )
  })
})

// Issue 078 step 2 (migration 0015) — parameters/bindings/tier2_entries
// gained their own denormalized workspace_id column so Electric's read-path
// shape can scope them by a literal predicate instead of the experimental
// allow_subqueries subquery (src/domain/syncScope.ts). Every insert site for
// these three tables must stamp a real workspaceId, resolved from the
// nearest workspace_id-bearing ancestor — exactly like projectWorkspaceId
// already does for the six tables migration 0008 covered.
describe('issue 078 step 2 — workspace_id propagation on child tables', () => {
  it('addParameter stamps the owning dimension\'s workspaceId', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    expect(param.workspaceId).toBe(dim.workspaceId)
  })

  it('bindParameter stamps the owning context\'s workspaceId on insert', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)
    const rows = await bindParameter(db, ctx.id, dim.id, param.id)
    expect(rows[0]?.workspaceId).toBe(ctx.workspaceId)
  })

  it('addTier2Entry stamps the owning table\'s workspaceId', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const table = await addTier2Table(db, project.id, 'Value')
    const entry = await addTier2Entry(db, table.id, null, 'Buyers')
    expect(entry.workspaceId).toBe(table.workspaceId)
  })

  // The TRAP the plan calls out: workspaceId used to be computed only inside
  // promoteEntries' `target.kind === 'new'` branch — the far more common
  // `existing` branch (promoting into an already-created dimension) would
  // otherwise crash on the NOT NULL constraint.
  it('promoteEntries stamps workspaceId on created parameters for BOTH the new-dimension and existing-dimension branches', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const table = await addTier2Table(db, project.id, 'Value')
    const entryA = await addTier2Entry(db, table.id, null, 'Buyers')
    const entryB = await addTier2Entry(db, table.id, null, 'Sellers')

    const created = await promoteEntries(db, {
      projectId: project.id,
      entryIds: [entryA.id],
      target: { kind: 'new', name: 'Value' },
    })
    expect(created.createdParameters[0]?.workspaceId).toBe(created.createdDimension?.workspaceId)

    const promotedExisting = await promoteEntries(db, {
      projectId: project.id,
      entryIds: [entryB.id],
      target: { kind: 'existing', dimensionId: created.dimensionId },
    })
    expect(promotedExisting.createdParameters[0]?.workspaceId).toBe(created.createdDimension?.workspaceId)
  })

  it('revertStaleRebind reinserts a retired binding with its captured workspaceId', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)
    const [binding] = await bindParameter(db, ctx.id, dim.id, param.id)
    if (!binding) throw new Error('expected a binding')

    // revertStaleRebind's job is to re-insert exactly the captured row —
    // hard-delete it first to simulate the "retired" state openChildCanvas
    // would have left it in.
    await db.delete(bindings).where(eq(bindings.id, binding.id))
    await revertStaleRebind(db, {
      childDimensionId: dim.id,
      fromParameterId: param.id,
      toParameterId: param.id,
      fromName: 'Comfort',
      toName: 'Comfort',
      retiredBindings: [binding],
    })

    const reinserted = await db.select().from(bindings).where(eq(bindings.id, binding.id))
    expect(reinserted[0]?.workspaceId).toBe(ctx.workspaceId)
  })

  it('restoreParametersWithBindings reinserts a deleted binding with its captured workspaceId', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)
    const [binding] = await bindParameter(db, ctx.id, dim.id, param.id)
    if (!binding) throw new Error('expected a binding')

    const result = await deleteParametersUnbinding(db, [param.id])
    expect(result.deletedBindings).toHaveLength(1)

    await restoreParametersWithBindings(db, result.removedParameters, result.deletedBindings)

    const restored = await db.select().from(bindings).where(eq(bindings.id, binding.id))
    expect(restored[0]?.workspaceId).toBe(ctx.workspaceId)
  })
})
