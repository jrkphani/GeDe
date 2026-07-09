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

  it('a table without a direct workspace_id column (e.g. bindings) still resolves to a real FK-chain scope, not a bare table read', async () => {
    const token = await sign({ sub: 'user-1' })
    const result = await resolveShapeRequest(
      { authorizationHeader: `Bearer ${token}`, table: 'bindings', query: {} },
      deps(['ws-1']),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const url = new URL(result.url)
    expect(url.searchParams.get('where')).toBe(
      'context_id IN (SELECT id FROM contexts WHERE workspace_id = ANY($1::text[]))',
    )
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
