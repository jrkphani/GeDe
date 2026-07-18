// Server integration tests (issue 043 acceptance criterion: "server
// integration tests green") — exercise auth -> tenancy -> invariants ->
// idempotency -> LWW -> persist end to end, against the InMemoryWriteStore
// (no live Postgres/Cognito reachable in tests, HANDOFF) and a locally
// signed JWT (no network JWKS fetch).
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { handleWriteRequest, type WriteApiDeps } from './handler'
import { InMemoryWriteStore } from './store'
import type { MutationEnvelope } from '../../domain/mutationProtocol'
import type { JwtVerifierConfig } from './jwt'
import { workspaceIdForSub } from '../../domain/workspaceId'

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST'
const KID = 'k1'
// The write path derives the workspace from the sub (issue 050), so tokens
// signed for `user-1` are scoped to this id — envelopes/seeds must use it too.
const WS1 = workspaceIdForSub('user-1')
let privateKey: CryptoKey
let jwtConfig: JwtVerifierConfig

async function tokenFor(sub: string, workspaceId: string, expiresIn = '5m'): Promise<string> {
  return new SignJWT({ sub, 'custom:workspace_id': workspaceId })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

beforeAll(async () => {
  const { publicKey, privateKey: sk } = await generateKeyPair('RS256')
  privateKey = sk
  const jwk: JWK = await exportJWK(publicKey)
  jwk.kid = KID
  jwk.alg = 'RS256'
  jwtConfig = { issuer: ISSUER, getKey: createLocalJWKSet({ keys: [jwk] }) }
})

function envelope(overrides: Partial<MutationEnvelope> = {}): MutationEnvelope {
  return {
    id: uuidv7(),
    workspaceId: WS1,
    table: 'projects',
    op: 'insert',
    entityId: uuidv7(),
    payload: { name: 'New project' },
    clientUpdatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function deps(store = new InMemoryWriteStore()): WriteApiDeps {
  return { jwt: jwtConfig, store }
}

describe('handleWriteRequest — auth gate (test-first plan item 1)', () => {
  it('rejects the whole batch with 401 when the Authorization header is missing', async () => {
    const result = await handleWriteRequest({ authorizationHeader: undefined, mutations: [envelope()] }, deps())
    expect(result.status).toBe(401)
  })

  it('rejects the whole batch with 401 when the token is expired', async () => {
    const token = await tokenFor('user-1', WS1, '-10s')
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [envelope()] }, deps())
    expect(result.status).toBe(401)
    if (result.status === 401) expect(result.rejection.reason).toBe('expired_token')
  })

  it('accepts a batch with a valid token', async () => {
    const token = await tokenFor('user-1', WS1)
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [envelope()] }, deps())
    expect(result.status).toBe(200)
  })
})

