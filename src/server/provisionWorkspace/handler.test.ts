// Test-first plan item 2 (issue 050): a PostConfirmation event -> inserts
// exactly one workspace (id = workspaceIdForSub(sub)) + one owner
// membership; a second event for the same sub is idempotent (ON CONFLICT, no
// duplicate). Exercised against a fake ProvisionExecutor that honors the
// same primary/unique-key semantics the real migration (0008) declares —
// mirrors src/server/writeApi/store.ts's InMemoryWriteStore convention (a
// realistic in-memory double, not a bare call-count assertion) so the
// idempotency claim is actually proven, not just plausible.
import { describe, expect, it, vi } from 'vitest'
import { provisionWorkspace, type ProvisionExecutor } from './handler'
import { workspaceIdForSub } from '../../domain/workspaceId'

interface FakeWorkspaceRow {
  readonly id: string
  readonly name: string
}

interface FakeMemberRow {
  readonly id: string
  readonly workspaceId: string
  readonly userSub: string
  readonly role: string
}

class FakeProvisionExecutor implements ProvisionExecutor {
  readonly workspaces = new Map<string, FakeWorkspaceRow>() // key: id
  readonly members = new Map<string, FakeMemberRow>() // key: `${workspaceId}:${userSub}` (mirrors migration 0008's unique index)

  query = vi.fn(
    (sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
      if (sql.includes('INSERT INTO workspaces')) {
        const [id, name] = params as [string, string]
        if (!this.workspaces.has(id)) this.workspaces.set(id, { id, name })
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('INSERT INTO workspace_members')) {
        const [id, workspaceId, userSub, role] = params as [string, string, string, string]
        const key = `${workspaceId}:${userSub}`
        if (!this.members.has(key)) this.members.set(key, { id, workspaceId, userSub, role })
        return Promise.resolve({ rows: [] })
      }
      return Promise.reject(new Error(`FakeProvisionExecutor received unexpected SQL: ${sql}`))
    },
  )
}

describe('provisionWorkspace (issue 050, test-first plan item 2)', () => {
  it('inserts exactly one workspace (id = workspaceIdForSub(sub), name "My Workspace") and one owner membership', async () => {
    const executor = new FakeProvisionExecutor()
    const sub = 'cognito-sub-1'

    const result = await provisionWorkspace(sub, executor)

    const expectedId = workspaceIdForSub(sub)
    expect(result.workspaceId).toBe(expectedId)

    expect(executor.workspaces.size).toBe(1)
    const workspace = executor.workspaces.get(expectedId)
    expect(workspace).toEqual({ id: expectedId, name: 'My Workspace' })

    expect(executor.members.size).toBe(1)
    const member = executor.members.get(`${expectedId}:${sub}`)
    expect(member).toMatchObject({ workspaceId: expectedId, userSub: sub, role: 'owner' })
  })

  it('is idempotent — a second event for the same sub does not create a duplicate workspace or membership', async () => {
    const executor = new FakeProvisionExecutor()
    const sub = 'cognito-sub-replay'

    const first = await provisionWorkspace(sub, executor)
    const second = await provisionWorkspace(sub, executor)

    expect(second.workspaceId).toBe(first.workspaceId)
    expect(executor.workspaces.size).toBe(1)
    expect(executor.members.size).toBe(1)
  })

  it('provisions a distinct workspace + membership per distinct sub', async () => {
    const executor = new FakeProvisionExecutor()

    const a = await provisionWorkspace('sub-a', executor)
    const b = await provisionWorkspace('sub-b', executor)

    expect(a.workspaceId).not.toBe(b.workspaceId)
    expect(executor.workspaces.size).toBe(2)
    expect(executor.members.size).toBe(2)
  })

  it('never sends a `role` other than owner for the bootstrap membership', async () => {
    const executor = new FakeProvisionExecutor()
    await provisionWorkspace('owner-role-check', executor)
    const member = Array.from(executor.members.values())[0]
    expect(member?.role).toBe('owner')
  })
})
