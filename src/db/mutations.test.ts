import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import { bindings, canvases, contexts, dimensions, parameters, projects } from './schema'
import {
  addDimension,
  addParameter,
  addTier1Prop,
  addTier2Entry,
  addTier2Table,
  archiveCanvasCascade,
  archiveProject,
  bindParameter,
  createCanvas,
  createContext,
  createProject,
  deleteParametersUnbinding,
  getTier1Purpose,
  listArchivedProjects,
  listCanvases,
  listDimensions,
  listParameters,
  listProjects,
  listTier1Props,
  listTier2Tables,
  openChildCanvas,
  promoteEntries,
  relinkParameters,
  removeDimension,
  renameProject,
  reorderCanvas,
  reorderDimension,
  reorderParameter,
  reorderTier1Prop,
  reorderTier2Table,
  restoreCanvasCascade,
  restoreDimension,
  restoreParametersWithBindings,
  restoreProject,
  revertStaleRebind,
  setTier1ExistingScenario,
  setTier1Purpose,
  unbindParameter,
  unlinkParametersFromEntries,
} from './mutations'

async function freshDb() {
  const { db } = await openDatabase('memory://')
  return db
}

type AnyFn = (...args: unknown[]) => unknown

// 107 P3 — a Database facade that throws on its Nth `.update()` call, counting
// across the top-level handle AND any transaction handle it hands a callback
// (both share one counter). Injects a mid-densify write failure so each reorder
// mutation's multi-UPDATE `sort` rewrite can be proven to roll back as one unit.
// (Mirror of the helper in tier2.test.ts.)
function dbFailingOnNthUpdate<T extends object>(real: T, n: number): T {
  let calls = 0
  const wrap = <U extends object>(target: U): U =>
    new Proxy(target, {
      get(t, prop) {
        const bag = t as Record<PropertyKey, unknown>
        if (prop === 'update') {
          return (...args: unknown[]) => {
            calls += 1
            if (calls === n) throw new Error('injected update failure')
            return (bag.update as AnyFn)(...args)
          }
        }
        if (prop === 'transaction') {
          return (cb: (tx: object) => unknown, ...rest: unknown[]) =>
            (bag.transaction as AnyFn)((tx: object) => cb(wrap(tx)), ...rest)
        }
        const value = bag[prop]
        return typeof value === 'function' ? (value as AnyFn).bind(t) : value
      },
    })
  return wrap(real)
}

// 107 P5 — the insert-side twin of dbFailingOnNthUpdate (mirror of the helper in
// tier2.test.ts): throws on the Nth `.insert()`, counted across the top-level
// handle AND any transaction handle it hands a callback (both share one
// counter). Used to prove the INSERT-heavy P5 wraps (createProject,
// revertStaleRebind, restoreParametersWithBindings, openChildCanvas) roll back
// their earlier writes when a later insert in the same sequence fails.
function dbFailingOnNthInsert<T extends object>(real: T, n: number): T {
  let calls = 0
  const wrap = <U extends object>(target: U): U =>
    new Proxy(target, {
      get(t, prop) {
        const bag = t as Record<PropertyKey, unknown>
        if (prop === 'insert') {
          return (...args: unknown[]) => {
            calls += 1
            if (calls === n) throw new Error('injected insert failure')
            return (bag.insert as AnyFn)(...args)
          }
        }
        if (prop === 'transaction') {
          return (cb: (tx: object) => unknown, ...rest: unknown[]) =>
            (bag.transaction as AnyFn)((tx: object) => cb(wrap(tx)), ...rest)
        }
        const value = bag[prop]
        return typeof value === 'function' ? (value as AnyFn).bind(t) : value
      },
    })
  return wrap(real)
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

// Issue 081 test-first plan item 2 — the NOT NULL subtlety this issue's own
// spec calls out: tier1_purpose.body is NOT NULL (schema.ts), so a naive
// setTier1ExistingScenario that inserts {id, projectId, workspaceId,
// existingScenario} on a project's FIRST-EVER tier1_purpose write (no row
// exists yet) would violate that constraint. Red today because the function
// doesn't exist yet; the trap is exactly what this test is for.
describe('setTier1ExistingScenario — NOT NULL subtlety (issue 081)', () => {
  it('succeeds on a project with no existing tier1_purpose row, leaving body as \'\' (not a NOT NULL violation)', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'Tavalo' })
    expect(await getTier1Purpose(db, project.id)).toBeNull()

    const lexicalJson = JSON.stringify({
      root: { children: [{ type: 'paragraph', children: [], version: 1 }], type: 'root', version: 1 },
    })
    const row = await setTier1ExistingScenario(db, project.id, lexicalJson)

    expect(row?.body).toBe('')
    expect(row?.existingScenario).toBe(lexicalJson)
  })

  it('preserves an already-written body unchanged when a purpose row already exists', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'Tavalo' })
    await setTier1Purpose(db, project.id, 'A better way to sit together.')

    const lexicalJson = JSON.stringify({
      root: { children: [{ type: 'paragraph', children: [], version: 1 }], type: 'root', version: 1 },
    })
    const row = await setTier1ExistingScenario(db, project.id, lexicalJson)

    expect(row?.body).toBe('A better way to sit together.')
    expect(row?.existingScenario).toBe(lexicalJson)
  })

  it('is a true upsert on the same row (project_id unique index) — never a second tier1_purpose row', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'Tavalo' })

    const first = await setTier1ExistingScenario(db, project.id, 'json-1')
    const second = await setTier1ExistingScenario(db, project.id, 'json-2')

    expect(second?.id).toBe(first?.id)
    expect(second?.existingScenario).toBe('json-2')
  })

  it('setting existingScenario back to null clears it without touching body', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'Tavalo' })
    await setTier1Purpose(db, project.id, 'Purpose text')
    await setTier1ExistingScenario(db, project.id, 'some-json')

    const cleared = await setTier1ExistingScenario(db, project.id, null)
    expect(cleared?.existingScenario).toBeNull()
    expect(cleared?.body).toBe('Purpose text')
  })
})

