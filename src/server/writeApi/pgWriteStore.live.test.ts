// Bonus test-first plan item (issue 043 follow-up): the ONE test in this repo
// that exercises `PgWriteStore` against a REAL Postgres, closing the gap the
// SQL-assertion tests in pgWriteStore.contract.test.ts cannot — those parse
// the SQL text a fake client captures, which proves the string is well-formed
// but not that Postgres actually accepts it. Both shipped bugs (053: duplicate
// `id` — Postgres 42701; 054: camelCase columns — Postgres 42703) are exactly
// the class of error a fake client can never surface, because it never asks a
// real server to parse/execute the SQL.
//
// Guarded exactly like `deploy/migration-parity/check-migrations.sh` /
// `npm run db:migration-parity` (issue 030): needs a real, empty Postgres 17
// reachable via DATABASE_URL, with `psql` on PATH to apply the migrations.
// Neither is guaranteed in a dev worktree or this repo's default CI job, so
// this file SKIPS cleanly (not a failure) when either is missing, exactly
// like that script does. To run it locally:
//
//   docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
//     npx vitest run src/server/writeApi/pgWriteStore.live.test.ts
//
// The connecting role here is whichever role DATABASE_URL authenticates as
// (typically the server's own superuser/table-owner in a throwaway
// container) — Postgres exempts a table's OWNER from its own RLS policies
// (see src/db/migrations/0008_workspaces_rls.sql's header comment), so this
// test does not need to impersonate `app_user` / set a matching tenant
// context to observe the insert land; it is asserting persistence + column
// mapping, not RLS enforcement (that is 034's dedicated coverage).
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { uuidv7 } from 'uuidv7'
import { PgWriteStore } from './store'

const DATABASE_URL = process.env.DATABASE_URL
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Mirrors check-migrations.sh's own readiness checks — same skip conditions, same reasoning. */
function checkLiveDbReady(): boolean {
  if (!DATABASE_URL) return false
  try {
    execSync('command -v psql', { stdio: 'ignore' })
  } catch {
    return false
  }
  try {
    execSync(`psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c "select 1"`, { stdio: 'ignore' })
  } catch {
    return false
  }
  return true
}

const LIVE_DB_READY = checkLiveDbReady()

if (!LIVE_DB_READY) {
  // mirrors check-migrations.sh's own stdout skip message
  console.log(
    'pgWriteStore.live.test: DATABASE_URL unset, psql missing, or DB unreachable — skipping (not a failure). ' +
      'See this file header for how to run it locally against a throwaway postgres:17 container.',
  )
}

