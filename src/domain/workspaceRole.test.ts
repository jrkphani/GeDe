import { describe, expect, it } from 'vitest'
import { canManageMembers, canWrite, resolveEffectiveRole, roleAtLeast, WORKSPACE_ROLES } from './workspaceRole'

describe('roleAtLeast', () => {
  it('orders owner > editor > viewer', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true)
    expect(roleAtLeast('owner', 'editor')).toBe(true)
    expect(roleAtLeast('owner', 'owner')).toBe(true)
    expect(roleAtLeast('editor', 'owner')).toBe(false)
    expect(roleAtLeast('viewer', 'editor')).toBe(false)
    expect(roleAtLeast('viewer', 'viewer')).toBe(true)
  })
})

describe('canWrite', () => {
  it('is true for owner and editor, false for viewer — mirrors migration 0008 policies', () => {
    expect(canWrite('owner')).toBe(true)
    expect(canWrite('editor')).toBe(true)
    expect(canWrite('viewer')).toBe(false)
  })
})

describe('canManageMembers', () => {
  it('is owner-only — mirrors workspace_members policies', () => {
    expect(canManageMembers('owner')).toBe(true)
    expect(canManageMembers('editor')).toBe(false)
    expect(canManageMembers('viewer')).toBe(false)
  })
})

describe('WORKSPACE_ROLES', () => {
  it('matches the DB enum values (migration 0008)', () => {
    expect(WORKSPACE_ROLES).toEqual(['owner', 'editor', 'viewer'])
  })
})

describe('resolveEffectiveRole (issue 035 — client-side UI affordance, not the enforcement boundary)', () => {
  it('solo/local mode (auth not configured) is always owner — v1 stays unchanged', () => {
    expect(resolveEffectiveRole([], null, false)).toBe('owner')
    expect(resolveEffectiveRole([{ userSub: 'sub-a', role: 'viewer' }], null, false)).toBe('owner')
  })

  it('signed out (configured but no user) is treated as owner — the same local/anonymous fallback', () => {
    expect(resolveEffectiveRole([{ userSub: 'sub-a', role: 'viewer' }], null, true)).toBe('owner')
  })

  it('an authenticated caller with zero membership rows on the workspace is owner (legacy/never-seated data, matches getOrCreateDefaultWorkspace)', () => {
    expect(resolveEffectiveRole([], 'sub-a', true)).toBe('owner')
  })

  it('an authenticated caller who IS a member gets exactly their own row role', () => {
    const members = [
      { userSub: 'sub-owner', role: 'owner' as const },
      { userSub: 'sub-editor', role: 'editor' as const },
      { userSub: 'sub-viewer', role: 'viewer' as const },
    ]
    expect(resolveEffectiveRole(members, 'sub-owner', true)).toBe('owner')
    expect(resolveEffectiveRole(members, 'sub-editor', true)).toBe('editor')
    expect(resolveEffectiveRole(members, 'sub-viewer', true)).toBe('viewer')
  })

  it('an authenticated caller who is NOT among existing members defaults to least privilege, not owner', () => {
    const members = [{ userSub: 'sub-owner', role: 'owner' as const }]
    expect(resolveEffectiveRole(members, 'sub-stranger', true)).toBe('viewer')
  })
})
