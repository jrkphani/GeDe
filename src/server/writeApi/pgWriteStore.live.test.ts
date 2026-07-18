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
import { PgWriteStore, resolveForeignKeyTenancy } from './store'

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

  // Issue 091 — the `update`-path twin of 095. tier1_purpose is a project
  // SINGLETON, but a cold-mirror client mints a FRESH id for it; after 095's
  // insert-path reconciliation the server row keeps its OWN id, so the client's
  // minted id diverges. The NEXT edit enqueues an `update` for the minted id —
  // addressing the row by `id` would UPDATE zero rows (the id isn't on the
  // server) → the edit silently vanishes. The fix addresses the row by its
  // project_id natural key instead. Only REAL Postgres proves the UPDATE hits
  // the existing row (id kept) rather than no-op'ing / minting a second row.
  it('update: a tier1_purpose update with a FRESH id but an existing project_id updates the existing row by natural key (091)', async () => {
    const store = new PgWriteStore({ pool })
    const projectId = uuidv7()
    const existingRowId = uuidv7() // the row's real server id (X)

    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      projectId,
      workspaceId,
      'P091',
    ])
    await pool.query('INSERT INTO tier1_purpose (id, project_id, workspace_id, body) VALUES ($1, $2, $3, $4)', [
      existingRowId,
      projectId,
      workspaceId,
      'old',
    ])

    // The cold-mirror client edits the purpose via an `update` carrying a FRESH,
    // diverged id (Y) — same project_id, new body.
    const freshId = uuidv7()
    const clientUpdatedAt = new Date(Date.now() + 1000).toISOString()
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'tier1Purpose',
        op: 'update',
        entityId: freshId,
        payload: { id: freshId, projectId, body: 'new', workspaceId },
        clientUpdatedAt,
      },
      'live-test-user-sub',
    )
    expect(applied).toBe(true)

    // Exactly ONE purpose row for the project — the EXISTING row (id X kept),
    // body updated by natural key. Not a no-op, no second row minted under Y.
    const rows = await pool.query<{ id: string; body: string }>(
      'SELECT id, body FROM tier1_purpose WHERE project_id = $1',
      [projectId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.id).toBe(existingRowId)
    expect(rows.rows[0]?.body).toBe('new')
    // The client's diverged id never became a row.
    const stray = await pool.query('SELECT 1 FROM tier1_purpose WHERE id = $1', [freshId])
    expect(stray.rows).toHaveLength(0)
  })

  // Issue 091 follow-up (SECURITY) — the natural-key UPDATE addresses the row by
  // project_id (not the client-minted id), so without a guard a caller could
  // overwrite (and re-tenant) ANOTHER workspace's tier1_purpose by declaring
  // their own workspace + a victim's project_id — exactly the exposure the 095
  // upsert guard closes for the insert path. The `AND workspace_id = <declared>`
  // predicate on the UPDATE must make that a silent no-op (0 rows). Only real
  // Postgres executes UPDATE … WHERE, so this is the authoritative proof (the
  // fake-client contract test can only assert the SQL string). Mirrors this
  // file's 095 "cross-tenant upsert does NOT overwrite" test, at the store layer
  // (bypassing checkTenancy) to exercise the guard directly.
  it('update: a cross-tenant natural-key update (declared workspace ≠ the row’s) does NOT overwrite it (091 security)', async () => {
    const store = new PgWriteStore({ pool })
    const victimWorkspaceId = uuidv7()
    const attackerWorkspaceId = workspaceId // the beforeAll fixture workspace
    const projectId = uuidv7()
    const rowId = uuidv7() // the victim row's real server id (X)

    // Seed a VICTIM workspace + project + tier1_purpose row it owns.
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [victimWorkspaceId, 'Victim WS 091'])
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      projectId,
      victimWorkspaceId,
      'Victim Project 091',
    ])
    await pool.query('INSERT INTO tier1_purpose (id, project_id, workspace_id, body) VALUES ($1, $2, $3, $4)', [
      rowId,
      projectId,
      victimWorkspaceId,
      'victim body',
    ])

    // Attacker (a DIFFERENT workspace) sends an UPDATE with a FRESH diverged id,
    // the SAME project_id, declaring THEIR OWN workspace. (applyIfNew's tenant
    // GUC is set to the attacker workspace; prod RLS is a no-op, so only the
    // `AND workspace_id = $2` guard stands between this and a cross-tenant
    // clobber — checkTenancy is bypassed entirely at this store-layer call.)
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId: attackerWorkspaceId,
        table: 'tier1Purpose',
        op: 'update',
        entityId: uuidv7(), // diverged id — no such row anywhere
        payload: { projectId, body: 'HACKED', workspaceId: attackerWorkspaceId },
        clientUpdatedAt: new Date(Date.now() + 5000).toISOString(),
      },
      'attacker-sub',
    )
    expect(applied).toBe(true) // the mutation is "applied" (ledgered); the UPDATE just no-ops (0 rows)

    // The victim's row is UNTOUCHED — same id, body, workspace.
    const after = await pool.query<{ id: string; body: string; workspace_id: string }>(
      'SELECT id, body, workspace_id FROM tier1_purpose WHERE project_id = $1',
      [projectId],
    )
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]?.id).toBe(rowId)
    expect(after.rows[0]?.body).toBe('victim body') // NOT "HACKED"
    expect(after.rows[0]?.workspace_id).toBe(victimWorkspaceId) // NOT re-tenanted
  })

  // Issue 098 (SECURITY) — the write-path FK-TENANCY pre-check. Against real FK
  // data, `resolveForeignKeyTenancy` must resolve a FK target's OWNING workspace
  // (via PgWriteStore.resolveWorkspaceForEntity's real SQL) and flag it when it
  // differs from the caller's declared workspace — the check the fake-client
  // contract test cannot exercise (it never resolves a real row's workspace_id).
  it('resolveForeignKeyTenancy flags a projectId owned by another workspace, and passes a same-workspace one (098)', async () => {
    const store = new PgWriteStore({ pool })
    const attackerWorkspaceId = workspaceId // the beforeAll fixture workspace
    const victimWorkspaceId = uuidv7()
    const victimProjectId = uuidv7()
    const ownProjectId = uuidv7()

    // Victim workspace + a project it owns.
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [victimWorkspaceId, 'Victim WS 098'])
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      victimProjectId,
      victimWorkspaceId,
      'Victim Project 098',
    ])
    // A project the attacker legitimately owns in their own workspace.
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      ownProjectId,
      attackerWorkspaceId,
      'Own Project 098',
    ])

    // Attacker declares their own workspace but references the VICTIM's project.
    const crossTenant = await resolveForeignKeyTenancy(
      'tier1Purpose',
      { projectId: victimProjectId },
      attackerWorkspaceId,
      store,
    )
    expect(crossTenant).toContain('projectId')

    // Same declared workspace, own project → clean.
    const clean = await resolveForeignKeyTenancy(
      'tier1Purpose',
      { projectId: ownProjectId },
      attackerWorkspaceId,
      store,
    )
    expect(clean).toEqual([])

    // A genuinely-missing FK target resolves to null → NOT flagged cross-tenant
    // (it must fall through to the existing referential_integrity check).
    const missing = await resolveForeignKeyTenancy(
      'tier1Purpose',
      { projectId: uuidv7() },
      attackerWorkspaceId,
      store,
    )
    expect(missing).toEqual([])
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

  // Issue 094 (revival gap) — the AUTHORITATIVE un-tombstone proof. A real-
  // Postgres probe (docs/issues/094 "## The revival gap") showed `update` CANNOT
  // clear a tombstone (deleted_at is SERVER_STAMPED, dropped from the SET) and a
  // revive-update is rejected before it applies (getRow filters deleted_at). The
  // `revive` op's dedicated SQL must un-tombstone the EXISTING row (deleted_at →
  // NULL) and apply the payload fields. Crucially this exercises a table with
  // NOT NULL columns absent from the revive payload (dimensions: project_id/
  // canvas_id/color/sort) — the exact shape that makes the naive
  // `INSERT … ON CONFLICT (id) DO UPDATE` form FAIL with a NOT NULL violation
  // (Postgres checks NOT NULL on the tentative insert tuple BEFORE the conflict
  // arbiter), which is why the implementation is UPDATE-first + NOT-EXISTS-
  // guarded INSERT. Only REAL Postgres enforces NOT NULL + the tombstone
  // filter, so this is the proof the fake-client contract test cannot give.
  it('revive: un-tombstones an EXISTING soft-deleted dimension (deleted_at → NULL) and applies the fields — the thing update CANNOT do (094)', async () => {
    const store = new PgWriteStore({ pool })
    const projectId = uuidv7()
    const canvasId = uuidv7()
    const dimensionId = uuidv7()

    // Seed a project + canvas + a live dimension.
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [projectId, workspaceId, 'P094'])
    await pool.query('INSERT INTO canvases (id, project_id, workspace_id, sort) VALUES ($1, $2, $3, 0)', [
      canvasId,
      projectId,
      workspaceId,
    ])
    await pool.query(
      'INSERT INTO dimensions (id, project_id, workspace_id, canvas_id, name, color, sort) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [dimensionId, projectId, workspaceId, canvasId, 'Before delete', '#000', 0],
    )

    // Delete it (op delete → tombstone) via the write store, exactly as a client would.
    const deleteApplied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'dimensions',
        op: 'delete',
        entityId: dimensionId,
        payload: {},
        clientUpdatedAt: new Date(Date.now() + 1000).toISOString(),
      },
      'live-test-user-sub',
    )
    expect(deleteApplied).toBe(true)
    const afterDelete = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM dimensions WHERE id = $1',
      [dimensionId],
    )
    expect(afterDelete.rows[0]?.deleted_at).not.toBeNull() // tombstoned

    // Revive it — un-tombstone + apply a new name. Payload deliberately OMITS the
    // other NOT NULL columns (project_id/canvas_id/color/sort): the naive ON
    // CONFLICT form would NOT NULL-violate here; the UPDATE-first path must not.
    const reviveApplied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'dimensions',
        op: 'revive',
        entityId: dimensionId,
        payload: { name: 'After revive' },
        clientUpdatedAt: new Date(Date.now() + 2000).toISOString(),
      },
      'live-test-user-sub',
    )
    expect(reviveApplied).toBe(true)

    // The row is LIVE again (deleted_at cleared), the field applied, exactly one row.
    const afterRevive = await pool.query<{ id: string; name: string; deleted_at: Date | null; canvas_id: string }>(
      'SELECT id, name, deleted_at, canvas_id FROM dimensions WHERE id = $1',
      [dimensionId],
    )
    expect(afterRevive.rows).toHaveLength(1)
    expect(afterRevive.rows[0]?.deleted_at).toBeNull() // un-tombstoned — the crux
    expect(afterRevive.rows[0]?.name).toBe('After revive') // fields applied
    expect(afterRevive.rows[0]?.canvas_id).toBe(canvasId) // NOT NULL cols preserved, never clobbered
  })

  // Issue 094 follow-up (SECURITY) — a cross-tenant revive must NOT resurrect (or
  // re-tenant) a victim's tombstoned row. Mirrors the 095/091 cross-tenant store-
  // layer tests: the UPDATE's `AND workspace_id = <declared>` guard no-ops (wrong
  // workspace) AND the insert's `WHERE NOT EXISTS` guard no-ops (the id exists),
  // so the victim row is untouched. Also proves the partial-payload cross-tenant
  // case does NOT NOT-NULL-error (the NOT EXISTS guard never forms the tuple).
  it('revive: a cross-tenant revive (declared workspace ≠ the tombstoned row’s) leaves the victim row tombstoned + untouched (094 security)', async () => {
    const store = new PgWriteStore({ pool })
    const victimWorkspaceId = uuidv7()
    const attackerWorkspaceId = workspaceId // the beforeAll fixture workspace
    const projectId = uuidv7()
    const canvasId = uuidv7()
    const dimensionId = uuidv7() // the victim row's real id

    // Seed a VICTIM workspace + project + canvas + a TOMBSTONED dimension it owns.
    await pool.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [victimWorkspaceId, 'Victim WS 094'])
    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [
      projectId,
      victimWorkspaceId,
      'Victim Project 094',
    ])
    await pool.query('INSERT INTO canvases (id, project_id, workspace_id, sort) VALUES ($1, $2, $3, 0)', [
      canvasId,
      projectId,
      victimWorkspaceId,
    ])
    await pool.query(
      'INSERT INTO dimensions (id, project_id, workspace_id, canvas_id, name, color, sort, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
      [dimensionId, projectId, victimWorkspaceId, canvasId, 'victim dim', '#000', 0],
    )

    // Attacker (a DIFFERENT workspace) tries to revive the SAME id declaring their
    // own workspace, with a partial payload. (applyIfNew's tenant GUC is the
    // attacker workspace; prod RLS is a no-op — only the two guards stand between
    // this and a cross-tenant resurrection/clobber. checkTenancy is bypassed at
    // this store-layer call, exactly like the 095/091 security tests.)
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId: attackerWorkspaceId,
        table: 'dimensions',
        op: 'revive',
        entityId: dimensionId,
        payload: { name: 'HACKED' },
        clientUpdatedAt: new Date(Date.now() + 5000).toISOString(),
      },
      'attacker-sub',
    )
    expect(applied).toBe(true) // ledgered; both guarded statements just no-op

    // The victim's row is UNTOUCHED — still tombstoned, same name, same workspace.
    const after = await pool.query<{ name: string; workspace_id: string; deleted_at: Date | null }>(
      'SELECT name, workspace_id, deleted_at FROM dimensions WHERE id = $1',
      [dimensionId],
    )
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]?.deleted_at).not.toBeNull() // STILL tombstoned — not resurrected
    expect(after.rows[0]?.name).toBe('victim dim') // NOT "HACKED"
    expect(after.rows[0]?.workspace_id).toBe(victimWorkspaceId) // NOT re-tenanted
  })

  // Issue 094 follow-up (adversarial review) — the diverged-id revive of a
  // NATURAL-KEY singleton. tier1_purpose is unique on project_id; a cold-mirror
  // client mints a FRESH id for it. A revive whose entityId is fresh/diverged but
  // whose payload projectId matches an ALREADY-LIVE tier1_purpose row must
  // RECONCILE onto that row by natural key — NOT throw 23505 on
  // tier1_purpose_project_idx (which the id-keyed revive form would, since its
  // `NOT EXISTS (id)` guard doesn't see the natural-key collision). This is the
  // exact 091/095 class, and only REAL Postgres enforces the unique index, so
  // this is the authoritative proof. Watch it THROW first (red), then green.
  it('revive: a diverged-id tier1_purpose revive whose projectId matches a LIVE row reconciles by natural key, no 23505 (094 review)', async () => {
    const store = new PgWriteStore({ pool })
    const projectId = uuidv7()
    const existingRowId = uuidv7() // the row's real server id (X)

    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [projectId, workspaceId, 'P094nk'])
    await pool.query('INSERT INTO tier1_purpose (id, project_id, workspace_id, body) VALUES ($1, $2, $3, $4)', [
      existingRowId,
      projectId,
      workspaceId,
      'old body',
    ])

    // The cold-mirror client revives the purpose via a FRESH, diverged id (Y),
    // same project_id, new body. Under an id-keyed revive this 23505s on the
    // project_id unique index; the natural-key revive reconciles onto row X.
    const freshId = uuidv7()
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'tier1Purpose',
        op: 'revive',
        entityId: freshId,
        payload: { id: freshId, projectId, body: 'revived body', workspaceId },
        clientUpdatedAt: new Date(Date.now() + 1000).toISOString(),
      },
      'live-test-user-sub',
    )
    expect(applied).toBe(true) // did NOT throw 23505

    // Exactly ONE purpose row for the project — the EXISTING row (id X kept),
    // body reconciled, live. No stray row minted under the diverged id Y.
    const rows = await pool.query<{ id: string; body: string; deleted_at: Date | null }>(
      'SELECT id, body, deleted_at FROM tier1_purpose WHERE project_id = $1',
      [projectId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.id).toBe(existingRowId)
    expect(rows.rows[0]?.body).toBe('revived body')
    expect(rows.rows[0]?.deleted_at).toBeNull()
    const stray = await pool.query('SELECT 1 FROM tier1_purpose WHERE id = $1', [freshId])
    expect(stray.rows).toHaveLength(0)
  })

  // Issue 094 follow-up — the same natural-key path un-tombstones a DELETED
  // singleton addressed by a diverged id: the existing (tombstoned) row is
  // revived in place (id kept, deleted_at cleared), no duplicate minted.
  it('revive: a diverged-id tier1_purpose revive un-tombstones the existing DELETED singleton by natural key (094 review)', async () => {
    const store = new PgWriteStore({ pool })
    const projectId = uuidv7()
    const existingRowId = uuidv7() // the row's real server id (X), tombstoned

    await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [projectId, workspaceId, 'P094nk2'])
    await pool.query(
      'INSERT INTO tier1_purpose (id, project_id, workspace_id, body, deleted_at) VALUES ($1, $2, $3, $4, now())',
      [existingRowId, projectId, workspaceId, 'old body'],
    )

    const freshId = uuidv7()
    const applied = await store.applyIfNew(
      {
        id: uuidv7(),
        workspaceId,
        table: 'tier1Purpose',
        op: 'revive',
        entityId: freshId,
        payload: { id: freshId, projectId, body: 'undeleted body', workspaceId },
        clientUpdatedAt: new Date(Date.now() + 2000).toISOString(),
      },
      'live-test-user-sub',
    )
    expect(applied).toBe(true)

    const rows = await pool.query<{ id: string; body: string; deleted_at: Date | null }>(
      'SELECT id, body, deleted_at FROM tier1_purpose WHERE project_id = $1',
      [projectId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.id).toBe(existingRowId) // existing row, id kept
    expect(rows.rows[0]?.body).toBe('undeleted body')
    expect(rows.rows[0]?.deleted_at).toBeNull() // un-tombstoned
  })
})
