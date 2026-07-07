import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from './client'
import {
  addWorkspaceMember,
  createWorkspace,
  getOrCreateDefaultWorkspace,
  getOrCreateUserWorkspace,
  listMembers,
  listWorkspaceIdsForUser,
  listWorkspacesForUser,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
} from './workspaces'

let db: Database

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
})

describe('createWorkspace', () => {
  it('creates a workspace and, given an owner sub, seats them as owner', async () => {
    const ws = await createWorkspace(db, 'Acme', 'sub-owner')
    expect(ws.name).toBe('Acme')
    const members = await listMembers(db, ws.id)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ userSub: 'sub-owner', role: 'owner' })
  })

  it('creates a workspace with no members when no owner sub is given', async () => {
    const ws = await createWorkspace(db, 'Empty')
    expect(await listMembers(db, ws.id)).toHaveLength(0)
  })
})

describe('getOrCreateDefaultWorkspace', () => {
  it('creates exactly one "Personal Workspace" on first call', async () => {
    const id = await getOrCreateDefaultWorkspace(db)
    expect(id).toBeTruthy()
  })

  it('is idempotent — a second call returns the same workspace id', async () => {
    const first = await getOrCreateDefaultWorkspace(db)
    const second = await getOrCreateDefaultWorkspace(db)
    expect(second).toBe(first)
  })

  it('reuses an existing workspace even if it was not named "Personal Workspace"', async () => {
    const ws = await createWorkspace(db, 'Some Team')
    const id = await getOrCreateDefaultWorkspace(db)
    expect(id).toBe(ws.id)
  })
})

describe('membership scoping (test-first plan #2)', () => {
  it('adding a member changes exactly which workspaces they can reach', async () => {
    const wsA = await createWorkspace(db, 'A')
    const wsB = await createWorkspace(db, 'B')
    await addWorkspaceMember(db, wsA.id, 'sub-x', 'editor')

    expect(await listWorkspaceIdsForUser(db, 'sub-x')).toEqual([wsA.id])

    await addWorkspaceMember(db, wsB.id, 'sub-x', 'viewer')
    expect(await listWorkspaceIdsForUser(db, 'sub-x')).toEqual(
      expect.arrayContaining([wsA.id, wsB.id]),
    )
  })

  it('removing a member drops that workspace from their reachable set', async () => {
    const wsA = await createWorkspace(db, 'A')
    await addWorkspaceMember(db, wsA.id, 'sub-x', 'editor')
    expect(await listWorkspaceIdsForUser(db, 'sub-x')).toEqual([wsA.id])

    await removeWorkspaceMember(db, wsA.id, 'sub-x')
    expect(await listWorkspaceIdsForUser(db, 'sub-x')).toEqual([])
  })

  it('re-adding a removed member restores access (upsert, not a duplicate row)', async () => {
    const wsA = await createWorkspace(db, 'A')
    await addWorkspaceMember(db, wsA.id, 'sub-x', 'editor')
    await removeWorkspaceMember(db, wsA.id, 'sub-x')
    await addWorkspaceMember(db, wsA.id, 'sub-x', 'viewer')

    const members = await listMembers(db, wsA.id)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ role: 'viewer', deletedAt: null })
  })

  it('setWorkspaceMemberRole changes role without changing membership set', async () => {
    const wsA = await createWorkspace(db, 'A')
    await addWorkspaceMember(db, wsA.id, 'sub-x', 'viewer')
    await setWorkspaceMemberRole(db, wsA.id, 'sub-x', 'owner')
    const members = await listMembers(db, wsA.id)
    expect(members[0]?.role).toBe('owner')
  })
})

// Issue 037 — the local→cloud on-ramp's "target picker" seam.
describe('listWorkspacesForUser', () => {
  it('returns nothing for a sub with no membership', async () => {
    expect(await listWorkspacesForUser(db, 'sub-x')).toEqual([])
  })

  it('returns every live workspace a sub belongs to, oldest first', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-x')
    const wsB = await createWorkspace(db, 'B', 'sub-x')
    const result = await listWorkspacesForUser(db, 'sub-x')
    expect(result.map((w) => w.id)).toEqual([wsA.id, wsB.id])
  })

  it('excludes a workspace the sub was removed from', async () => {
    const wsA = await createWorkspace(db, 'A', 'sub-x')
    await removeWorkspaceMember(db, wsA.id, 'sub-x')
    expect(await listWorkspacesForUser(db, 'sub-x')).toEqual([])
  })
})

describe('getOrCreateUserWorkspace', () => {
  it('creates a personal workspace, seating the sub as owner, on first use', async () => {
    const ws = await getOrCreateUserWorkspace(db, 'sub-x')
    expect(ws.name).toBe('My Workspace')
    const members = await listMembers(db, ws.id)
    expect(members).toEqual([expect.objectContaining({ userSub: 'sub-x', role: 'owner' })])
  })

  it('is idempotent — a second call returns the same workspace, not a second one', async () => {
    const first = await getOrCreateUserWorkspace(db, 'sub-x')
    const second = await getOrCreateUserWorkspace(db, 'sub-x')
    expect(second.id).toBe(first.id)
    expect(await listWorkspacesForUser(db, 'sub-x')).toHaveLength(1)
  })

  it('reuses an existing membership instead of creating a second personal workspace', async () => {
    const invited = await createWorkspace(db, 'Acme', 'sub-owner')
    await addWorkspaceMember(db, invited.id, 'sub-x', 'editor')
    const ws = await getOrCreateUserWorkspace(db, 'sub-x')
    expect(ws.id).toBe(invited.id)
  })

  it("two different subs each get their own workspace", async () => {
    const a = await getOrCreateUserWorkspace(db, 'sub-a')
    const b = await getOrCreateUserWorkspace(db, 'sub-b')
    expect(a.id).not.toBe(b.id)
  })
})
