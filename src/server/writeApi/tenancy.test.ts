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

// `members` is a set of `${workspaceId}:${sub}` keys — issue 057's
// membership-gated relaxation. Defaults to empty (no seeded membership), so
// every pre-057 call site that doesn't care about membership still gets the
// old "no membership anywhere" behavior for free.
function fixedResolver(
  workspaceByEntity: Record<string, string | null>,
  members: ReadonlySet<string> = new Set(),
): WorkspaceScopeResolver {
  return {
    resolveWorkspaceForEntity: (_table, entityId) => Promise.resolve(workspaceByEntity[entityId] ?? null),
    isMember: (workspaceId, sub) => Promise.resolve(members.has(`${workspaceId}:${sub}`)),
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

// Issue 057 — the invariant-breaking core: a caller may now write into a
// workspace that isn't their own (`claims.workspaceId`), but ONLY when a
// real, seeded membership row proves it. This must never become a blanket
// removal of the tenancy check — every "accepted" case below has a mirrored
// "rejected" case with the membership row missing.
describe('checkTenancy — issue 057: membership-gated access to a non-own workspace', () => {
  it('(a) accepts an insert into a non-own workspace when a real membership row is seeded', async () => {
    const mutation = envelope({ op: 'insert', workspaceId: 'ws-other' })
    const resolver = fixedResolver({}, new Set(['ws-other:user-1']))
    const result = await checkTenancy(mutation, CLAIMS, resolver)
    expect(result).toEqual({ ok: true })
  })

  it('(b) rejects the identical shape as (a) when NO membership row is seeded — proves the relaxation is gated, not a blanket removal', async () => {
    const mutation = envelope({ op: 'insert', workspaceId: 'ws-other' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({}))
    expect(result).toEqual({ ok: false, reason: 'cross_tenant' })
  })

  it('(c) an own-workspace mutation still works, with no membership lookup needed', async () => {
    const mutation = envelope({ op: 'insert', workspaceId: 'ws-1' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({}))
    expect(result).toEqual({ ok: true })
  })

  it('accepts an update into a non-own workspace, as a member, whose target row genuinely belongs to the declared workspace', async () => {
    const mutation = envelope({ op: 'update', workspaceId: 'ws-other', entityId: 'row-1' })
    const resolver = fixedResolver({ 'row-1': 'ws-other' }, new Set(['ws-other:user-1']))
    const result = await checkTenancy(mutation, CLAIMS, resolver)
    expect(result).toEqual({ ok: true })
  })

  it('(d) still rejects a member update whose target entity resolves to a DIFFERENT workspace than the envelope declared — the entity-scope check survives the relaxation', async () => {
    const mutation = envelope({ op: 'update', workspaceId: 'ws-other', entityId: 'row-1' })
    // caller IS a member of ws-other, but the entity itself actually lives in
    // ws-yet-another — a member of A must not be able to edit B's row just by
    // lying about the envelope's declared workspaceId.
    const resolver = fixedResolver({ 'row-1': 'ws-yet-another' }, new Set(['ws-other:user-1']))
    const result = await checkTenancy(mutation, CLAIMS, resolver)
    expect(result).toEqual({ ok: false, reason: 'cross_tenant' })
  })

  it('rejects a delete into a non-own workspace with no membership, even for an unknown entity (membership is checked before entity resolution)', async () => {
    const mutation = envelope({ op: 'delete', workspaceId: 'ws-other', entityId: 'ghost' })
    const result = await checkTenancy(mutation, CLAIMS, fixedResolver({}))
    expect(result).toEqual({ ok: false, reason: 'cross_tenant' })
  })
})
