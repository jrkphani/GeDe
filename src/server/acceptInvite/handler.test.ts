// Server integration tests for the dedicated `/accept` endpoint (issue 080,
// SECURITY-CRITICAL). This is the ONLY place a caller can seat themselves
// into a workspace they don't own — RLS is currently a no-op in prod (every
// Lambda connects as the `gede_admin` table owner), so the assertions below
// ARE the enforcement boundary, not defense-in-depth. Treat any change here
// with the same scrutiny as src/server/writeApi/tenancy.test.ts.
//
// Mirrors src/server/writeApi/handler.test.ts's JWT setup exactly (real
// signed tokens via jose/generateKeyPair + createLocalJWKSet — no live
// AWS/Cognito reachable in tests, HANDOFF) against InMemoryAcceptStore (no
// live Postgres reachable in tests either).
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { acceptInvite, type AcceptInviteDeps } from './handler'
import { InMemoryAcceptStore, type PendingInvitation } from './store'
import type { JwtVerifierConfig } from '../writeApi/jwt'
import { workspaceIdForSub } from '../../domain/workspaceId'

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST'
const KID = 'k1'
const WS_A = workspaceIdForSub('inviter-sub')
let privateKey: CryptoKey
let jwtConfig: JwtVerifierConfig

interface TokenOptions {
  readonly email?: string
  readonly expiresIn?: string
}

async function tokenFor(sub: string, options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { sub }
  if (options.email !== undefined) claims.email = options.email
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
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

function invitation(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    id: uuidv7(),
    workspaceId: WS_A,
    email: 'invitee@example.com',
    role: 'editor',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    acceptedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

function deps(store = new InMemoryAcceptStore()): AcceptInviteDeps {
  return { jwt: jwtConfig, store }
}

describe('acceptInvite — valid accept (test-first plan item 1)', () => {
  it('applies: seats the caller (claims.sub, not any request field) with the invite\'s role AND marks the invitation accepted, atomically', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ role: 'editor' })
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'applied', workspaceId: WS_A, role: 'editor' })
    }

    // The membership row is really there, with the invite's role.
    const member = await store.findExistingMembership(WS_A, 'invitee-sub')
    expect(member).toMatchObject({ workspaceId: WS_A, userSub: 'invitee-sub', role: 'editor' })

    // The invitation is no longer pending — accepted_at was set atomically
    // alongside the membership insert (re-querying findPendingInvitation
    // with the exact same authorized (workspaceId, email) now returns null).
    const stillPending = await store.findPendingInvitation(WS_A, 'invitee@example.com')
    expect(stillPending).toBeNull()
  })
})

describe('acceptInvite — no matching invite (test-first plan item 2)', () => {
  it('rejects when no invitation exists at all for this (workspaceId, email)', async () => {
    const store = new InMemoryAcceptStore() // nothing seeded
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: uuidv7(), workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'invitation_not_found' })
    }
  })

  it('rejects when the invitationId in the request does not match the pending invite found for (workspaceId, email)', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation()
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: uuidv7(), workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'invitation_not_found' })
    }
    expect(await store.findExistingMembership(WS_A, 'invitee-sub')).toBeNull()
  })
})

describe('acceptInvite — email mismatch, incl. case-insensitivity (test-first plan item 3)', () => {
  it('rejects when the verified claims.email does not match the invitation\'s email', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ email: 'invitee@example.com' })
    store.seedInvitation(inv)
    const token = await tokenFor('attacker-sub', { email: 'attacker@example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'invitation_not_found' })
    }
    expect(await store.findExistingMembership(WS_A, 'attacker-sub')).toBeNull()
  })

  it('matches case-insensitively: an invite stored lowercase accepts a claims.email in a different case (Foo@Bar matches foo@bar)', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ email: 'invitee@example.com' })
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', { email: 'Invitee@Example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'applied' })
    }
  })
})

describe('acceptInvite — expired invitation (test-first plan item 4)', () => {
  it('rejects an invitation whose expiresAt is in the past', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'invitation_not_found' })
    }
  })
})

