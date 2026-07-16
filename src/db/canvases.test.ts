import { PGlite } from '@electric-sql/pglite'
import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import { bindings, canvases, contexts, dimensions } from './schema'
import {
  addDimension,
  archiveCanvasCascade,
  bindParameter,
  addParameter,
  createCanvas,
  createContext,
  createProject,
  listCanvases,
  listContexts,
  listDimensions,
  openChildCanvas,
  restoreCanvasCascade,
  RootCanvasFloorError,
} from './mutations'

function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`)
  return value
}

// ── Schema-shape assertions (migration 0017) ─────────────────────────────────
describe('canvases migration 0017 — table shape', () => {
  it('creates the canvases table', async () => {
    const { pg } = await openDatabase('memory://')
    const res = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'canvases'`,
    )
    expect(res.rows).toHaveLength(1)
  })

  it('canvases carries FKs to projects, workspaces, and contexts', async () => {
    const { pg } = await openDatabase('memory://')
    const res = (await pg.query(
      `SELECT ccu.table_name AS ref_table, kcu.column_name AS col
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'canvases'`,
    )) as { rows: { ref_table: string; col: string }[] }
    const byCol = new Map(res.rows.map((r) => [r.col, r.ref_table]))
    expect(byCol.get('project_id')).toBe('projects')
    expect(byCol.get('workspace_id')).toBe('workspaces')
    expect(byCol.get('parent_context_id')).toBe('contexts')
  })

  it('dimensions.canvas_id and contexts.canvas_id are NOT NULL FKs to canvases', async () => {
    const { pg } = await openDatabase('memory://')
    for (const tbl of ['dimensions', 'contexts']) {
      const fk = (await pg.query(
        `SELECT ccu.table_name AS ref_table
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage ccu
             ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
            AND kcu.column_name = 'canvas_id'`,
        [tbl],
      )) as { rows: { ref_table: string }[] }
      expect(fk.rows.map((r) => r.ref_table)).toContain('canvases')

      const nn = (await pg.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'canvas_id'`,
        [tbl],
      )) as { rows: { is_nullable: string }[] }
      expect(nn.rows[0]?.is_nullable).toBe('NO')
    }
  })

  it('has a partial unique index on parent_context_id (WHERE deleted_at IS NULL AND parent_context_id IS NOT NULL)', async () => {
    const { pg } = await openDatabase('memory://')
    const res = (await pg.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'canvases'`,
    )) as { rows: { indexdef: string }[] }
    const partial = res.rows.find(
      (r) =>
        /UNIQUE/i.test(r.indexdef) &&
        r.indexdef.includes('parent_context_id') &&
        /WHERE/i.test(r.indexdef),
    )
    expect(partial, 'expected a partial unique index on parent_context_id').toBeTruthy()
    expect(partial?.indexdef).toMatch(/deleted_at/i)
    expect(partial?.indexdef).toMatch(/parent_context_id/i)
  })

  it('canvases has REPLICA IDENTITY FULL (relreplident = f)', async () => {
    const { pg } = await openDatabase('memory://')
    const res = (await pg.query(
      `SELECT relreplident FROM pg_class WHERE relname = 'canvases'`,
    )) as { rows: { relreplident: string }[] }
    expect(res.rows[0]?.relreplident).toBe('f')
  })
})

