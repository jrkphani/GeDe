import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { checkTenancy, type WorkspaceScopeResolver } from './tenancy'
import type { MutationEnvelope } from '../../domain/mutationProtocol'

const CLAIMS = { sub: 'user-1', workspaceId: 'ws-1' }

function envelope(overrides: Partial<MutationEnvelope> = {}): MutationEnvelope {
  return {
    id: uuidv7(),
    workspaceId: 'ws-1',
    table: 'dimensions',
    op: 'update',
    entityId: uuidv7(),
    payload: {},
    clientUpdatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function fixedResolver(workspaceByEntity: Record<string, string | null>): WorkspaceScopeResolver {
  return {
    resolveWorkspaceForEntity: (_table, entityId) => Promise.resolve(workspaceByEntity[entityId] ?? null),
  }
}

describe('checkTenancy', () => {
  it('rejects an insert declaring a workspace other than the caller\'s own', async () => {
    const mutation = envelope({ op: 'insert', workspaceId: 'ws-other' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({}))
    expect(result).toEqual({ ok: false, reason: 'cross_tenant' })
  })

  it('accepts an insert into the caller\'s own workspace', async () => {
    const mutation = envelope({ op: 'insert', workspaceId: 'ws-1' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({}))
    expect(result).toEqual({ ok: true })
  })

  it('rejects an update/delete targeting a row that actually belongs to another workspace, even if the envelope lies', async () => {
    const mutation = envelope({ op: 'update', workspaceId: 'ws-1', entityId: 'row-1' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({ 'row-1': 'ws-other' }))
    expect(result).toEqual({ ok: false, reason: 'cross_tenant' })
  })

  it('rejects an update/delete targeting an unknown or deleted row', async () => {
    const mutation = envelope({ op: 'delete', entityId: 'ghost' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({}))
    expect(result).toEqual({ ok: false, reason: 'unknown_entity' })
  })

  it('accepts an update/delete whose target row genuinely belongs to the caller\'s workspace', async () => {
    const mutation = envelope({ op: 'update', workspaceId: 'ws-1', entityId: 'row-1' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({ 'row-1': 'ws-1' }))
    expect(result).toEqual({ ok: true })
  })
})