describe('acceptInvite — already accepted (test-first plan item 5, idempotent retry)', () => {
  it('a retried accept by the SAME caller is a success-shaped no-op, not a rejection or a duplicate row', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ role: 'viewer' })
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com' })
    const request = { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A }

    const first = await acceptInvite(request, deps(store))
    expect(first.status).toBe(200)
    if (first.status === 200) expect(first.outcome).toMatchObject({ status: 'applied', role: 'viewer' })

    const memberAfterFirst = await store.findExistingMembership(WS_A, 'invitee-sub')

    const retry = await acceptInvite(request, deps(store))
    expect(retry.status).toBe(200)
    if (retry.status === 200) {
      expect(retry.outcome).toMatchObject({ status: 'applied', workspaceId: WS_A, role: 'viewer' })
    }

    // No duplicate row — same membership id, still exactly one row for (WS_A, invitee-sub).
    const memberAfterRetry = await store.findExistingMembership(WS_A, 'invitee-sub')
    expect(memberAfterRetry?.id).toBe(memberAfterFirst?.id)
  })

  it('an already-accepted invitation does NOT let a DIFFERENT sub (even with the same verified email) get seated a second time under a fresh identity', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ role: 'viewer' })
    store.seedInvitation(inv)
    const firstToken = await tokenFor('invitee-sub', { email: 'invitee@example.com' })
    await acceptInvite({ authorizationHeader: `Bearer ${firstToken}`, invitationId: inv.id, workspaceId: WS_A }, deps(store))

    const secondToken = await tokenFor('another-sub', { email: 'invitee@example.com' })
    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${secondToken}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'invitation_not_found' })
    }
    expect(await store.findExistingMembership(WS_A, 'another-sub')).toBeNull()
  })
})

describe('acceptInvite — soft-deleted / revoked invitation (test-first plan item 6)', () => {
  it('rejects an invitation that has been revoked (deletedAt set)', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation({ deletedAt: new Date().toISOString() })
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com' })

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'invitation_not_found' })
    }
  })
})

describe('acceptInvite — claims.email absent (test-first plan item 7, fail closed)', () => {
  it('rejects with a DISTINCT reason when the verified token carries no email claim at all — never falls back to trusting client input', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation()
    store.seedInvitation(inv)
    const token = await tokenFor('invitee-sub', {}) // no email claim

    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A },
      deps(store),
    )

    expect(result.status).toBe(200)
    if (result.status === 200) {
      expect(result.outcome).toMatchObject({ status: 'rejected', reason: 'missing_email' })
      // Distinct from every other rejection reason exercised above.
      expect(result.outcome.status === 'rejected' && result.outcome.reason).not.toBe('invitation_not_found')
    }
    expect(await store.findExistingMembership(WS_A, 'invitee-sub')).toBeNull()
  })
})

describe('acceptInvite — auth gate (test-first plan item 8)', () => {
  it('rejects with 401 when the Authorization header is missing', async () => {
    const result = await acceptInvite(
      { authorizationHeader: undefined, invitationId: uuidv7(), workspaceId: WS_A },
      deps(),
    )
    expect(result.status).toBe(401)
  })

  it('rejects with 401 when the token is malformed/invalid', async () => {
    const result = await acceptInvite(
      { authorizationHeader: 'Bearer not-a-real-jwt', invitationId: uuidv7(), workspaceId: WS_A },
      deps(),
    )
    expect(result.status).toBe(401)
  })

  it('rejects with 401 when the token is expired', async () => {
    const token = await tokenFor('invitee-sub', { email: 'invitee@example.com', expiresIn: '-10s' })
    const result = await acceptInvite(
      { authorizationHeader: `Bearer ${token}`, invitationId: uuidv7(), workspaceId: WS_A },
      deps(),
    )
    expect(result.status).toBe(401)
    if (result.status === 401) expect(result.rejection.reason).toBe('expired_token')
  })
})

describe('acceptInvite — userSub is derived ONLY from verified claims (issue 080 core contract)', () => {
  it('the request shape carries no field that could let a caller seat a different user — the seated userSub always equals claims.sub', async () => {
    const store = new InMemoryAcceptStore()
    const inv = invitation()
    store.seedInvitation(inv)
    const token = await tokenFor('real-caller-sub', { email: 'invitee@example.com' })

    // AcceptInviteRequest below is exhaustively typed as
    // { authorizationHeader, invitationId, workspaceId } — there is no
    // userSub/actorSub field to even attempt spoofing through; this test
    // documents that guarantee by construction and confirms the seated row
    // uses the token's own sub.
    await acceptInvite({ authorizationHeader: `Bearer ${token}`, invitationId: inv.id, workspaceId: WS_A }, deps(store))

    expect(await store.findExistingMembership(WS_A, 'real-caller-sub')).not.toBeNull()
  })
})
