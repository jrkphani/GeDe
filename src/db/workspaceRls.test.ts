// Issue 034 test-first plan #1 ("the load-bearing test") + #2 (membership
// scoping) + #4 (single-user preserved). Runs directly against PGlite — no
// live Postgres/Electric server is reachable in this repo's tests (HANDOFF) —
// but PGlite genuinely IS Postgres under WASM, so this exercises REAL RLS
// enforcement, not a mock of it: `SET ROLE app_user` (the non-owner role
// migration 0008 provisions) + the same `app.current_user_sub` GUC
// src/db/tenantContext.ts sets in the app makes every query below run exactly
// as migration 0008's policies were designed to be evaluated on server
// Postgres. This is the query-boundary half of "the sync stream must run
// under RLS" (the sync/Electric-transport half is covered by
// src/domain/syncScope.test.ts + src/sync/syncEngine.test.ts — see that
// file's header for why a live Electric connection can't be exercised here).
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from './client'
import { addWorkspaceMember, createWorkspace, removeWorkspaceMember } from './workspaces'
import { createProject } from './mutations'

let db: Database

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
})

// Runs `fn` as the least-privilege `app_user` role with the given Cognito
// sub set on the session — i.e. exactly how the server-side write-path/sync
// connection (043/deploy) is meant to authenticate a request, per migration
// 0008's header. Always resets back to the owner role afterward so the
// per-test superuser seeding above/below stays unaffected.
async function asUser<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`SET ROLE app_user`)
  await db.execute(sql`SELECT set_config('app.current_user_sub', ${sub}, false)`)
  try {
    return await fn()
  } finally {
    await db.execute(sql`RESET ROLE`)
  }
}

describe('workspace RLS isolation (test-first plan #1)', () => {
  it('a client in workspace A cannot SELECT any workspace-B row', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-a')
    const wsB = await createWorkspace(db, 'B', 'sub-b')
    const projectA = await createProject(db, { name: 'Project A', workspaceId: wsA.id })
    await createProject(db, { name: 'Project B', workspaceId: wsB.id })

    const visibleToA = await asUser('sub-a', () =>
      db.execute<{ id: string }>(sql`SELECT id FROM projects`),
    )
    const ids = (visibleToA as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)
    expect(ids).toEqual([projectA.id])
  })

  it('rejects a cross-tenant UPDATE (0 rows affected, not an error)', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-a')
    const wsB = await createWorkspace(db, 'B', 'sub-b')
    await createProject(db, { name: 'Project A', workspaceId: wsA.id })
    const projectB = await createProject(db, { name: 'Project B', workspaceId: wsB.id })

    const result = await asUser('sub-a', () =>
      db.execute(sql`UPDATE projects SET name = 'hacked' WHERE id = ${projectB.id} RETURNING id`),
    )
    expect((result as unknown as { rows: unknown[] }).rows).toHaveLength(0)
  })

  it('rejects a cross-tenant INSERT — RLS, not just app-layer trust', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-a')
    const wsB = await createWorkspace(db, 'B')

    // drizzle-orm/pglite wraps the underlying Postgres error in `.cause`
    // (its own message is just "Failed query: ..."), so assert on the root
    // cause rather than the wrapper's own message.
    let rejection: unknown
    try {
      await asUser('sub-a', () => createProject(db, { name: 'Sneaky', workspaceId: wsB.id }))
    } catch (err) {
      rejection = err
    }
    expect(rejection).toBeInstanceOf(Error)
    const cause = (rejection as Error & { cause?: unknown }).cause
    const message = cause instanceof Error ? cause.message : (rejection as Error).message
    expect(message).toMatch(/row-level security/i)

    // wsA's own workspace is unaffected — the rejection was scoped, not global.
    const ownProject = await asUser('sub-a', () =>
      createProject(db, { name: 'Legit', workspaceId: wsA.id }),
    )
    expect(ownProject.workspaceId).toBe(wsA.id)
  })

  it('scopes nested tables (no own workspace_id) via their parent FK chain', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-a')
    const wsB = await createWorkspace(db, 'B', 'sub-b')
    const projectA = await createProject(db, { name: 'A', workspaceId: wsA.id })
    await createProject(db, { name: 'B', workspaceId: wsB.id })

    // Seed directly (superuser/owner — bypasses RLS, this is test setup).
    // Issue 090 — dimensions now carry a NOT-NULL canvas_id membership FK, so
    // a canvas row must exist first (createProject already seeds one, but seed
    // an explicit one here to keep the raw-SQL fixture self-contained).
    await db.execute(
      sql`INSERT INTO canvases (id, project_id, workspace_id, sort)
          VALUES ('cv-a', ${projectA.id}, ${wsA.id}, 1)`,
    )
    await db.execute(
      sql`INSERT INTO dimensions (id, project_id, workspace_id, canvas_id, name, color, sort)
          VALUES ('dim-a', ${projectA.id}, ${wsA.id}, 'cv-a', 'Dim', '#000', 0)`,
    )
    // Issue 078 step 2 (migration 0015) — parameters now carries its own
    // workspace_id column (denormalized from dimensions, for Electric's
    // read-path shape scoping — src/domain/syncScope.ts). RLS itself is
    // unchanged: parameters_select still walks the dimension_id FK chain
    // below, so this seed's workspace_id value doesn't affect what this
    // test is proving — it's here only to satisfy the NOT NULL constraint.
    await db.execute(
      sql`INSERT INTO parameters (id, dimension_id, workspace_id, name, sort)
          VALUES ('param-a', 'dim-a', ${wsA.id}, 'Param', 0)`,
    )

    const visibleToA = await asUser('sub-a', () => db.execute(sql`SELECT id FROM parameters`))
    const visibleToB = await asUser('sub-b', () => db.execute(sql`SELECT id FROM parameters`))
    expect((visibleToA as unknown as { rows: unknown[] }).rows).toHaveLength(1)
    expect((visibleToB as unknown as { rows: unknown[] }).rows).toHaveLength(0)
  })
})

