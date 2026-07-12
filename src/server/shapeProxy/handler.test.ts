import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveShapeRequest, type ShapeProxyDeps } from './handler'
import type { JwtVerifierConfig } from '../writeApi/jwt'

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST123'
const KID = 'test-key-1'
const ELECTRIC_SECRET = 'electric-test-secret'

let jwtConfig: JwtVerifierConfig
let privateKey: CryptoKey

async function sign(claims: Record<string, unknown>, expiresIn = '5m'): Promise<string> {
  return new SignJWT(claims)
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

function deps(workspaceIds: string[]): ShapeProxyDeps {
  return {
    jwt: jwtConfig,
    listWorkspaceIdsForSub: vi.fn().mockResolvedValue(workspaceIds),
    electricBaseUrl: 'http://sync.gede.internal:3000',
    electricSecret: ELECTRIC_SECRET,
  }
}

describe('resolveShapeRequest (issue 058) — the shape-proxy auth + scoping boundary', () => {
  it('rejects a request with no Authorization header (401) — never reaches Electric or the DB', async () => {
    const listWorkspaceIdsForSub = vi.fn()
    const result = await resolveShapeRequest(
      { authorizationHeader: undefined, table: 'projects', query: {} },
      { ...deps([]), listWorkspaceIdsForSub },
    )
    expect(result).toEqual({ ok: false, status: 401, error: 'missing_token' })
    expect(listWorkspaceIdsForSub).not.toHaveBeenCalled()
  })

  it('rejects an invalid/tampered token (403)', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token.slice(0, -4)}abcd`, table: 'projects', query: {} },
      deps(['ws-1']),
    )
    expect(result).toEqual({ ok: false, status: 403, error: 'invalid_token' })
  })

  it('rejects an unknown/unallowed table — the client can never name an arbitrary table', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'applied_mutations', query: {} },
      deps(['ws-1']),
    )
    expect(result).toEqual({ ok: false, status: 400, error: 'unknown_table' })
  })

  it('rejects a missing table param', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: undefined, query: {} },
      deps(['ws-1']),
    )
    expect(result).toEqual({ ok: false, status: 400, error: 'unknown_table' })
  })

  it('a verified caller with one workspace membership gets a URL scoped to exactly that workspace', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'projects', query: {} },
      deps(['ws-1']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.origin).toBe('http://sync.gede.internal:3000')
    expect(url.pathname).toBe('/v1/shape')
    expect(url.searchParams.get('table')).toBe('projects')
    expect(url.searchParams.get('where')).toBe('workspace_id = ANY($1::text[])')
    expect(url.searchParams.get('params[1]')).toBe('{"ws-1"}')
    expect(url.searchParams.get('secret')).toBe(ELECTRIC_SECRET)
  })

  it('a caller with no known memberships gets a fail-closed, matches-nothing scope — never an unscoped shape', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'projects', query: {} },
      deps([]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('where')).toBe('false')
  })

  it('scopes a caller with multiple memberships (057: own + shared workspaces) to every one of them, not just the first', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'contexts', query: {} },
      deps(['ws-own', 'ws-shared']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('params[1]')).toBe('{"ws-own","ws-shared"}')
  })

  // Issue 078 step 2 (migration 0015) — bindings gained its own denormalized
  // workspace_id column, so this now resolves to the same direct literal
  // predicate as every other table, not a subquery against its FK-chain
  // ancestor (contexts). See src/domain/syncScope.ts's own doc comment.
  it('a table that used to need a FK-chain subquery (e.g. bindings) now resolves to the same direct literal scope as every other table (issue 078 step 2)', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'bindings', query: {} },
      deps(['ws-1']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('where')).toBe('workspace_id = ANY($1::text[])')
  })

  it('forwards only Electric protocol pagination params (offset/handle/live/cursor/cache-buster) — never a client-supplied where/params/table override', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      {
        authorizationHeader: `Bearer ${token}`,
        table: 'projects',
        query: {
          offset: '42',
          handle: 'abc',
          live: 'true',
          cursor: 'xyz',
          'cache-buster': 'v1',
          // Attempted client-controlled overrides — must never win.
          where: "1=1 OR workspace_id != ''",
          table: 'workspaces',
          secret: 'attacker-supplied',
        },
      },
      deps(['ws-1']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('offset')).toBe('42')
    expect(url.searchParams.get('handle')).toBe('abc')
    expect(url.searchParams.get('live')).toBe('true')
    expect(url.searchParams.get('cursor')).toBe('xyz')
    expect(url.searchParams.get('cache-buster')).toBe('v1')
    // The server-decided values win — the client's attempted overrides in
    // `query` are never consulted for these keys.
    expect(url.searchParams.get('table')).toBe('projects')
    expect(url.searchParams.get('where')).toBe('workspace_id = ANY($1::text[])')
    expect(url.searchParams.get('secret')).toBe(ELECTRIC_SECRET)
  })
})

// Issue 062 — the invitee-discovery delivery fix: `invitations` streams via
// the shape proxy now, scoped to membership OR the caller's own VERIFIED
// email (src/domain/syncScope.ts). This is the security-critical boundary
// the whole fix hinges on — the email MUST come off the verified JWT, never
// off anything the client sent on the wire.
describe('resolveShapeRequest — invitations email-scoping (issue 062)', () => {
  it('a verified caller with email X and memberships M gets a shape scoped to M ∪ email=X', async () => {
    const token = await sign({ sub: 'user-1', email: 'x@example.com' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'invitations', query: {} },
      deps(['ws-1', 'ws-2']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('table')).toBe('invitations')
    expect(url.searchParams.get('where')).toBe('(workspace_id = ANY($1::text[]) OR lower(email) = lower($2))')
    expect(url.searchParams.get('params[1]')).toBe('{"ws-1","ws-2"}')
    expect(url.searchParams.get('params[2]')).toBe('x@example.com')
  })

  it('a fresh invitee with NO memberships yet still gets a real, matches-by-email shape — never `false`', async () => {
    const token = await sign({ sub: 'user-new', email: 'brand-new@example.com' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'invitations', query: {} },
      deps([]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('where')).toBe('(workspace_id = ANY($1::text[]) OR lower(email) = lower($2))')
    expect(url.searchParams.get('params[1]')).toBe('{}')
    expect(url.searchParams.get('params[2]')).toBe('brand-new@example.com')
  })

  // The cross-email no-leak proof (062's own test-first plan): a JWT for
  // email Y must never produce a shape scoped to email X — the resolved
  // `params[2]` always tracks the SIGNED TOKEN's own email, one caller at a
  // time, never a value borrowed from anywhere else.
  it('email Y\'s verified token never gets email X\'s invites — params[2] tracks the token\'s own email only', async () => {
    const tokenX = await sign({ sub: 'user-x', email: 'x@example.com' })
    const tokenY = await sign({ sub: 'user-y', email: 'y@example.com' })

    const resultX = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${tokenX}`, table: 'invitations', query: {} },
      deps([]),
    )
    const resultY = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${tokenY}`, table: 'invitations', query: {} },
      deps([]),
    )
    expect(resultX.ok).toBe(true)
    expect(resultY.ok).toBe(true)
    if (!resultX.ok || !resultY.ok) return
    const urlX = new URL(resultX.url)
    const urlY = new URL(resultY.url)
    expect(urlX.searchParams.get('params[2]')).toBe('x@example.com')
    expect(urlY.searchParams.get('params[2]')).toBe('y@example.com')
    expect(urlY.searchParams.get('params[2]')).not.toBe('x@example.com')
  })

  it('a client-supplied `email`/`params[2]` query override is never consulted — the email always comes from the verified JWT', async () => {
    const token = await sign({ sub: 'user-1', email: 'real@example.com' })
    const result = await resolveShapeRequest(
      {
        authorizationHeader: `Bearer ${token}`,
        table: 'invitations',
        query: { email: 'attacker@example.com', 'params[2]': 'attacker@example.com' },
      },
      deps(['ws-1']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('params[2]')).toBe('real@example.com')
  })

  it('a token with no email claim at all falls back to membership-only scoping for invitations, fail-closed on empty memberships like every other table', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'invitations', query: {} },
      deps([]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('where')).toBe('false')
  })
})