// Issue 071 — every `/write` was 502ing because the caller's workspace row
// was never provisioned in RDS (provisioning is a one-shot Cognito
// PostConfirmation trigger with no self-heal, docs/issues/
// 071-write-path-self-heal-workspace-provisioning.md). The fix: self-heal
// the CALLER's own workspace (never the mutation's declared workspaceId)
// before any mutation in the batch is touched. These tests spy on
// `InMemoryWriteStore`'s new `ensureOwnWorkspace` method via `vi.spyOn` —
// which requires the method to actually exist on the object being spied on,
// so both tests fail today with "could not find an object to spy upon"
// (the method doesn't exist yet), exactly the red-first signal this issue's
// test-first plan calls for.
describe('handleWriteRequest — own-workspace self-heal (071)', () => {
  it('calls store.ensureOwnWorkspace with the caller\'s verified sub before processing any mutation', async () => {
    const store = new InMemoryWriteStore()
    const ensureSpy = vi.spyOn(store, 'ensureOwnWorkspace')
    const applySpy = vi.spyOn(store, 'applyIfNew')
    const token = await tokenFor('user-1', WS1)

    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [envelope()] }, deps(store))

    expect(result.status).toBe(200)
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(ensureSpy).toHaveBeenCalledWith('user-1')
    expect(applySpy).toHaveBeenCalledTimes(1)
    // Ordering: ensureOwnWorkspace's invocation must precede applyIfNew's —
    // vitest's invocationCallOrder is a single, cross-spy monotonic counter.
    expect(ensureSpy.mock.invocationCallOrder[0]).toBeLessThan(applySpy.mock.invocationCallOrder[0] as number)
  })

  it('only ever self-heals the caller\'s OWN sub, never a shared/member workspace id (sharing-safety, 056/057)', async () => {
    const store = new InMemoryWriteStore()
    const WS_A = workspaceIdForSub('user-a')
    store.seedWorkspace(WS_A)
    store.seedMembership(WS_A, 'user-b')
    const ensureSpy = vi.spyOn(store, 'ensureOwnWorkspace')
    const token = await tokenFor('user-b', workspaceIdForSub('user-b'))
    // user-b writes into user-a's shared workspace (a legitimate 057 member
    // write) — this must self-heal ONLY user-b's own workspace, never touch
    // or re-provision user-a's row.
    const mutation = envelope({
      workspaceId: WS_A,
      table: 'workspaceMembers',
      op: 'insert',
      payload: { workspaceId: WS_A, userSub: 'user-b', role: 'editor' },
    })

    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))

    expect(result.status).toBe(200)
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(ensureSpy).toHaveBeenCalledWith('user-b')
    expect(ensureSpy).not.toHaveBeenCalledWith('user-a')
  })
})

describe('handleWriteRequest — tenancy (test-first plan item 2)', () => {
  it('rejects an insert into another workspace even with a valid JWT', async () => {
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({ workspaceId: 'ws-other' })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps())
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })

  it('rejects an update targeting a row that belongs to another workspace', async () => {
    const store = new InMemoryWriteStore()
    const rowId = uuidv7()
    store.seed({ id: rowId, workspaceId: 'ws-other', table: 'projects', data: { name: 'Theirs' }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({ op: 'update', entityId: rowId, workspaceId: WS1, payload: { name: 'Hijacked' } })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })
})

describe('handleWriteRequest — invariant enforcement (test-first plan item 3)', () => {
  it('rejects a dimension delete that would drop the canvas below the floor', async () => {
    const store = new InMemoryWriteStore()
    const projectId = uuidv7()
    const [firstDimId, secondDimId] = [uuidv7(), uuidv7()] // exactly 2 — the floor
    for (const id of [firstDimId, secondDimId]) {
      store.seed({ id, workspaceId: WS1, table: 'dimensions', data: { projectId, contextId: null }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    }
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({ table: 'dimensions', op: 'delete', entityId: firstDimId, payload: {} })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'dimension_floor' })
    }
  })

  it('allows a dimension delete when above the floor', async () => {
    const store = new InMemoryWriteStore()
    const projectId = uuidv7()
    const [firstDimId, secondDimId, thirdDimId] = [uuidv7(), uuidv7(), uuidv7()]
    for (const id of [firstDimId, secondDimId, thirdDimId]) {
      store.seed({ id, workspaceId: WS1, table: 'dimensions', data: { projectId, contextId: null }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    }
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({ table: 'dimensions', op: 'delete', entityId: firstDimId, payload: {} })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
  })

  it('rejects a binding insert that would duplicate an occupied (context, dimension) pair', async () => {
    const store = new InMemoryWriteStore()
    const contextId = uuidv7()
    const dimensionId = uuidv7()
    store.seed({
      id: uuidv7(),
      workspaceId: WS1,
      table: 'bindings',
      data: { contextId, dimensionId, parameterId: uuidv7() },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'bindings',
      op: 'insert',
      payload: { contextId, dimensionId, parameterId: uuidv7() },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'binding_uniqueness' })
    }
  })

  it('rejects a mutation whose foreign key does not resolve to a live row (illegal tuple)', async () => {
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'parameters',
      op: 'insert',
      payload: { dimensionId: 'does-not-exist', name: 'Ghost' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps())
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'referential_integrity' })
    }
  })
})

