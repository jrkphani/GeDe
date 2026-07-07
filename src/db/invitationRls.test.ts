// Issue 035 test-first plan #1 (invite → accept → RLS scope), #2 (role
// enforcement — only an owner may invite/revoke), #3 (revoke). Mirrors
// workspaceRls.test.ts's proven pattern exactly: `SET ROLE app_user` (the
// non-owner role migration 0008 provisions) + `app.current_user_sub`/
// `app.current_user_email` (migration 0009's email half, src/db/
// tenantContext.ts) exercises the REAL Postgres RLS policies via PGlite —
// genuine Postgres under WASM, not a mock. See that file's header for why a
// live Electric/write-path server can't be exercised here (HANDOFF).
import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from './client'
import { createWorkspace } from './workspaces'
import { createInvitation } from './invitations'
import { createProject } from './mutations'

let db: Database

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
})

async function asUser<T>(identity: { sub: string; email?: string }, fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`SET ROLE app_user`)
  await db.execute(sql`SELECT set_config('app.current_user_sub', ${identity.sub}, false)`)
  await db.execute(sql`SELECT set_config('app.current_user_email', ${identity.email ?? ''}, false)`)
  try {
    return await fn()
  } finally {
    await db.execute(sql`RESET ROLE`)
  }
}

function rowCount(result: unknown): number {
  return (result as { rows: unknown[] }).rows.length
}

describe('invitations RLS — granting is owner-only (test-first plan #2)', () => {
  it('an owner can create an invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const result = await asUser({ sub: 'sub-owner' }, () =>
      db.execute(
        sql`INSERT INTO invitations (id, workspace_id, email, role, invited_by_sub, expires_at)
            VALUES ('inv-1', ${ws.id}, 'invitee@example.com', 'editor', 'sub-owner', now() + interval '7 days')
            RETURNING id`,
      ),
    )
    expect(rowCount(result)).toBe(1)
  })

  it('an editor cannot create an invitation (RLS rejects, not just the app)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    await createInvitation(db, ws.id, 'seed@example.com', 'viewer', 'sub-owner') // superuser seed, not exercised
    const { addWorkspaceMember } = await import('./workspaces')
    await addWorkspaceMember(db, ws.id, 'sub-editor', 'editor')

    let rejection: unknown
    try {
      await asUser({ sub: 'sub-editor' }, () =>
        db.execute(
          sql`INSERT INTO invitations (id, workspace_id, email, role, invited_by_sub, expires_at)
              VALUES ('inv-2', ${ws.id}, 'invitee@example.com', 'editor', 'sub-editor', now() + interval '7 days')`,
        ),
      )
    } catch (err) {
      rejection = err
    }
    expect(rejection).toBeInstanceOf(Error)
  })

  it('an owner can revoke (soft-delete) their own invitation; a non-owner cannot', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')
    const { addWorkspaceMember } = await import('./workspaces')
    await addWorkspaceMember(db, ws.id, 'sub-viewer', 'viewer')

    const asViewer = await asUser({ sub: 'sub-viewer' }, () =>
      db.execute(sql`UPDATE invitations SET deleted_at = now() WHERE id = ${inv.id} RETURNING id`),
    )
    expect(rowCount(asViewer)).toBe(0)

    const asOwner = await asUser({ sub: 'sub-owner' }, () =>
      db.execute(sql`UPDATE invitations SET deleted_at = now() WHERE id = ${inv.id} RETURNING id`),
    )
    expect(rowCount(asOwner)).toBe(1)
  })
})

describe('invitations RLS — the invitee can see their own pending invite by email', () => {
  it('a matching email can SELECT the invitation; a stranger cannot', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')

    const asInvitee = await asUser({ sub: 'sub-invitee', email: 'invitee@example.com' }, () =>
      db.execute(sql`SELECT id FROM invitations WHERE id = ${inv.id}`),
    )
    expect(rowCount(asInvitee)).toBe(1)

    const asStranger = await asUser({ sub: 'sub-stranger', email: 'stranger@example.com' }, () =>
      db.execute(sql`SELECT id FROM invitations WHERE id = ${inv.id}`),
    )
    expect(rowCount(asStranger)).toBe(0)
  })
})

describe('the tightened workspace_members INSERT policy (done/034 deviation #3, closed by this issue)', () => {
  it('bootstrap still works: self-insert as owner of a brand-new (zero-member) workspace succeeds', async () => {
    const ws = await createWorkspace(db, 'Fresh') // no ownerSub — zero members yet
    const result = await asUser({ sub: 'sub-first' }, () =>
      db.execute(
        sql`INSERT INTO workspace_members (id, workspace_id, user_sub, role)
            VALUES ('wm-1', ${ws.id}, 'sub-first', 'owner') RETURNING id`,
      ),
    )
    expect(rowCount(result)).toBe(1)
  })

  it('a stranger CANNOT self-insert into an already-populated workspace without an invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner') // already has one member (the owner)
    let rejection: unknown
    try {
      await asUser({ sub: 'sub-stranger' }, () =>
        db.execute(
          sql`INSERT INTO workspace_members (id, workspace_id, user_sub, role)
              VALUES ('wm-2', ${ws.id}, 'sub-stranger', 'owner')`,
        ),
      )
    } catch (err) {
      rejection = err
    }
    expect(rejection).toBeInstanceOf(Error)
  })

  it('redeeming a valid, role-matching invitation lets the invitee self-insert', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')

    const result = await asUser({ sub: 'sub-invitee', email: inv.email }, () =>
      db.execute(
        sql`INSERT INTO workspace_members (id, workspace_id, user_sub, role)
            VALUES ('wm-3', ${ws.id}, 'sub-invitee', 'editor') RETURNING id`,
      ),
    )
    expect(rowCount(result)).toBe(1)
  })

  it('an invitation cannot be redeemed for a role other than the one it grants', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')

    let rejection: unknown
    try {
      await asUser({ sub: 'sub-invitee', email: inv.email }, () =>
        db.execute(
          sql`INSERT INTO workspace_members (id, workspace_id, user_sub, role)
              VALUES ('wm-4', ${ws.id}, 'sub-invitee', 'owner')`, // tries to escalate past the invited role
        ),
      )
    } catch (err) {
      rejection = err
    }
    expect(rejection).toBeInstanceOf(Error)
  })

  it('an owner can still directly seat anyone, invitation or not (unchanged owned-workspace branch)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const result = await asUser({ sub: 'sub-owner' }, () =>
      db.execute(
        sql`INSERT INTO workspace_members (id, workspace_id, user_sub, role)
            VALUES ('wm-5', ${ws.id}, 'sub-direct', 'viewer') RETURNING id`,
      ),
    )
    expect(rowCount(result)).toBe(1)
  })
})

describe('end-to-end: invite → accept → the new member reaches the workspace (test-first plan #1)', () => {
  it('after redeeming the invitation, the invitee can read the workspace’s projects', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const project = await createProject(db, { name: 'Shared project', workspaceId: ws.id })
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')

    await asUser({ sub: 'sub-invitee', email: inv.email }, () =>
      db.execute(
        sql`INSERT INTO workspace_members (id, workspace_id, user_sub, role)
            VALUES ('wm-6', ${ws.id}, 'sub-invitee', 'viewer')`,
      ),
    )

    const visible = await asUser({ sub: 'sub-invitee' }, () =>
      db.execute<{ id: string }>(sql`SELECT id FROM projects`),
    )
    expect((visible as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual([project.id])
  })
})
