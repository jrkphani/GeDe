import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../db/client'
import { setDatabase } from './database'
import { createWorkspace } from '../db/workspaces'
import { createInvitation, getInvitation } from '../db/invitations'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetProjectsStore, useProjectsStore } from './projects'
import { resetSyncStore, useSyncStore } from './sync'
import { resetWorkspaceStore, useWorkspaceStore } from './workspace'
import { workspaceIdForSub } from '../domain/workspaceId'

let db: Database

beforeEach(async () => {
  resetProjectsStore()
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetWorkspaceStore()
  resetAuthStoreForTests()
  resetSyncStore()
})

describe('load', () => {
  it('loads members and invitations for a workspace', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')

    await useWorkspaceStore.getState().load(ws.id)

    const state = useWorkspaceStore.getState()
    expect(state.workspaceId).toBe(ws.id)
    expect(state.members).toHaveLength(1)
    expect(state.invitations).toHaveLength(1)
  })
})

describe('role (computed from members + auth identity)', () => {
  it('is "owner" when auth is not configured (solo/local mode)', async () => {
    const ws = await createWorkspace(db, 'Acme') // no members at all
    await useWorkspaceStore.getState().load(ws.id)
    expect(useWorkspaceStore.getState().role).toBe('owner')
  })

  it('matches the signed-in user’s own membership row once authenticated', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const { addWorkspaceMember } = await import('../db/workspaces')
    await addWorkspaceMember(db, ws.id, 'sub-viewer', 'viewer')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-viewer', email: null } })

    await useWorkspaceStore.getState().load(ws.id)
    expect(useWorkspaceStore.getState().role).toBe('viewer')
  })
})

describe('invite / changeRole / removeMember', () => {
  it('invite creates a pending invitation attributed to the signed-in user', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-owner', email: 'owner@example.com' } })
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().invite('New@Example.com', 'editor')

    const state = useWorkspaceStore.getState()
    expect(state.invitations).toHaveLength(1)
    expect(state.invitations[0]).toMatchObject({ email: 'new@example.com', role: 'editor', invitedBySub: 'sub-owner' })
  })

  it('changeRole updates a member’s role and refreshes the list', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const { addWorkspaceMember } = await import('../db/workspaces')
    await addWorkspaceMember(db, ws.id, 'sub-x', 'viewer')
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().changeRole('sub-x', 'editor')

    const member = useWorkspaceStore.getState().members.find((m) => m.userSub === 'sub-x')
    expect(member?.role).toBe('editor')
  })

  it('removeMember drops the member from the list', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const { addWorkspaceMember } = await import('../db/workspaces')
    await addWorkspaceMember(db, ws.id, 'sub-x', 'viewer')
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().removeMember('sub-x')

    expect(useWorkspaceStore.getState().members.find((m) => m.userSub === 'sub-x')).toBeUndefined()
  })
})

// Issue 056 (055's Cause 1 fix, test-first plan item 1) — invite/changeRole/
// removeMember must each enqueue a sync mutation after their local write,
// mirroring createProject's own signed-in gate (useSyncStore's `workspaceId`,
// src/store/projects.ts:106-127 / src/store/projectImportExport.test.ts's
// "cloud workspace scoping" describe block) — signed-out / sync-off stays
// local-only (nothing queued), signed-in queues exactly one pending mutation.
describe('invite / changeRole / removeMember — sync enqueue (issue 056)', () => {
  it('invite() enqueues an `invitations` upsert once a sync workspace is set', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-owner', email: 'owner@example.com' } })
    await useWorkspaceStore.getState().load(ws.id)
    useSyncStore.setState({ workspaceId: ws.id })

    const invitation = await useWorkspaceStore.getState().invite('new@example.com', 'editor')

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'invitations',
      rowId: invitation.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('invite() enqueues nothing when signed out / sync is off (local-only, byte-for-byte unchanged)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-owner', email: 'owner@example.com' } })
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().invite('new@example.com', 'editor')

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  it('changeRole() enqueues a `workspace_members` upsert once a sync workspace is set', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const { addWorkspaceMember } = await import('../db/workspaces')
    const member = await addWorkspaceMember(db, ws.id, 'sub-x', 'viewer')
    await useWorkspaceStore.getState().load(ws.id)
    useSyncStore.setState({ workspaceId: ws.id })

    await useWorkspaceStore.getState().changeRole('sub-x', 'editor')

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'workspace_members',
      rowId: member.id,
      op: 'upsert',
      status: 'pending',
    })
  })

  it('removeMember() enqueues a `workspace_members` delete once a sync workspace is set', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const { addWorkspaceMember } = await import('../db/workspaces')
    const member = await addWorkspaceMember(db, ws.id, 'sub-x', 'viewer')
    await useWorkspaceStore.getState().load(ws.id)
    useSyncStore.setState({ workspaceId: ws.id })

    await useWorkspaceStore.getState().removeMember('sub-x')

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'workspace_members',
      rowId: member.id,
      op: 'delete',
      status: 'pending',
    })
  })
})