// Issue 056 (055's Cause 2 fix, test-first plan item 4) — invitations/
// workspaceMembers are now routable through the write path exactly like
// every other table: the union type IS the allow-list (handler.ts's own
// comment), so once step 1 (MutationTable) lands, no bespoke allow-list
// entry is needed — only FK_SCHEMA/SQL_TABLE_NAMES (store.ts) do.
describe('handleWriteRequest — invitations / workspaceMembers are routable (issue 056)', () => {
  it('applies an invitations insert end to end and the row is present afterward', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS1)
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'invitations',
      op: 'insert',
      payload: {
        workspaceId: WS1,
        email: 'invitee@example.com',
        role: 'viewer',
        invitedBySub: 'user-1',
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
    const row = await store.getRow('invitations', mutation.entityId)
    expect(row?.data.email).toBe('invitee@example.com')
  })

  it('applies a workspaceMembers insert end to end and the row is present afterward', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS1)
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'workspaceMembers',
      op: 'insert',
      payload: { workspaceId: WS1, userSub: 'user-2', role: 'editor' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
    const row = await store.getRow('workspaceMembers', mutation.entityId)
    expect(row?.data.userSub).toBe('user-2')
  })

  // Issue 071 note: this used to seed nothing and target WS1 (the caller's
  // OWN workspace) to prove the referential-integrity check fires on an
  // unresolved workspace FK. Issue 071's self-heal now provisions the
  // caller's own workspace before every mutation, so WS1 always resolves for
  // user-1 — that scenario is exactly the bug 071 fixes, not a case that can
  // still legally reject. This test now targets a DIFFERENT workspace the
  // caller is a seeded MEMBER of (057) but which was never itself
  // provisioned (no `seedWorkspace`) — proving referential_integrity still
  // fires for a genuinely unprovisioned workspace, and that self-heal (071)
  // provisions ONLY the caller's own workspace, never one it merely has
  // member access to (the same sharing-safety property the 071 self-heal
  // tests above lock in).
  it('rejects an invitations insert whose workspaceId does not resolve to a live workspace (071: self-heal does not provision a member-accessible workspace)', async () => {
    const store = new InMemoryWriteStore() // no seedWorkspace(WS_OTHER) — it stays genuinely unprovisioned
    const WS_OTHER = workspaceIdForSub('someone-else')
    store.seedMembership(WS_OTHER, 'user-1') // passes tenancy as a member, but WS_OTHER itself never existed
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      workspaceId: WS_OTHER,
      table: 'invitations',
      op: 'insert',
      payload: {
        workspaceId: WS_OTHER,
        email: 'invitee@example.com',
        role: 'viewer',
        invitedBySub: 'user-1',
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'referential_integrity' })
    }
  })

  // Issue 066 — revokeInvitation/declineInvitation/resendInvitation now
  // enqueue update/delete mutations against an ALREADY-SYNCED invitations
  // row (unlike the insert-only coverage above); this proves the write path
  // accepts both ops end to end for `invitations` specifically, not just
  // that InMemoryWriteStore's generic op branches work in isolation.
  it('applies an invitations update (resend/extend-expiry) end to end and the new expiresAt is present afterward', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS1)
    const invitationId = uuidv7()
    store.seed({
      id: invitationId,
      workspaceId: WS1,
      table: 'invitations',
      data: { email: 'invitee@example.com', role: 'viewer', expiresAt: '2026-08-01T00:00:00.000Z' },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'invitations',
      op: 'update',
      entityId: invitationId,
      payload: { expiresAt: '2026-08-15T00:00:00.000Z' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
    const row = await store.getRow('invitations', invitationId)
    expect(row?.data.expiresAt).toBe('2026-08-15T00:00:00.000Z')
  })

  it('applies an invitations delete (revoke/decline tombstone) end to end and the row reads as gone afterward', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS1)
    const invitationId = uuidv7()
    store.seed({
      id: invitationId,
      workspaceId: WS1,
      table: 'invitations',
      data: { email: 'invitee@example.com', role: 'viewer', expiresAt: '2026-08-01T00:00:00.000Z' },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({ table: 'invitations', op: 'delete', entityId: invitationId, payload: {} })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
    expect(await store.rowExists('invitations', invitationId)).toBe(false)
    expect(await store.getRow('invitations', invitationId)).toBeNull()
  })
})