// 107 P3 — each reorder densifies `sort` (tier1 also `rank`) across a loop of
// UPDATEs, one per row whose ordinal moved. Dragging the last row to the head of
// a 3-row lane changes all three ordinals ⇒ 3 UPDATEs. Injecting a throw on the
// 2nd proves the sequence is atomic: the 1st UPDATE auto-commits un-wrapped
// (partial re-sort — test FAILS), but rolls back once wrapped in a transaction
// (re-read via the REAL db is byte-identical to the pre-move snapshot).
describe('107 P3 — reorder mutations roll back fully on a mid-densify UPDATE failure', () => {
  it('reorderCanvas rolls back the whole sort rewrite (atomicity)', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' }) // seeds root canvas #1
    await createCanvas(db, project.id, 'B')
    const c = await createCanvas(db, project.id, 'C')

    const snapshot = await listCanvases(db, project.id)
    expect(snapshot).toHaveLength(3)

    await expect(
      reorderCanvas(dbFailingOnNthUpdate(db, 2), project.id, c.id, 0),
    ).rejects.toThrow('injected update failure')

    expect(await listCanvases(db, project.id)).toEqual(snapshot)
  })

  it('reorderDimension rolls back the whole sort rewrite (atomicity)', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    await addDimension(db, project.id)
    await addDimension(db, project.id)
    const d3 = await addDimension(db, project.id)

    const snapshot = await listDimensions(db, project.id)
    expect(snapshot).toHaveLength(3)

    await expect(
      reorderDimension(dbFailingOnNthUpdate(db, 2), project.id, d3.id, 0),
    ).rejects.toThrow('injected update failure')

    expect(await listDimensions(db, project.id)).toEqual(snapshot)
  })

  it('reorderParameter rolls back the whole sort rewrite (atomicity)', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    await addParameter(db, dim.id, 'A')
    await addParameter(db, dim.id, 'B')
    const c = await addParameter(db, dim.id, 'C')

    const snapshot = await listParameters(db, dim.id)
    expect(snapshot).toHaveLength(3)

    await expect(
      reorderParameter(dbFailingOnNthUpdate(db, 2), dim.id, c.id, 0),
    ).rejects.toThrow('injected update failure')

    expect(await listParameters(db, dim.id)).toEqual(snapshot)
  })

  it('reorderTier1Prop rolls back the whole rank+sort rewrite (atomicity)', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    await addTier1Prop(db, project.id, 'A')
    await addTier1Prop(db, project.id, 'B')
    const c = await addTier1Prop(db, project.id, 'C')

    const snapshot = await listTier1Props(db, project.id)
    expect(snapshot).toHaveLength(3)

    await expect(
      reorderTier1Prop(dbFailingOnNthUpdate(db, 2), project.id, c.id, 0),
    ).rejects.toThrow('injected update failure')

    expect(await listTier1Props(db, project.id)).toEqual(snapshot)
  })

  it('reorderTier2Table rolls back the whole sort rewrite (atomicity)', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    await addTier2Table(db, project.id, 'A')
    await addTier2Table(db, project.id, 'B')
    const c = await addTier2Table(db, project.id, 'C')

    const snapshot = await listTier2Tables(db, project.id)
    expect(snapshot).toHaveLength(3)

    await expect(
      reorderTier2Table(dbFailingOnNthUpdate(db, 2), project.id, c.id, 0),
    ).rejects.toThrow('injected update failure')

    expect(await listTier2Tables(db, project.id)).toEqual(snapshot)
  })
})