// ── Forward-path: createProject / addDimension / createContext seeding ────────
describe('canvases forward path — createProject seeds a root canvas', () => {
  it('createProject seeds exactly one root canvas (parent_context_id NULL)', async () => {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const rows = await db.select().from(canvases).where(eq(canvases.projectId, project.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.parentContextId).toBeNull()
    expect(rows[0]?.workspaceId).toBe(project.workspaceId)
    expect(rows[0]?.sort).toBe(0)
    expect(rows[0]?.deletedAt).toBeNull()
  })

  it('addDimension and createContext stamp the project root canvas_id', async () => {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const rootCanvas = must(
      (await db.select().from(canvases).where(eq(canvases.projectId, project.id)))[0],
      'root canvas',
    )
    const dim = await addDimension(db, project.id)
    const ctx = await createContext(db, project.id)
    expect(dim.canvasId).toBe(rootCanvas.id)
    expect(ctx.canvasId).toBe(rootCanvas.id)
  })

  it('two projects get independent root canvases', async () => {
    const { db } = await openDatabase('memory://')
    const a = await createProject(db, { name: 'A' })
    const b = await createProject(db, { name: 'B' })
    const ca = must((await db.select().from(canvases).where(eq(canvases.projectId, a.id)))[0], 'ca')
    const cb = must((await db.select().from(canvases).where(eq(canvases.projectId, b.id)))[0], 'cb')
    expect(ca.id).not.toBe(cb.id)
    const dimA = await addDimension(db, a.id)
    const dimB = await addDimension(db, b.id)
    expect(dimA.canvasId).toBe(ca.id)
    expect(dimB.canvasId).toBe(cb.id)
  })

  it('openChildCanvas produces a child canvas row and stamps its seeded dimensions', async () => {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const value = await addDimension(db, project.id)
    const stake = await addDimension(db, project.id)
    const comfort = await addParameter(db, value.id, 'Comfort')
    const users = await addParameter(db, stake.id, 'Users')
    const alpha = await createContext(db, project.id)
    await bindParameter(db, alpha.id, value.id, comfort.id)
    await bindParameter(db, alpha.id, stake.id, users.id)

    const { dimensions: childDims } = await openChildCanvas(db, alpha.id)
    expect(childDims).toHaveLength(2)

    const childCanvas = must(
      (await db.select().from(canvases).where(eq(canvases.parentContextId, alpha.id)))[0],
      'child canvas',
    )
    expect(childCanvas.parentContextId).toBe(alpha.id)
    expect(childCanvas.projectId).toBe(project.id)
    // every seeded child dimension carries the child canvas id
    expect(childDims.every((d) => d.canvasId === childCanvas.id)).toBe(true)
    // idempotent: re-open does not create a second child canvas
    await openChildCanvas(db, alpha.id)
    const again = await db.select().from(canvases).where(eq(canvases.parentContextId, alpha.id))
    expect(again).toHaveLength(1)
  })

  it('no dangling canvas_id — every dimension/context canvas_id resolves to a canvases row', async () => {
    const { db, pg } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const value = await addDimension(db, project.id)
    const stake = await addDimension(db, project.id)
    const comfort = await addParameter(db, value.id, 'Comfort')
    const users = await addParameter(db, stake.id, 'Users')
    const alpha = await createContext(db, project.id)
    await bindParameter(db, alpha.id, value.id, comfort.id)
    await bindParameter(db, alpha.id, stake.id, users.id)
    await openChildCanvas(db, alpha.id)

    for (const tbl of ['dimensions', 'contexts']) {
      const dangling = (await pg.query(
        `SELECT count(*)::int AS n FROM "${tbl}" t
          LEFT JOIN canvases c ON c.id = t.canvas_id
         WHERE c.id IS NULL`,
      )) as { rows: { n: number }[] }
      expect(dangling.rows[0]?.n).toBe(0)
    }
  })
})

// ── Backfill (migration 0017) exercised directly against legacy rows ──────────
//
// The normal PGlite harness (openDatabase) runs ALL migrations, including 0017,
// against an empty schema, so pre-0017 "legacy" rows can never be inserted
// before the backfill. To genuinely exercise the hand-authored backfill SQL we
// apply migrations 0000-0016 to a raw engine, insert synthetic legacy rows
// (dimensions.context_id / contexts.parent_id populated, no canvas_id column yet),
// then apply ONLY 0017 and assert the backfill invariants. This is the real
// validation of the backfill; the forward-path tests above validate the same
// INSERT/stamp shape the backfill mirrors.
const migrationFiles = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('canvases migration 0017 — backfill of legacy data', () => {
  async function legacyThen0017() {
    const pg = new PGlite()
    const sorted = Object.keys(migrationFiles).sort()
    const path0017 = must(
      sorted.find((p) => p.includes('0017')),
      '0017 migration path',
    )
    // Apply everything strictly before 0017.
    for (const p of sorted) {
      if (p === path0017) continue
      await pg.exec(must(migrationFiles[p], p) as string)
    }
    // ── Synthetic legacy data (no canvas_id column exists yet) ──
    const W = 'ws-legacy'
    const P1 = 'proj-1'
    const P2 = 'proj-2-empty'
    await pg.exec(`INSERT INTO workspaces (id, name) VALUES ('${W}', 'Legacy WS')`)
    await pg.exec(
      `INSERT INTO projects (id, workspace_id, name) VALUES ('${P1}', '${W}', 'P1'), ('${P2}', '${W}', 'P2 empty')`,
    )
    // contexts: A (root), B (child of A), C (root, no children)
    await pg.exec(
      `INSERT INTO contexts (id, project_id, workspace_id, parent_id, symbol, sort) VALUES
         ('ctx-A', '${P1}', '${W}', NULL, 'α', 0),
         ('ctx-B', '${P1}', '${W}', 'ctx-A', 'α1', 0),
         ('ctx-C', '${P1}', '${W}', NULL, 'β', 1)`,
    )
    // dimensions: root dim (context_id NULL), one on A, one on C
    await pg.exec(
      `INSERT INTO dimensions (id, project_id, workspace_id, context_id, name, color, sort) VALUES
         ('dim-root', '${P1}', '${W}', NULL, 'Root', '#000', 0),
         ('dim-onA', '${P1}', '${W}', 'ctx-A', 'OnA', '#111', 0),
         ('dim-onC', '${P1}', '${W}', 'ctx-C', 'OnC', '#222', 0)`,
    )
    // Now apply 0017 (DDL + backfill + RLS + replica identity).
    await pg.exec(must(migrationFiles[path0017], path0017) as string)
    const db = drizzle(pg, { schema: { canvases, dimensions, contexts } })
    return { pg, db, W, P1, P2 }
  }

  it('backfills exactly one root canvas per project (including empty projects)', async () => {
    const { db, P1, P2 } = await legacyThen0017()
    const roots = await db.select().from(canvases).where(isNull(canvases.parentContextId))
    const byProject = new Set(roots.map((r) => r.projectId))
    expect(byProject.has(P1)).toBe(true)
    expect(byProject.has(P2)).toBe(true) // empty project still gets a root canvas
    expect(roots.filter((r) => r.projectId === P1)).toHaveLength(1)
    expect(roots.filter((r) => r.projectId === P2)).toHaveLength(1)
  })

  it('backfills one child canvas per distinct child context (union of dims.context_id and contexts.parent_id)', async () => {
    const { db } = await legacyThen0017()
    const children = await db.select().from(canvases)
    const parents = new Set(
      children.filter((c) => c.parentContextId !== null).map((c) => c.parentContextId),
    )
    // From dims.context_id: {ctx-A, ctx-C}. From contexts.parent_id: {ctx-A}.
    // Union = {ctx-A, ctx-C}.
    expect(parents).toEqual(new Set(['ctx-A', 'ctx-C']))
  })

  it('repoints dimensions.canvas_id (root dim → root canvas; child dim → its context child canvas)', async () => {
    const { db, P1 } = await legacyThen0017()
    const rootCanvas = must(
      (await db.select().from(canvases).where(isNull(canvases.parentContextId))).find(
        (c) => c.projectId === P1,
      ),
      'root canvas P1',
    )
    const canvasA = must(
      (await db.select().from(canvases).where(eq(canvases.parentContextId, 'ctx-A')))[0],
      'child canvas A',
    )
    const canvasC = must(
      (await db.select().from(canvases).where(eq(canvases.parentContextId, 'ctx-C')))[0],
      'child canvas C',
    )
    const dims = await db.select().from(dimensions)
    const byId = new Map(dims.map((d) => [d.id, d.canvasId]))
    expect(byId.get('dim-root')).toBe(rootCanvas.id)
    expect(byId.get('dim-onA')).toBe(canvasA.id)
    expect(byId.get('dim-onC')).toBe(canvasC.id)
  })

  it('repoints contexts.canvas_id (root context → root canvas; child context → its parent child canvas)', async () => {
    const { db, P1 } = await legacyThen0017()
    const rootCanvas = must(
      (await db.select().from(canvases).where(isNull(canvases.parentContextId))).find(
        (c) => c.projectId === P1,
      ),
      'root canvas P1',
    )
    const canvasA = must(
      (await db.select().from(canvases).where(eq(canvases.parentContextId, 'ctx-A')))[0],
      'child canvas A',
    )
    const ctxs = await db.select().from(contexts)
    const byId = new Map(ctxs.map((c) => [c.id, c.canvasId]))
    expect(byId.get('ctx-A')).toBe(rootCanvas.id) // root context
    expect(byId.get('ctx-C')).toBe(rootCanvas.id) // root context
    expect(byId.get('ctx-B')).toBe(canvasA.id) // child of A → A's child canvas
  })

  it('leaves no dangling canvas_id after backfill', async () => {
    const { pg } = await legacyThen0017()
    for (const tbl of ['dimensions', 'contexts']) {
      const dangling = (await pg.query(
        `SELECT count(*)::int AS n FROM "${tbl}" t
          LEFT JOIN canvases c ON c.id = t.canvas_id
         WHERE c.id IS NULL`,
      )) as { rows: { n: number }[] }
      expect(dangling.rows[0]?.n).toBe(0)
    }
  })

  it('uses deterministic backfill ids (reproducible, no random UUIDs in SQL)', async () => {
    const { db, P1 } = await legacyThen0017()
    const rootP1 = must(
      (await db.select().from(canvases).where(isNull(canvases.parentContextId))).find(
        (c) => c.projectId === P1,
      ),
      'root canvas P1',
    )
    // Deterministic scheme: root = 'canvas-' || project_id; child = 'canvas-ctx-' || context_id.
    expect(rootP1.id).toBe(`canvas-${P1}`)
    const canvasA = must(
      (await db.select().from(canvases).where(eq(canvases.parentContextId, 'ctx-A')))[0],
      'child canvas A',
    )
    expect(canvasA.id).toBe('canvas-ctx-ctx-A')
  })
})

// ── Phase 4a: read path keys on canvas_id (the load-bearing correctness change) ─
// Before Phase 4a the read/scope path filtered `context_id IS NULL` for the
// root canvas, so TWO root canvases in one project both matched and leaked
// rows into each other. These assert the repoint to canvas_id.
describe('canvases read scope — independent root canvases (issue 090 Phase 4a)', () => {
  async function twoRootCanvases() {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    // createProject seeded canvas A; add a second root canvas B.
    const canvasA = must((await listCanvases(db, project.id))[0], 'canvas A')
    const canvasB = await createCanvas(db, project.id, 'Alt')
    return { db, projectId: project.id, canvasA, canvasB }
  }

  it('two root canvases hold independent dimension sets (no context_id IS NULL leak)', async () => {
    const { db, projectId, canvasA, canvasB } = await twoRootCanvases()
    const dimA = await addDimension(db, projectId, undefined, canvasA.id)
    const dimB = await addDimension(db, projectId, undefined, canvasB.id)

    const listA = await listDimensions(db, projectId, canvasA.id)
    const listB = await listDimensions(db, projectId, canvasB.id)
    expect(listA.map((d) => d.id)).toEqual([dimA.id])
    expect(listB.map((d) => d.id)).toEqual([dimB.id])
    // Explicit cross-exclusion: each canvas excludes the other's rows.
    expect(listA.some((d) => d.id === dimB.id)).toBe(false)
    expect(listB.some((d) => d.id === dimA.id)).toBe(false)
  })

  it('two root canvases hold independent context sets (no parent_id IS NULL leak)', async () => {
    const { db, projectId, canvasA, canvasB } = await twoRootCanvases()
    const ctxA = await createContext(db, projectId, null, canvasA.id)
    const ctxB = await createContext(db, projectId, null, canvasB.id)

    const listA = await listContexts(db, projectId, canvasA.id)
    const listB = await listContexts(db, projectId, canvasB.id)
    expect(listA.map((c) => c.id)).toEqual([ctxA.id])
    expect(listB.map((c) => c.id)).toEqual([ctxB.id])
    expect(listA.some((c) => c.id === ctxB.id)).toBe(false)
    expect(listB.some((c) => c.id === ctxA.id)).toBe(false)
  })

  it('addDimension / createContext land on the explicitly targeted canvas only', async () => {
    const { db, projectId, canvasA, canvasB } = await twoRootCanvases()
    const dimB = await addDimension(db, projectId, 'Only B', canvasB.id)
    const ctxB = await createContext(db, projectId, null, canvasB.id)
    expect(dimB.canvasId).toBe(canvasB.id)
    expect(ctxB.canvasId).toBe(canvasB.id)
    // Canvas A stays empty.
    expect(await listDimensions(db, projectId, canvasA.id)).toHaveLength(0)
    expect(await listContexts(db, projectId, canvasA.id)).toHaveLength(0)
  })
})

// ── Phase 4a: cascade archive/restore + root-canvas floor guard ───────────────
describe('canvases cascade + floor (issue 090 Phase 4a)', () => {
  async function projectWithSecondCanvas() {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Tavalo' })
    const canvasA = must((await listCanvases(db, project.id))[0], 'canvas A')
    const canvasB = await createCanvas(db, project.id, 'Alt')
    // Populate canvas B with a dimension, a context, and a binding.
    const value = await addDimension(db, project.id, 'Value', canvasB.id)
    const param = await addParameter(db, value.id, 'Cheap')
    const ctx = await createContext(db, project.id, null, canvasB.id)
    await bindParameter(db, ctx.id, value.id, param.id)
    return { db, projectId: project.id, canvasA, canvasB, value, ctx }
  }

  it('archiveCanvasCascade tombstones the canvas + its dimensions/contexts/bindings', async () => {
    const { db, canvasB, value, ctx } = await projectWithSecondCanvas()
    const result = await archiveCanvasCascade(db, canvasB.id)
    // Returned rows verbatim so a store can enqueue + undo each.
    expect(result.canvas.id).toBe(canvasB.id)
    expect(result.dimensions.map((d) => d.id)).toContain(value.id)
    expect(result.contexts.map((c) => c.id)).toContain(ctx.id)
    expect(result.bindings).toHaveLength(1)

    const liveCanvas = await db.select().from(canvases).where(eq(canvases.id, canvasB.id))
    expect(liveCanvas[0]?.deletedAt).not.toBeNull()
    const liveDims = await db
      .select()
      .from(dimensions)
      .where(and(eq(dimensions.canvasId, canvasB.id), isNull(dimensions.deletedAt)))
    expect(liveDims).toHaveLength(0)
    const liveCtxs = await db
      .select()
      .from(contexts)
      .where(and(eq(contexts.canvasId, canvasB.id), isNull(contexts.deletedAt)))
    expect(liveCtxs).toHaveLength(0)
    const liveBindings = await db
      .select()
      .from(bindings)
      .where(and(eq(bindings.contextId, ctx.id), isNull(bindings.deletedAt)))
    expect(liveBindings).toHaveLength(0)
  })

  it('restoreCanvasCascade revives exactly the tombstoned rows', async () => {
    const { db, canvasB, value, ctx } = await projectWithSecondCanvas()
    const captured = await archiveCanvasCascade(db, canvasB.id)
    await restoreCanvasCascade(db, captured)

    const liveCanvas = must((await db.select().from(canvases).where(eq(canvases.id, canvasB.id)))[0], 'canvas')
    expect(liveCanvas.deletedAt).toBeNull()
    expect(await listDimensions(db, liveCanvas.projectId, canvasB.id)).toHaveLength(1)
    expect(await listContexts(db, liveCanvas.projectId, canvasB.id)).toHaveLength(1)
    const liveBindings = await db
      .select()
      .from(bindings)
      .where(and(eq(bindings.contextId, ctx.id), isNull(bindings.deletedAt)))
    expect(liveBindings).toHaveLength(1)
    expect(value.canvasId).toBe(canvasB.id)
  })

  it('deleting the last live root canvas throws RootCanvasFloorError', async () => {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Solo' })
    const only = must((await listCanvases(db, project.id))[0], 'only root canvas')
    await expect(archiveCanvasCascade(db, only.id)).rejects.toBeInstanceOf(RootCanvasFloorError)
  })

  it('archiving a root canvas is allowed while another live root canvas remains', async () => {
    const { db, canvasB } = await projectWithSecondCanvas()
    // Two live root canvases (A seeded, B created) — archiving B is fine.
    await expect(archiveCanvasCascade(db, canvasB.id)).resolves.toBeDefined()
  })
})