describe('membership scoping (test-first plan #2)', () => {
  it('removing a member immediately revokes read access to their (former) workspace', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-a')
    await createProject(db, { name: 'Project A', workspaceId: wsA.id })

    expect(
      (
        (await asUser('sub-a', () => db.execute(sql`SELECT id FROM projects`))) as unknown as {
          rows: unknown[]
        }
      ).rows,
    ).toHaveLength(1)

    await removeWorkspaceMember(db, wsA.id, 'sub-a')

    expect(
      (
        (await asUser('sub-a', () => db.execute(sql`SELECT id FROM projects`))) as unknown as {
          rows: unknown[]
        }
      ).rows,
    ).toHaveLength(0)
  })

  it('a viewer can read but not write (role-gated RLS, not just UI)', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-owner')
    await addWorkspaceMember(db, wsA.id, 'sub-viewer', 'viewer')
    const project = await createProject(db, { name: 'Project A', workspaceId: wsA.id })

    const readResult = await asUser('sub-viewer', () => db.execute(sql`SELECT id FROM projects`))
    expect((readResult as unknown as { rows: unknown[] }).rows).toHaveLength(1)

    const writeResult = await asUser('sub-viewer', () =>
      db.execute(sql`UPDATE projects SET name = 'viewer-edit' WHERE id = ${project.id} RETURNING id`),
    )
    expect((writeResult as unknown as { rows: unknown[] }).rows).toHaveLength(0)
  })

  it('an editor CAN write', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-owner')
    await addWorkspaceMember(db, wsA.id, 'sub-editor', 'editor')
    const project = await createProject(db, { name: 'Project A', workspaceId: wsA.id })

    const writeResult = await asUser('sub-editor', () =>
      db.execute(sql`UPDATE projects SET name = 'editor-edit' WHERE id = ${project.id} RETURNING id`),
    )
    expect((writeResult as unknown as { rows: unknown[] }).rows).toHaveLength(1)
  })
})

describe('single-user preserved (test-first plan #4)', () => {
  it('the local app (table owner, no ROLE switch) is never affected by RLS', async () => {
    const workspace = await createWorkspace(db, 'Personal')
    const project = await createProject(db, { name: 'My Project', workspaceId: workspace.id })
    // No SET ROLE, no app.current_user_sub — the default PGlite connection,
    // exactly as src/db/client.ts opens it. Every existing pre-034 test in
    // this repo runs this way; RLS must be fully transparent to it.
    const rows = await db.execute(sql`SELECT id FROM projects WHERE id = ${project.id}`)
    expect((rows as unknown as { rows: unknown[] }).rows).toHaveLength(1)
  })
})