// Issue 057 test-first plan item 3 — the accept-flow store test:
// `acceptInvitation` must enqueue a mutation whose `workspaceId` is the
// invitation's (inviter's) workspace, NOT the accepting user's own
// `workspaceIdForSub(sub)` (which is what `useSyncStore.workspaceId` holds
// once they're signed in — auth.ts's `applyWorkspaceScope`).
describe('acceptInvitation — sync enqueue scoped to the INVITER\'s workspace (issue 057)', () => {
  it('enqueues a workspace_members seat mutation whose workspaceId is the inviter\'s workspace, not the accepter\'s own', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')

    // The accepting user is signed in under a DIFFERENT sub than the
    // inviter — their own personal workspace id is necessarily a different
    // id than inviterWs.id. useSyncStore.workspaceId mirrors exactly what
    // auth.ts's applyWorkspaceScope sets on sign-in: always the signed-in
    // sub's own personal workspace, never the inviter's.
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    const accepterOwnWs = workspaceIdForSub('sub-invitee')
    expect(accepterOwnWs).not.toBe(inviterWs.id)
    useSyncStore.setState({ workspaceId: accepterOwnWs })

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'workspace_members',
      op: 'upsert',
      status: 'pending',
      workspaceId: inviterWs.id,
    })
    expect(queued[0]?.workspaceId).not.toBe(accepterOwnWs)
  })

  it('enqueues nothing when signed out / sync is off (local-only, byte-for-byte unchanged)', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    // useSyncStore.workspaceId left at its default null — sync never configured.

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })
})

describe('revokeInvitation / resendInvitation', () => {
  it('revoke removes a pending invitation from the visible list', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().revokeInvitation(inv.id)

    const reloaded = useWorkspaceStore.getState().invitations.find((i) => i.id === inv.id)
    expect(reloaded?.deletedAt).not.toBeNull()
  })

  it('resend extends the invitation’s expiry', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner', 1)
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().resendInvitation(inv.id)

    const reloaded = useWorkspaceStore.getState().invitations.find((i) => i.id === inv.id)
    expect(new Date(reloaded?.expiresAt ?? 0).getTime()).toBeGreaterThan(new Date(inv.expiresAt).getTime())
  })
})

// Issue 060 — the invitee's own view: pending invitations addressed to the
// SIGNED-IN user's email, independent of whichever workspace's owner panel
// (if any) is currently open (`workspaceId`/`invitations` above stay null/[]
// in every test in this block).
describe('loadMyInvitations / declineInvitation — the invitee-facing surface (issue 060)', () => {
  it('loads pending invitations addressed to the signed-in user’s email', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })

    await useWorkspaceStore.getState().loadMyInvitations()

    const mine = useWorkspaceStore.getState().myInvitations
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ id: inv.id, email: 'invitee@example.com', role: 'editor' })
  })

  it('is empty when signed out (never queries the db for an email it doesn’t have)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')

    await useWorkspaceStore.getState().loadMyInvitations()

    expect(useWorkspaceStore.getState().myInvitations).toHaveLength(0)
  })

  it('excludes invitations addressed to a different email', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    await createInvitation(db, ws.id, 'someone-else@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })

    await useWorkspaceStore.getState().loadMyInvitations()

    expect(useWorkspaceStore.getState().myInvitations).toHaveLength(0)
  })

  it('declineInvitation revokes the invite (server-side tombstone) and drops it from myInvitations', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })
    await useWorkspaceStore.getState().loadMyInvitations()
    expect(useWorkspaceStore.getState().myInvitations).toHaveLength(1)

    await useWorkspaceStore.getState().declineInvitation(inv.id)

    expect(useWorkspaceStore.getState().myInvitations).toHaveLength(0)
    const reloaded = await getInvitation(db, inv.id)
    expect(reloaded?.deletedAt).not.toBeNull()
  })

  it('acceptInvitation removes the accepted invite from myInvitations', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })
    await useWorkspaceStore.getState().loadMyInvitations()
    expect(useWorkspaceStore.getState().myInvitations).toHaveLength(1)

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    expect(useWorkspaceStore.getState().myInvitations).toHaveLength(0)
  })
})

// Issue 060 — after a successful accept, the shared project must actually
// become visible: acceptInvitation calls useProjectsStore.refreshProjects(),
// which re-queries the local db rather than trusting the store's stale
// in-memory snapshot from whenever init() last ran.
describe('acceptInvitation — reloads the projects list (issue 060)', () => {
  it('re-lists projects after accepting, picking up a row written to the db meanwhile', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    await useProjectsStore.getState().init(db)
    expect(useProjectsStore.getState().projects).toHaveLength(0)

    // Simulates a row landing locally mid-session (the real deployment: the
    // read-path streaming in the inviter's project once this sub is seated)
    // — the store's cached `projects` array won't reflect it until something
    // re-queries the db, which is exactly what this test proves accepting
    // now does.
    const { createProject } = await import('../db/mutations')
    const sharedProject = await createProject(db, { name: 'Shared', workspaceId: inviterWs.id })
    expect(useProjectsStore.getState().projects.find((p) => p.id === sharedProject.id)).toBeUndefined()

    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    expect(useProjectsStore.getState().projects.find((p) => p.id === sharedProject.id)).toBeDefined()
  })
})