describe.skipIf(!LIVE_DB_READY)('PgWriteStore.applyIfNew — live Postgres integration (guarded, bugs 053/054)', () => {
  let pool: Pool
  let workspaceId: string

  beforeAll(() => {
    // Applies src/db/migrations/*.sql from empty, in filename order — the
    // exact same DDL src/db/migrate.ts applies for PGlite (ADR-0008 parity).
    execSync('bash deploy/migration-parity/check-migrations.sh', {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    })

    pool = new Pool({ connectionString: DATABASE_URL })
  })

  afterAll(async () => {
    await pool.end()
  })

  it('creates a workspace and project row (setup fixture, not the assertion under test)', async () => {
    workspaceId = uuidv7()
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspaceId, 'Live Test Workspace'])
    const result = await pool.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId])
    expect(result.rows).toHaveLength(1)
  })

  it('insert: persists a camelCase client payload as snake_case columns, with `id` landing exactly once', async () => {
    const store = new PgWriteStore({ pool })
    const entityId = uuidv7()
    const clientUpdatedAt = new Date().toISOString()

    const applied = await store.applyIfNew(
      {
        id: uuidv7(), // the mutation's own idempotency-ledger id
        workspaceId,
        table: 'projects',
        op: 'insert',
        entityId,
        payload: {
          // Realistic client payload: echoes the entity's own id (bug 053's
          // trigger) and uses Drizzle's camelCase JS field names (bug 054's).
          id: entityId,
          name: 'Live Integration Project',
          workspaceId,
          createdAt: clientUpdatedAt,
        },
        clientUpdatedAt,
      },
      'live-test-user-sub',
    )

    expect(applied).toBe(true)

    const result = await pool.query<{
      id: string
      name: string
      workspace_id: string
      updated_at: Date
      deleted_at: Date | null
    }>('SELECT id, name, workspace_id, updated_at, deleted_at FROM projects WHERE id = $1', [entityId])

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row).toBeDefined()
    expect(row?.id).toBe(entityId)
    expect(row?.name).toBe('Live Integration Project')
    expect(row?.workspace_id).toBe(workspaceId) // bug 054: would be NULL / column-not-found pre-fix
    expect(row?.deleted_at).toBeNull()

    // Replaying the same mutation id must be a no-op (idempotency ledger),
    // not a second attempted INSERT / duplicate-id error.
    const repeated = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'projects',
        op: 'insert',
        entityId,
        payload: { id: entityId, name: 'Should not overwrite', workspaceId },
        clientUpdatedAt,
      },
      'live-test-user-sub',
    )
    // A different mutation id targeting the same entityId is a fresh
    // mutation (not caught by the ledger) — `ON CONFLICT (id) DO NOTHING` on
    // the INSERT is what makes this a safe no-op at the ROW level.
    expect(repeated).toBe(true)
    const afterRepeat = await pool.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [entityId])
    expect(afterRepeat.rows[0]?.name).toBe('Live Integration Project') // unchanged — ON CONFLICT DO NOTHING held
  })

  it('update: persists a camelCase client payload as snake_case columns, without re-touching `id`', async () => {
    const store = new PgWriteStore({ pool })
    const entityId = uuidv7()
    const createdAt = new Date().toISOString()

    await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'projects',
        op: 'insert',
        entityId,
        payload: { id: entityId, name: 'Before Update', workspaceId, createdAt },
        clientUpdatedAt: createdAt,
      },
      'live-test-user-sub',
    )

    const clientUpdatedAt = new Date(Date.now() + 1000).toISOString()
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'projects',
        op: 'update',
        entityId,
        payload: { id: entityId, name: 'After Update', workspaceId },
        clientUpdatedAt,
      },
      'live-test-user-sub',
    )

    expect(applied).toBe(true)
    const result = await pool.query<{ name: string; workspace_id: string; updated_at: Date }>(
      'SELECT name, workspace_id, updated_at FROM projects WHERE id = $1',
      [entityId],
    )
    expect(result.rows[0]?.name).toBe('After Update')
    expect(result.rows[0]?.workspace_id).toBe(workspaceId)
  })

  // Issue 095 — tier1_purpose is a project SINGLETON (unique index
  // tier1_purpose_project_idx on project_id). A client whose local mirror lacks
  // the row enqueues an 'upsert' (→ 'insert' op) with a FRESH id; against a
  // project that already has a server-side purpose row this used to 23505 on the
  // secondary unique index (a plain `ON CONFLICT (id) DO NOTHING` can't see the
  // project_id collision) → uncaught → ALB 500 → the purpose edit silently lost.
  // Only REAL Postgres enforces the unique index, so this is the authoritative
  // proof the fix reconciles onto the existing row instead of erroring. (The
  // fake-client contract test can only assert the SQL string, not that Postgres
  // accepts it — exactly the 053/054 lesson.)
  it('insert(upsert): a tier1_purpose write with a NEW id but an existing project_id updates the existing row, no 23505 (095)', async () => {
    const store = new PgWriteStore({ pool })
    const projectId = uuidv7()
    const existingRowId = uuidv7()

    // Seed a project + its ONE tier1_purpose row (id = existingRowId) — the
    // server-side state a cold-mirror client is unaware of.
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      projectId,
      workspaceId,
      'P095',
    ])
    await pool.query('INSERT INTO tier1_purpose (id, project_id, workspace_id, body) VALUES ($1, $2, $3, $4)', [
      existingRowId,
      projectId,
      workspaceId,
      'old body',
    ])

    // The cold-mirror client edits the purpose: FRESH id, SAME project_id, new body.
    const freshId = uuidv7()
    const clientUpdatedAt = new Date(Date.now() + 1000).toISOString()
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'tier1Purpose',
        op: 'insert', // 'upsert' maps to 'insert' — see src/sync/writeTransport.ts
        entityId: freshId,
        payload: { id: freshId, projectId, body: 'new body', workspaceId },
        clientUpdatedAt,
      },
      'live-test-user-sub',
    )
    expect(applied).toBe(true)

    // Exactly ONE purpose row for the project — reconciled onto the EXISTING row
    // (its id kept), body updated (DO UPDATE persisted the edit, not DO NOTHING).
    const rows = await pool.query<{ id: string; body: string }>(
      'SELECT id, body FROM tier1_purpose WHERE project_id = $1',
      [projectId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.id).toBe(existingRowId)
    expect(rows.rows[0]?.body).toBe('new body')
  })

  // Issue 095 follow-up (SECURITY) — the natural-key upsert reconciles onto an
  // EXISTING row by project_id, so without a guard a caller could overwrite (and
  // re-tenant) ANOTHER workspace's tier1_purpose by declaring their own workspace
  // + a victim's project_id (the insert tenancy branch only authorizes the
  // DECLARED workspace, and prod RLS is a no-op). The
  // `WHERE tier1_purpose.workspace_id = EXCLUDED.workspace_id` guard must make
  // that a silent no-op. Only real Postgres executes ON CONFLICT … WHERE.
  it('insert(upsert): a cross-tenant upsert (declared workspace ≠ the row’s) does NOT overwrite it (095 security)', async () => {
    const store = new PgWriteStore({ pool })
    const victimWorkspaceId = uuidv7()
    const attackerWorkspaceId = workspaceId // the beforeAll fixture workspace
    const projectId = uuidv7()
    const rowId = uuidv7()

    // Seed a VICTIM workspace + project + tier1_purpose row it owns.
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [victimWorkspaceId, 'Victim WS'])
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      projectId,
      victimWorkspaceId,
      'Victim Project',
    ])
    await pool.query('INSERT INTO tier1_purpose (id, project_id, workspace_id, body) VALUES ($1, $2, $3, $4)', [
      rowId,
      projectId,
      victimWorkspaceId,
      'victim body',
    ])

    // Attacker (a DIFFERENT workspace) upserts the SAME project_id declaring their
    // own workspace. (applyIfNew's tenant GUC is set to the attacker workspace;
    // prod RLS is a no-op, so only the WHERE guard stands between this and a
    // cross-tenant clobber.)
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId: attackerWorkspaceId,
        table: 'tier1Purpose',
        op: 'insert',
        entityId: uuidv7(),
        payload: { id: uuidv7(), projectId, body: 'HACKED', workspaceId: attackerWorkspaceId },
        clientUpdatedAt: new Date(Date.now() + 5000).toISOString(),
      },
      'attacker-sub',
    )
    expect(applied).toBe(true) // the mutation is "applied" (ledgered); the DO UPDATE just no-ops

    // The victim's row is UNTOUCHED — same body, same workspace, same id.
    const after = await pool.query<{ id: string; body: string; workspace_id: string }>(
      'SELECT id, body, workspace_id FROM tier1_purpose WHERE project_id = $1',
      [projectId],
    )
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]?.id).toBe(rowId)
    expect(after.rows[0]?.body).toBe('victim body') // NOT "HACKED"
    expect(after.rows[0]?.workspace_id).toBe(victimWorkspaceId) // NOT re-tenanted
  })

  // Issue 078 step 2 (migration 0015) — parameters/bindings/tier2_entries
  // gained their own denormalized workspace_id column, mirroring the
  // `projects` round-trip above. Real Postgres is the only thing that can
  // prove the NOT NULL constraint + FK are satisfied and the stamped
  // workspace_id (never the payload's own, possibly-absent one) actually
  // lands — the fake `pg` client in pgWriteStore.contract.test.ts only
  // proves the SQL text is well-formed.
  it('insert: parameters/bindings/tier2_entries persist with a real workspace_id, server-stamped from mutation.workspaceId', async () => {
    const store = new PgWriteStore({ pool })
    const projectId = uuidv7()
    const canvasId = uuidv7()
    const dimensionId = uuidv7()
    const contextId = uuidv7()
    const tableId = uuidv7()
    const parameterId = uuidv7()
    const bindingId = uuidv7()
    const entryId = uuidv7()
    const now = new Date().toISOString()

    // Seed the parent rows this test's three inserts FK against — direct
    // pool queries (test setup, not the assertion under test), mirroring
    // this file's own "creates a workspace and project row" fixture step.
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      projectId,
      workspaceId,
      'Live 078 Project',
    ])
    await pool.query('INSERT INTO canvases (id, project_id, workspace_id, sort) VALUES ($1, $2, $3, 0)', [
      canvasId,
      projectId,
      workspaceId,
    ])
    await pool.query(
      'INSERT INTO dimensions (id, project_id, workspace_id, canvas_id, name, color, sort) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [dimensionId, projectId, workspaceId, canvasId, 'Dim', '#000', 0],
    )
    await pool.query(
      "INSERT INTO contexts (id, project_id, workspace_id, canvas_id, symbol, sort) VALUES ($1, $2, $3, $4, 'α', 0)",
      [contextId, projectId, workspaceId, canvasId],
    )
    await pool.query('INSERT INTO tier2_tables (id, project_id, workspace_id, name, sort) VALUES ($1, $2, $3, $4, 0)', [
      tableId,
      projectId,
      workspaceId,
      'Value',
    ])

    const results = await Promise.all([
      store.applyIfNew(
        {
          id: uuidv7(),
          workspaceId,
          table: 'parameters',
          op: 'insert',
          entityId: parameterId,
          payload: { id: parameterId, dimensionId, name: 'Comfort', sort: 0, createdAt: now },
          clientUpdatedAt: now,
        },
        'live-test-user-sub',
      ),
      store.applyIfNew(
        {
          id: uuidv7(),
          workspaceId,
          table: 'tier2Entries',
          op: 'insert',
          entityId: entryId,
          payload: { id: entryId, tableId, name: 'Buyers', sort: 0, createdAt: now },
          clientUpdatedAt: now,
        },
        'live-test-user-sub',
      ),
    ])
    expect(results).toEqual([true, true])

    // bindings depends on parameters having landed first (FK), so sequence it.
    const bindingApplied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'bindings',
        op: 'insert',
        entityId: bindingId,
        payload: { id: bindingId, contextId, dimensionId, parameterId, tupleHash: 'h1', createdAt: now },
        clientUpdatedAt: now,
      },
      'live-test-user-sub',
    )
    expect(bindingApplied).toBe(true)

    const paramRow = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM parameters WHERE id = $1',
      [parameterId],
    )
    const bindingRow = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM bindings WHERE id = $1', [
      bindingId,
    ])
    const entryRow = await pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM tier2_entries WHERE id = $1',
      [entryId],
    )
    expect(paramRow.rows[0]?.workspace_id).toBe(workspaceId)
    expect(bindingRow.rows[0]?.workspace_id).toBe(workspaceId)
    expect(entryRow.rows[0]?.workspace_id).toBe(workspaceId)
  })
})
