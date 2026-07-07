import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type Database } from './client'
import { createWorkspace, listMembers } from './workspaces'
import {
  acceptInvitation,
  createInvitation,
  InvitationEmailMismatchError,
  InvitationNotAcceptableError,
  InvitationNotFoundError,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from './invitations'

let db: Database

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
})

describe('createInvitation', () => {
  it('creates a pending invitation, email lowercased, defaulting to a 7-day expiry', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const before = Date.now()
    const inv = await createInvitation(db, ws.id, 'Person@Example.com', 'editor', 'sub-owner')
    expect(inv.email).toBe('person@example.com')
    expect(inv.role).toBe('editor')
    expect(inv.acceptedAt).toBeNull()
    expect(inv.deletedAt).toBeNull()
    const ttlMs = new Date(inv.expiresAt).getTime() - before
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
    expect(ttlMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000)
  })
})

describe('listInvitations', () => {
  it('lists every invitation for a workspace, most recent first', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    await createInvitation(db, ws.id, 'a@example.com', 'viewer', 'sub-owner')
    await createInvitation(db, ws.id, 'b@example.com', 'editor', 'sub-owner')
    const invs = await listInvitations(db, ws.id)
    expect(invs.map((i) => i.email)).toEqual(['b@example.com', 'a@example.com'])
  })
})

describe('acceptInvitation (test-first plan #1 — invite → accept → RLS scope)', () => {
  it('adds a workspace_members row with the invited role and marks the invitation accepted', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'editor', 'sub-owner')

    const member = await acceptInvitation(db, inv.id, 'sub-invitee', 'Person@Example.com')
    expect(member).toMatchObject({ workspaceId: ws.id, userSub: 'sub-invitee', role: 'editor' })

    const members = await listMembers(db, ws.id)
    expect(members.map((m) => m.userSub)).toEqual(expect.arrayContaining(['sub-owner', 'sub-invitee']))

    const [reloaded] = await listInvitations(db, ws.id)
    expect(reloaded?.acceptedAt).not.toBeNull()
  })

  it('rejects an email that does not match the invitation (typed rejection)', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner')
    await expect(acceptInvitation(db, inv.id, 'sub-invitee', 'someone-else@example.com')).rejects.toBeInstanceOf(
      InvitationEmailMismatchError,
    )
  })

  it('rejects acceptance of an unknown invitation id', async () => {
    await expect(acceptInvitation(db, 'nonexistent', 'sub-invitee', 'x@example.com')).rejects.toBeInstanceOf(
      InvitationNotFoundError,
    )
  })

  it('rejects a second accept of an already-accepted invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner')
    await acceptInvitation(db, inv.id, 'sub-invitee', 'person@example.com')
    await expect(acceptInvitation(db, inv.id, 'sub-invitee', 'person@example.com')).rejects.toBeInstanceOf(
      InvitationNotAcceptableError,
    )
  })

  it('rejects acceptance of an expired invitation', async () => {
    vi.useFakeTimers()
    try {
      const ws = await createWorkspace(db, 'Acme', 'sub-owner')
      const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner', 1)
      vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
      await expect(acceptInvitation(db, inv.id, 'sub-invitee', 'person@example.com')).rejects.toBeInstanceOf(
        InvitationNotAcceptableError,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects acceptance of a revoked invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner')
    await revokeInvitation(db, inv.id)
    await expect(acceptInvitation(db, inv.id, 'sub-invitee', 'person@example.com')).rejects.toBeInstanceOf(
      InvitationNotAcceptableError,
    )
  })
})

describe('revokeInvitation (test-first plan #3 — revoke)', () => {
  it('soft-deletes the invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner')
    await revokeInvitation(db, inv.id)
    const [reloaded] = await listInvitations(db, ws.id)
    expect(reloaded?.deletedAt).not.toBeNull()
  })
})

describe('resendInvitation', () => {
  it('extends the expiry of a pending invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner', 1)
    const resent = await resendInvitation(db, inv.id, 14)
    const ttlMs = new Date(resent.expiresAt).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(13.9 * 24 * 60 * 60 * 1000)
  })

  it('rejects resending an already-accepted invitation', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    const inv = await createInvitation(db, ws.id, 'person@example.com', 'viewer', 'sub-owner')
    await acceptInvitation(db, inv.id, 'sub-invitee', 'person@example.com')
    await expect(resendInvitation(db, inv.id)).rejects.toBeInstanceOf(InvitationNotAcceptableError)
  })
})
