import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../db/client'
import { setDatabase } from './database'
import { createWorkspace } from '../db/workspaces'
import { createInvitation } from '../db/invitations'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetSyncStore, useSyncStore } from './sync'
import { resetWorkspaceStore, useWorkspaceStore } from './workspace'

let db: Database

beforeEach(async () => {
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
