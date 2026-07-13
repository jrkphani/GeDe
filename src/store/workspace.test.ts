import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Database } from '../db/client'
import { setDatabase } from './database'
import { createWorkspace } from '../db/workspaces'
import { createInvitation, getInvitation } from '../db/invitations'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetProjectsStore, useProjectsStore } from './projects'
import { resetSyncStore, useSyncStore } from './sync'
import { useStatusStore } from './status'
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
  useStatusStore.setState({ message: null, action: null })
})

// Issue 080 — several tests below stub the global `fetch` (there is no DI
// seam for the HTTP client at the store layer, mirrors sync.ts's own
// convention/sync.test.ts's own cleanup) to drive acceptInvitation's new
// `/accept` POST without a live network.
afterEach(() => {
  vi.unstubAllGlobals()
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

// Issue 080 — replaces the old enqueueLocalMutation('workspace_members',...)
// + flush() through the generic write-path (issue 057, now removed): that
// path's tenancy guard can never authorize a first-time accept. This block
// covers the store-level wiring to the new dedicated `/accept` endpoint
// (src/sync/acceptTransport.ts is exhaustively DI-tested in isolation; these
// drive the store-level seam — the real `fetch`, stubbed globally, mirrors
// sync.test.ts's own "write-queue flush" describe block's convention, since
// there is no DI seam for the HTTP client at the store layer).
describe('acceptInvitation — POSTs to the dedicated /accept endpoint, scoped to the INVITER\'s workspace (issue 080)', () => {
  it('POSTs { invitationId, workspaceId } where workspaceId is the inviter\'s workspace, not the accepter\'s own — and enqueues NOTHING on the old write-path queue', async () => {
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ outcome: { status: 'applied', workspaceId: inviterWs.id, role: 'editor' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/accept')
    const body = JSON.parse(init.body as string) as { invitationId: string; workspaceId: string }
    expect(body).toEqual({ invitationId: inv.id, workspaceId: inviterWs.id })
    expect(body.workspaceId).not.toBe(accepterOwnWs)

    // The old generic write-path queue is untouched — this producer no
    // longer enqueues onto it at all (issue 080 removed that path entirely).
    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  it('makes no request when signed out / sync is off (local-only, byte-for-byte unchanged)', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    // useSyncStore.workspaceId left at its default null — sync never configured.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })
})

// Issue 080 — a server-side rejection of the accept must surface as a calm
// status-bar announcement, never a thrown error: PendingInvitations.tsx's
// `InvitationRow` calls acceptInvitation via an unguarded
// `void acceptInvitation(invitation.id)`, so an uncaught throw here would
// become an unhandled promise rejection the UI never shows the user.
describe('acceptInvitation — server rejection surfaces via announce(), never throws (issue 080)', () => {
  it('a { outcome: rejected } response announces the server\'s message and resolves normally (does not throw)', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    useSyncStore.setState({ workspaceId: workspaceIdForSub('sub-invitee') })
    const rejectionMessage = 'This invitation is no longer valid — it may have expired, been revoked, or already been used.'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ outcome: { status: 'rejected', reason: 'invitation_not_found', message: rejectionMessage } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(useWorkspaceStore.getState().acceptInvitation(inv.id)).resolves.toBeUndefined()

    expect(useStatusStore.getState().message).toBe(rejectionMessage)
  })

  it('a wholesale 401 (auth-rejected) response announces the rejection message without throwing', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    useSyncStore.setState({ workspaceId: workspaceIdForSub('sub-invitee') })
    const rejectionMessage = 'Your session has expired or is invalid — sign in again to accept this invitation.'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ rejection: { reason: 'expired_token', message: rejectionMessage } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(useWorkspaceStore.getState().acceptInvitation(inv.id)).resolves.toBeUndefined()

    expect(useStatusStore.getState().message).toBe(rejectionMessage)
  })

  it('a network error (fetch throws) announces a calm message without throwing', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    useSyncStore.setState({ workspaceId: workspaceIdForSub('sub-invitee') })
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(useWorkspaceStore.getState().acceptInvitation(inv.id)).resolves.toBeUndefined()

    expect(useStatusStore.getState().message).toMatch(/could not reach the server/i)
  })

  it('a successful applied response announces nothing (the refreshed project list is itself the confirmation)', async () => {
    const inviterWs = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, inviterWs.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({ status: 'authenticated', configured: true, user: { sub: 'sub-invitee', email: 'invitee@example.com' } })
    useSyncStore.setState({ workspaceId: workspaceIdForSub('sub-invitee') })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ outcome: { status: 'applied', workspaceId: inviterWs.id, role: 'editor' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await useWorkspaceStore.getState().acceptInvitation(inv.id)

    expect(useStatusStore.getState().message).toBeNull()
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

// Issue 066 — revokeInvitation/declineInvitation/resendInvitation were
// local-PGlite-only (055/060's own limitation note): the revoke/decline/
// resend never reached RDS, so a revoked/declined/resent invitation stayed
// live server-side forever. Mirrors the invite/changeRole/removeMember sync-
// enqueue tests above (issue 056) exactly — signed-in queues exactly one
// pending mutation, signed-out/sync-off stays local-only.
describe('revokeInvitation / declineInvitation / resendInvitation — sync enqueue (issue 066)', () => {
  it('revokeInvitation() enqueues an `invitations` delete (tombstone) once a sync workspace is set', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')
    await useWorkspaceStore.getState().load(ws.id)
    useSyncStore.setState({ workspaceId: ws.id })

    await useWorkspaceStore.getState().revokeInvitation(inv.id)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'invitations',
      rowId: inv.id,
      op: 'delete',
      status: 'pending',
    })
    expect((queued[0]?.row as { deletedAt: unknown }).deletedAt).not.toBeNull()
  })

  it('revokeInvitation() enqueues nothing when signed out / sync is off (local-only, byte-for-byte unchanged)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner')
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().revokeInvitation(inv.id)

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  it('resendInvitation() enqueues an `invitations` update carrying the new expiry once a sync workspace is set', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner', 1)
    await useWorkspaceStore.getState().load(ws.id)
    useSyncStore.setState({ workspaceId: ws.id })

    await useWorkspaceStore.getState().resendInvitation(inv.id)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'invitations',
      rowId: inv.id,
      op: 'update',
      status: 'pending',
    })
    const queuedExpiresAt = (queued[0]?.row as { expiresAt: string }).expiresAt
    expect(new Date(queuedExpiresAt).getTime()).toBeGreaterThan(new Date(inv.expiresAt).getTime())
  })

  it('resendInvitation() enqueues nothing when signed out / sync is off (local-only, byte-for-byte unchanged)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'viewer', 'sub-owner', 1)
    await useWorkspaceStore.getState().load(ws.id)

    await useWorkspaceStore.getState().resendInvitation(inv.id)

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
  })

  // declineInvitation is the INVITEE's side (mirrors acceptInvitation, issue
  // 057): the invitee's own workspace panel is never "open" for the
  // inviter's workspace, so the mutation must carry an explicit `workspaceId`
  // override (the invitation's own workspaceId) rather than relying on the
  // flush's global useSyncStore.workspaceId (the invitee's OWN personal
  // workspace).
  it('declineInvitation() enqueues an `invitations` delete (tombstone) scoped to the invitation\'s own workspace once signed in with sync configured', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })
    const accepterOwnWs = workspaceIdForSub('sub-invitee')
    expect(accepterOwnWs).not.toBe(ws.id)
    useSyncStore.setState({ workspaceId: accepterOwnWs })
    await useWorkspaceStore.getState().loadMyInvitations()

    await useWorkspaceStore.getState().declineInvitation(inv.id)

    const queued = useSyncStore.getState().queue.entries
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      table: 'invitations',
      rowId: inv.id,
      op: 'delete',
      status: 'pending',
      workspaceId: ws.id,
    })
    expect(queued[0]?.workspaceId).not.toBe(accepterOwnWs)
  })

  it('declineInvitation() enqueues nothing when signed out / sync is off (local-only, byte-for-byte unchanged)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'invitee@example.com', 'editor', 'sub-owner')
    useAuthStore.setState({
      status: 'authenticated',
      configured: true,
      user: { sub: 'sub-invitee', email: 'invitee@example.com' },
    })
    // useSyncStore.workspaceId left at its default null — sync never configured.
    await useWorkspaceStore.getState().loadMyInvitations()

    await useWorkspaceStore.getState().declineInvitation(inv.id)

    expect(useSyncStore.getState().queue.entries).toHaveLength(0)
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
