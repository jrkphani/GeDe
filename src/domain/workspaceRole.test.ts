import { describe, expect, it } from 'vitest'
import { canManageMembers, canWrite, roleAtLeast, WORKSPACE_ROLES } from './workspaceRole'

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