// 107 P4 — the four cascade mutations each fan a single gesture across multiple
// tables (canvas/dimensions/contexts/bindings). A mid-cascade UPDATE failure
// must roll back EVERY table, not just the tables written after the failure.
// Each test snapshots all affected tables via the REAL db, injects a throw on an
// UPDATE that lands AFTER the first write, and asserts a full multi-table
// re-read is byte-identical to the snapshot. Un-wrapped, the first write
// auto-commits and the re-read diverges (RED); wrapped in one transaction it
// rolls back whole (GREEN).
describe('107 P4 — cascade mutations roll back across all tables on a mid-cascade UPDATE failure', () => {
  // Full state of every cascade-touched table, ordered deterministically so two
  // snapshots compare by value (uuidv7 ids are monotonic → stable order).
  async function snapshotTables(db: Awaited<ReturnType<typeof freshDb>>) {
    return {
      canvases: await db.select().from(canvases).orderBy(asc(canvases.id)),
      dimensions: await db.select().from(dimensions).orderBy(asc(dimensions.id)),
      contexts: await db.select().from(contexts).orderBy(asc(contexts.id)),
      bindings: await db.select().from(bindings).orderBy(asc(bindings.id)),
    }
  }

  it('archiveCanvasCascade rolls back the canvas tombstone when a later cascade UPDATE fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' }) // seeds root canvas #1
    const canvasB = await createCanvas(db, project.id, 'B')
    const d1 = await addDimension(db, project.id, undefined, canvasB.id)
    await addDimension(db, project.id, undefined, canvasB.id)
    const ctx = await createContext(db, project.id, null, canvasB.id)
    const param = await addParameter(db, d1.id, 'X')
    await bindParameter(db, ctx.id, d1.id, param.id)

    const snapshot = await snapshotTables(db)
    // Cascade order: canvas UPDATE (#1), dimensions UPDATE (#2 → throws),
    // contexts, bindings. The canvas tombstone is already applied when #2 fails.
    await expect(
      archiveCanvasCascade(dbFailingOnNthUpdate(db, 2), canvasB.id),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('restoreCanvasCascade rolls back the canvas revive when a later cascade UPDATE fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const canvasB = await createCanvas(db, project.id, 'B')
    const d1 = await addDimension(db, project.id, undefined, canvasB.id)
    await addDimension(db, project.id, undefined, canvasB.id)
    const ctx = await createContext(db, project.id, null, canvasB.id)
    const param = await addParameter(db, d1.id, 'X')
    await bindParameter(db, ctx.id, d1.id, param.id)

    const captured = await archiveCanvasCascade(db, canvasB.id)
    // Snapshot the fully-tombstoned state; a failed restore must preserve it.
    const snapshot = await snapshotTables(db)
    // Restore order: canvas un-delete (#1), dimensions un-delete (#2 → throws).
    await expect(
      restoreCanvasCascade(dbFailingOnNthUpdate(db, 2), captured),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('removeDimension rolls back the binding tombstone when the dimension UPDATE fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const d1 = await addDimension(db, project.id)
    await addDimension(db, project.id)
    await addDimension(db, project.id) // 3 dims → floor (2) not tripped by removing one
    const ctx = await createContext(db, project.id)
    const param = await addParameter(db, d1.id, 'X')
    await bindParameter(db, ctx.id, d1.id, param.id)

    const snapshot = await snapshotTables(db)
    // Cascade order: binding tombstone (#1), tuple-hash recompute (no UPDATE —
    // the only binding is now tombstoned), dimension tombstone (#2 → throws).
    // The binding tombstone is already applied when #2 fails.
    await expect(
      removeDimension(dbFailingOnNthUpdate(db, 2), project.id, d1.id),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('restoreDimension rolls back the dimension revive when a later cascade UPDATE fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const d1 = await addDimension(db, project.id)
    await addDimension(db, project.id)
    await addDimension(db, project.id)
    const ctx = await createContext(db, project.id)
    const param = await addParameter(db, d1.id, 'X')
    await bindParameter(db, ctx.id, d1.id, param.id)

    const orderedIds = (await listDimensions(db, project.id)).map((d) => d.id)
    const { deletedBindings } = await removeDimension(db, project.id, d1.id)
    // Snapshot the post-remove state (d1 + its binding tombstoned); a failed
    // restore must preserve it exactly.
    const snapshot = await snapshotTables(db)
    // Restore order: dimension un-delete (#1), sibling-sort rewrite (#2 → throws
    // on the first row whose sort ordinal shifts). The un-delete is applied when
    // #2 fails; a full rollback re-tombstones it.
    await expect(
      restoreDimension(dbFailingOnNthUpdate(db, 2), project.id, d1.id, orderedIds, deletedBindings),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })
})

// 107 P5 (final) — the remaining binding/parameter multi-write mutations. Each
// fans a single gesture across ≥2 writes (a binding/param write plus the
// tuple-hash recompute it invalidates, or an INSERT following an UPDATE/DELETE).
// A mid-sequence failure must roll back EVERY write, not just the ones after the
// failure. Each test snapshots all affected tables via the REAL db, injects a
// throw on a write that lands AFTER the first, and asserts a full multi-table
// re-read is byte-identical to the snapshot. Un-wrapped, the first write
// auto-commits and the re-read diverges (RED); wrapped in one transaction it
// rolls back whole (GREEN).
describe('107 P5 — binding/param mutations roll back fully on a mid-sequence write failure', () => {
  // Every P5-touched table, ordered deterministically (uuidv7 ids are monotonic
  // → stable order) so two snapshots compare by value.
  async function snapshotTables(db: Awaited<ReturnType<typeof freshDb>>) {
    return {
      projects: await db.select().from(projects).orderBy(asc(projects.id)),
      canvases: await db.select().from(canvases).orderBy(asc(canvases.id)),
      dimensions: await db.select().from(dimensions).orderBy(asc(dimensions.id)),
      parameters: await db.select().from(parameters).orderBy(asc(parameters.id)),
      contexts: await db.select().from(contexts).orderBy(asc(contexts.id)),
      bindings: await db.select().from(bindings).orderBy(asc(bindings.id)),
    }
  }

  it('bindParameter rolls back the inserted binding when the tuple-hash recompute fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)

    const snapshot = await snapshotTables(db) // no bindings yet
    // Write order: binding INSERT, then recompute's UPDATE (#1 → throws). The
    // inserted binding is already applied when the recompute fails.
    await expect(
      bindParameter(dbFailingOnNthUpdate(db, 1), ctx.id, dim.id, param.id),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('unbindParameter rolls back the binding tombstone when the tuple-hash recompute fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim1 = await addDimension(db, project.id)
    const dim2 = await addDimension(db, project.id)
    const p1 = await addParameter(db, dim1.id, 'A')
    const p2 = await addParameter(db, dim2.id, 'B')
    const ctx = await createContext(db, project.id)
    await bindParameter(db, ctx.id, dim1.id, p1.id)
    await bindParameter(db, ctx.id, dim2.id, p2.id)

    const snapshot = await snapshotTables(db) // two live bindings
    // Write order: dim1 binding tombstone UPDATE (#1), then recompute rehashes
    // the surviving dim2 binding UPDATE (#2 → throws). The tombstone is already
    // applied when #2 fails.
    await expect(
      unbindParameter(dbFailingOnNthUpdate(db, 2), ctx.id, dim1.id),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('deleteParametersUnbinding rolls back the hard-deleted bindings when the param soft-delete fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)
    await bindParameter(db, ctx.id, dim.id, param.id)

    const snapshot = await snapshotTables(db) // one live binding, one live param
    // Write order: bindings DELETE (hard, no deleted_at — schema.ts), then
    // removeParameter's soft-delete UPDATE (#1 → throws). The hard-deleted
    // binding is already gone when #1 fails — un-wrapped it stays gone.
    await expect(
      deleteParametersUnbinding(dbFailingOnNthUpdate(db, 1), [param.id]),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('revertStaleRebind rolls back the dimension re-point when the binding re-insert fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const p1 = await addParameter(db, dim.id, 'From')
    const p2 = await addParameter(db, dim.id, 'To')
    const ctx = await createContext(db, project.id)
    const [binding] = await bindParameter(db, ctx.id, dim.id, p1.id)
    if (!binding) throw new Error('expected a binding')
    // Simulate the post-rebind state openChildCanvas would have left: the
    // dimension now sources p2, and its retired binding was hard-deleted.
    await db.update(dimensions).set({ sourceParamId: p2.id }).where(eq(dimensions.id, dim.id))
    await db.delete(bindings).where(eq(bindings.id, binding.id))

    const snapshot = await snapshotTables(db) // dim.sourceParamId === p2, no binding
    // Write order: dimension re-point UPDATE (sourceParamId → p1), then the
    // retired-binding INSERT (#1 → throws). The re-point is already applied when
    // the insert fails.
    await expect(
      revertStaleRebind(dbFailingOnNthInsert(db, 1), {
        childDimensionId: dim.id,
        fromParameterId: p1.id,
        toParameterId: p2.id,
        fromName: 'From',
        toName: 'To',
        retiredBindings: [binding],
      }),
    ).rejects.toThrow('injected insert failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('relinkParameters rolls back the whole re-link loop on a mid-loop UPDATE failure', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const table = await addTier2Table(db, project.id, 'Value')
    const entryA = await addTier2Entry(db, table.id, null, 'Buyers')
    const entryB = await addTier2Entry(db, table.id, null, 'Sellers')
    const promoted = await promoteEntries(db, {
      projectId: project.id,
      entryIds: [entryA.id, entryB.id],
      target: { kind: 'new', name: 'Value' },
    })
    const ids = promoted.createdParameters.map((p) => p.id)
    expect(ids).toHaveLength(2)
    // Clear the source links so relink is a genuine two-row rewrite.
    const links = await unlinkParametersFromEntries(db, ids)

    const snapshot = await snapshotTables(db) // both params' sourceEntryId now null
    // Two UPDATEs, one per link; inject on the 2nd. The 1st is already applied
    // when it fails — un-wrapped that leaves one param re-linked, one not.
    await expect(
      relinkParameters(dbFailingOnNthUpdate(db, 2), links),
    ).rejects.toThrow('injected update failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('restoreParametersWithBindings rolls back the param revive when the binding re-insert fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContext(db, project.id)
    await bindParameter(db, ctx.id, dim.id, param.id)
    const removed = await deleteParametersUnbinding(db, [param.id])
    expect(removed.deletedBindings).toHaveLength(1)

    const snapshot = await snapshotTables(db) // param soft-deleted, binding gone
    // Write order: param revive UPDATE (clears deleted_at), then the binding
    // re-INSERT (#1 → throws). The revive is already applied when the insert
    // fails — un-wrapped that leaves the param live again with no binding.
    await expect(
      restoreParametersWithBindings(
        dbFailingOnNthInsert(db, 1),
        removed.removedParameters,
        removed.deletedBindings,
      ),
    ).rejects.toThrow('injected insert failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('createProject rolls back the project insert when the root-canvas seed insert fails', async () => {
    const db = await freshDb()
    // Seed a workspace + baseline project so createProject can be given an
    // explicit workspaceId (skipping getOrCreateDefaultWorkspace, which would
    // otherwise insert a workspace and shift the insert counter).
    const seed = await createProject(db, { name: 'Seed' })

    const snapshot = await snapshotTables(db) // exactly one project + its root canvas
    // Insert order: projects INSERT (#1), then root-canvas INSERT (#2 → throws).
    // The project row is already applied when the canvas seed fails.
    await expect(
      createProject(dbFailingOnNthInsert(db, 2), { name: 'X', workspaceId: seed.workspaceId }),
    ).rejects.toThrow('injected insert failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })

  it('openChildCanvas rolls back the child canvas + seeded dimensions when a later dimension insert fails', async () => {
    const db = await freshDb()
    const project = await createProject(db, { name: 'P' })
    const dim1 = await addDimension(db, project.id)
    const dim2 = await addDimension(db, project.id)
    const p1 = await addParameter(db, dim1.id, 'A')
    const p2 = await addParameter(db, dim2.id, 'B')
    const ctx = await createContext(db, project.id)
    await bindParameter(db, ctx.id, dim1.id, p1.id)
    await bindParameter(db, ctx.id, dim2.id, p2.id)

    const snapshot = await snapshotTables(db) // root canvas only, two root dims, no child rows
    // Insert order on first open: child-canvas INSERT (#1, via childCanvasId),
    // child dimension #1 INSERT (#2), child dimension #2 INSERT (#3 → throws).
    // The child canvas + first child dimension are already applied when #3 fails.
    await expect(
      openChildCanvas(dbFailingOnNthInsert(db, 3), ctx.id),
    ).rejects.toThrow('injected insert failure')

    expect(await snapshotTables(db)).toEqual(snapshot)
  })
})