// Issue 057 — the write-path contract test from the design brief's test-first
// plan item 2: an authenticated caller (JWT sub = user B) submits a mutation
// targeting user A's workspace, having been SEEDED as a member of it — this
// exercises `handleWriteRequest` -> `checkTenancy` -> `store.isMember` end to
// end, not just `checkTenancy` in isolation (tenancy.test.ts covers that).
describe('handleWriteRequest — shared-workspace membership (issue 057)', () => {
  const WS_A = workspaceIdForSub('user-a')

  it('applies a workspaceMembers insert into another workspace when the caller is a seeded member', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS_A)
    store.seedMembership(WS_A, 'user-b')
    const token = await tokenFor('user-b', workspaceIdForSub('user-b'))
    const mutation = envelope({
      workspaceId: WS_A,
      table: 'workspaceMembers',
      op: 'insert',
      payload: { workspaceId: WS_A, userSub: 'user-b', role: 'editor' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
  })

  it('rejects the identical shape as cross_tenant when the caller has NO membership row for that workspace', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS_A)
    // no seedMembership — user-b is not (yet) a member of WS_A
    const token = await tokenFor('user-b', workspaceIdForSub('user-b'))
    const mutation = envelope({
      workspaceId: WS_A,
      table: 'workspaceMembers',
      op: 'insert',
      payload: { workspaceId: WS_A, userSub: 'user-b', role: 'editor' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })

  it('applies a project rename into another workspace as a seeded member', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS_A)
    store.seedMembership(WS_A, 'user-b')
    const projectId = uuidv7()
    store.seed({
      id: projectId,
      workspaceId: WS_A,
      table: 'projects',
      data: { name: 'Shared project' },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    const token = await tokenFor('user-b', workspaceIdForSub('user-b'))
    const mutation = envelope({ workspaceId: WS_A, table: 'projects', op: 'update', entityId: projectId, payload: { name: 'Renamed by B' } })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
    const row = await store.getRow('projects', projectId)
    expect(row?.data.name).toBe('Renamed by B')
  })

  // Requirement 2 (spec): the membership relaxation replaces only the FIRST
  // equality gate — a member of workspace A still must not be able to edit
  // an entity that actually belongs to a DIFFERENT workspace C, even by
  // declaring A in the envelope.
  it('still rejects a member update whose entity actually belongs to a third, different workspace', async () => {
    const store = new InMemoryWriteStore()
    const WS_C = workspaceIdForSub('user-c')
    store.seedWorkspace(WS_A)
    store.seedMembership(WS_A, 'user-b') // member of A, NOT C
    const projectId = uuidv7()
    store.seed({
      id: projectId,
      workspaceId: WS_C,
      table: 'projects',
      data: { name: 'Not shared with B' },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    const token = await tokenFor('user-b', workspaceIdForSub('user-b'))
    const mutation = envelope({ workspaceId: WS_A, table: 'projects', op: 'update', entityId: projectId, payload: { name: 'Hijack attempt' } })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
    const row = await store.getRow('projects', projectId)
    expect(row?.data.name).toBe('Not shared with B') // untouched
  })
})

// Issue 098 (SECURITY) — the write-path `insert`/`update` never verified that
// an FK-referenced row belongs to the caller's workspace, only that it EXISTS
// (resolveForeignKeys) and that the DECLARED workspace is authorized
// (checkTenancy). So a caller authorized for their own workspace A could
// `insert` a row (e.g. tier1Purpose, dimensions) whose projectId points at a
// VICTIM's project in workspace V, stamping workspace_id = A. These tests seed
// a real victim project (so the FK EXISTS — proving the rejection is TENANCY,
// not the pre-existing existence check) and assert the cross-tenant FK is
// rejected `cross_tenant`, while legit same-workspace / 057-shared inserts and
// genuinely-missing FKs are unaffected.
describe('handleWriteRequest — cross-tenant FK on insert/update (issue 098 SECURITY)', () => {
  const WS_V = workspaceIdForSub('victim')

  function seedVictimProject(store: InMemoryWriteStore): string {
    const victimProjectId = uuidv7()
    store.seedWorkspace(WS_V)
    store.seed({
      id: victimProjectId,
      workspaceId: WS_V,
      table: 'projects',
      data: { name: 'Victim project' },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    return victimProjectId
  }

  it('rejects a tier1Purpose insert whose projectId points at another workspace\'s (existing) project', async () => {
    const store = new InMemoryWriteStore()
    const victimProjectId = seedVictimProject(store)
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'tier1Purpose',
      op: 'insert',
      payload: { projectId: victimProjectId, body: 'squatted' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })

  it('rejects a dimensions insert whose projectId points at another workspace\'s (existing) project', async () => {
    const store = new InMemoryWriteStore()
    const victimProjectId = seedVictimProject(store)
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'dimensions',
      op: 'insert',
      payload: { projectId: victimProjectId, name: 'Cross-tenant dim' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })

  it('rejects an update that RE-POINTS an FK at another workspace\'s (existing) project', async () => {
    const store = new InMemoryWriteStore()
    const victimProjectId = seedVictimProject(store)
    // A purpose row the caller legitimately owns in WS1...
    const ownProjectId = uuidv7()
    store.seed({ id: ownProjectId, workspaceId: WS1, table: 'projects', data: { name: 'Mine' }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    const purposeId = uuidv7()
    store.seed({ id: purposeId, workspaceId: WS1, table: 'tier1Purpose', data: { projectId: ownProjectId, body: 'ok' }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    const token = await tokenFor('user-1', WS1)
    // ...that the caller now tries to re-point at the victim's project.
    const mutation = envelope({
      table: 'tier1Purpose',
      op: 'update',
      entityId: purposeId,
      payload: { projectId: victimProjectId },
      clientUpdatedAt: new Date().toISOString(),
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })

  it('applies a legit same-workspace insert (FK target in the caller\'s own workspace)', async () => {
    const store = new InMemoryWriteStore()
    const ownProjectId = uuidv7()
    store.seedWorkspace(WS1)
    store.seed({ id: ownProjectId, workspaceId: WS1, table: 'projects', data: { name: 'Mine' }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'tier1Purpose',
      op: 'insert',
      payload: { projectId: ownProjectId, body: 'legit' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
  })

  it('applies a 057-shared-member insert (FK target in the DECLARED, member-authorized workspace)', async () => {
    // A member of workspace V inserting into V, referencing V's own project,
    // declaring V — proves the tenancy check is against the DECLARED (and
    // membership-authorized) workspace, not the caller's personal claims.workspaceId.
    const store = new InMemoryWriteStore()
    const victimProjectId = seedVictimProject(store)
    store.seedMembership(WS_V, 'user-b')
    const token = await tokenFor('user-b', workspaceIdForSub('user-b'))
    const mutation = envelope({
      workspaceId: WS_V,
      table: 'tier1Purpose',
      op: 'insert',
      payload: { projectId: victimProjectId, body: 'member edit' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
  })

  it('still rejects a genuinely NONEXISTENT FK as referential_integrity, NOT cross_tenant', async () => {
    const store = new InMemoryWriteStore()
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'tier1Purpose',
      op: 'insert',
      payload: { projectId: uuidv7(), body: 'points at nothing' },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'referential_integrity' })
    }
  })

  // Issue 098 follow-up (adversarial review) — `projects.adoptedIntoProjectId`
  // (schema.ts:95, issue 037's local→cloud on-ramp) is a real self-referential
  // FK, but FK_SCHEMA.projects was `{}`, so a crafted `projects` insert could
  // plant `adoptedIntoProjectId = <victim project in another workspace>` with
  // NEITHER an existence NOR a tenancy check. Adding the FK_SCHEMA entry makes
  // it both. The legit client never sends this column via /write, so the null/
  // undefined-skip means these checks only ever fire on a crafted payload.
  it('rejects a projects insert whose adoptedIntoProjectId points at another workspace\'s (existing) project', async () => {
    const store = new InMemoryWriteStore()
    const victimProjectId = seedVictimProject(store)
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'projects',
      op: 'insert',
      payload: { name: 'On-ramp squat', adoptedIntoProjectId: victimProjectId },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'cross_tenant' })
    }
  })

  it('rejects a projects insert whose adoptedIntoProjectId points at a NONEXISTENT project as referential_integrity', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS1)
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'projects',
      op: 'insert',
      payload: { name: 'Dangling on-ramp', adoptedIntoProjectId: uuidv7() },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'referential_integrity' })
    }
  })

  it('applies a projects insert whose adoptedIntoProjectId points at a same-workspace project', async () => {
    const store = new InMemoryWriteStore()
    store.seedWorkspace(WS1)
    const ownProjectId = uuidv7()
    store.seed({ id: ownProjectId, workspaceId: WS1, table: 'projects', data: { name: 'Adopt target' }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({
      table: 'projects',
      op: 'insert',
      payload: { name: 'On-ramp legit', adoptedIntoProjectId: ownProjectId },
    })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'applied' })
    }
  })
})

describe('handleWriteRequest — offline replay/idempotency (test-first plan item 4)', () => {
  it('applies a fresh mutation once, and a replay of the same mutation id is a no-op, not a duplicate', async () => {
    const store = new InMemoryWriteStore()
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope()

    const first = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(first.status).toBe(200)
    if (first.status === 200) expect(first.outcomes[0]).toMatchObject({ status: 'applied' })

    const replay = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps(store))
    expect(replay.status).toBe(200)
    if (replay.status === 200) expect(replay.outcomes[0]).toMatchObject({ status: 'noop' })

    const row = await store.getRow('projects', mutation.entityId)
    expect(row).not.toBeNull()
  })

  it('applies queued mutations in order within one batch', async () => {
    const store = new InMemoryWriteStore()
    const token = await tokenFor('user-1', WS1)
    const entityId = uuidv7()
    const insert = envelope({ entityId, op: 'insert', payload: { name: 'v1' }, clientUpdatedAt: '2026-01-01T00:00:00.000Z' })
    const update = envelope({ entityId, op: 'update', payload: { name: 'v2' }, clientUpdatedAt: '2026-01-01T00:00:01.000Z' })

    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [insert, update] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes.map((o) => o.status)).toEqual(['applied', 'applied'])
    }
    const row = await store.getRow('projects', entityId)
    expect(row?.data.name).toBe('v2')
  })
})

describe('handleWriteRequest — LWW conflict resolution', () => {
  it('rejects a stale update whose clientUpdatedAt is older than the row\'s current updatedAt', async () => {
    const store = new InMemoryWriteStore()
    const entityId = uuidv7()
    store.seed({
      id: entityId,
      workspaceId: WS1,
      table: 'projects',
      data: { name: 'Newer (from another client)' },
      updatedAt: '2026-01-02T00:00:00.000Z',
      deletedAt: null,
    })
    const token = await tokenFor('user-1', WS1)
    const stale = envelope({ entityId, op: 'update', payload: { name: 'Stale edit' }, clientUpdatedAt: '2026-01-01T00:00:00.000Z' })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [stale] }, deps(store))
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'stale_conflict' })
    }
    const row = await store.getRow('projects', entityId)
    expect(row?.data.name).toBe('Newer (from another client)') // untouched
  })
})

describe('handleWriteRequest — malformed envelopes', () => {
  it('rejects a mutation with a non-UUIDv7 id before touching the store', async () => {
    const token = await tokenFor('user-1', WS1)
    const mutation = envelope({ id: 'not-a-uuid' })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps())
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'malformed_mutation' })
    }
  })
})
