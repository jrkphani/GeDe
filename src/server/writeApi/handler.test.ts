// Server integration tests (issue 043 acceptance criterion: "server
// integration tests green") — exercise auth -> tenancy -> invariants ->
// idempotency -> LWW -> persist end to end, against the InMemoryWriteStore
// (no live Postgres/Cognito reachable in tests, HANDOFF) and a locally
// signed JWT (no network JWKS fetch).
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { handleWriteRequest, type WriteApiDeps } from './handler'
import { InMemoryWriteStore } from './store'
import type { MutationEnvelope } from '../../domain/mutationProtocol'
import type { JwtVerifierConfig } from './jwt'

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST'
const KID = 'k1'
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
    workspaceId: 'ws-1',
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
    const token = await tokenFor('user-1', 'ws-1', '-10s')
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [envelope()] }, deps())
    expect(result.status).toBe(401)
    if (result.status === 401) expect(result.rejection.reason).toBe('expired_token')
  })

  it('accepts a batch with a valid token', async () => {
    const token = await tokenFor('user-1', 'ws-1')
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [envelope()] }, deps())
    expect(result.status).toBe(200)
  })
})

describe('handleWriteRequest — tenancy (test-first plan item 2)', () => {
  it('rejects an insert into another workspace even with a valid JWT', async () => {
    const token = await tokenFor('user-1', 'ws-1')
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
    const token = await tokenFor('user-1', 'ws-1')
    const mutation = envelope({ op: 'update', entityId: rowId, workspaceId: 'ws-1', payload: { name: 'Hijacked' } })
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
      store.seed({ id, workspaceId: 'ws-1', table: 'dimensions', data: { projectId, contextId: null }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    }
    const token = await tokenFor('user-1', 'ws-1')
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
      store.seed({ id, workspaceId: 'ws-1', table: 'dimensions', data: { projectId, contextId: null }, updatedAt: new Date(0).toISOString(), deletedAt: null })
    }
    const token = await tokenFor('user-1', 'ws-1')
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
      workspaceId: 'ws-1',
      table: 'bindings',
      data: { contextId, dimensionId, parameterId: uuidv7() },
      updatedAt: new Date(0).toISOString(),
      deletedAt: null,
    })
    const token = await tokenFor('user-1', 'ws-1')
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
    const token = await tokenFor('user-1', 'ws-1')
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

describe('handleWriteRequest — offline replay/idempotency (test-first plan item 4)', () => {
  it('applies a fresh mutation once, and a replay of the same mutation id is a no-op, not a duplicate', async () => {
    const store = new InMemoryWriteStore()
    const token = await tokenFor('user-1', 'ws-1')
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
    const token = await tokenFor('user-1', 'ws-1')
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
      workspaceId: 'ws-1',
      table: 'projects',
      data: { name: 'Newer (from another client)' },
      updatedAt: '2026-01-02T00:00:00.000Z',
      deletedAt: null,
    })
    const token = await tokenFor('user-1', 'ws-1')
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
    const token = await tokenFor('user-1', 'ws-1')
    const mutation = envelope({ id: 'not-a-uuid' })
    const result = await handleWriteRequest({ authorizationHeader: `Bearer ${token}`, mutations: [mutation] }, deps())
    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcomes[0]).toMatchObject({ status: 'rejected', reason: 'malformed_mutation' })
    }
  })
})
