import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { verifyBearerToken, type JwtVerifierConfig } from './jwt'
import { workspaceIdForSub } from '../../domain/workspaceId'

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST123'
const KID = 'test-key-1'

let config: JwtVerifierConfig
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
  const getKey = createLocalJWKSet({ keys: [jwk] })
  config = { issuer: ISSUER, getKey }
})

describe('verifyBearerToken', () => {
  it('rejects a missing Authorization header', async () => {
    const result = await verifyBearerToken(undefined, config)
    expect(result).toEqual({ ok: false, reason: 'missing_token' })
  })

  it('rejects a header that is not a Bearer token', async () => {
    const result = await verifyBearerToken('Basic abc123', config)
    expect(result).toEqual({ ok: false, reason: 'missing_token' })
  })

  it('accepts a validly signed, unexpired token and derives the workspace from the sub', async () => {
    const token = await sign({ sub: 'user-123' })
    const result = await verifyBearerToken(`Bearer ${token}`, config)
    expect(result).toEqual({ ok: true, claims: { sub: 'user-123', workspaceId: workspaceIdForSub('user-123') } })
  })

  it('rejects an expired token', async () => {
    const token = await sign({ sub: 'user-123', 'custom:workspace_id': 'ws-1' }, '-10s')
    const result = await verifyBearerToken(`Bearer ${token}`, config)
    expect(result).toEqual({ ok: false, reason: 'expired_token' })
  })

  it('rejects a token signed with the wrong issuer', async () => {
    const token = await new SignJWT({ sub: 'user-123', 'custom:workspace_id': 'ws-1' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer('https://not-cognito.example.com')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const result = await verifyBearerToken(`Bearer ${token}`, config)
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('rejects a tampered/invalid signature', async () => {
    const token = await sign({ sub: 'user-123', 'custom:workspace_id': 'ws-1' })
    const tampered = token.slice(0, -4) + 'abcd'
    const result = await verifyBearerToken(`Bearer ${tampered}`, config)
    expect(result).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('rejects a token with no sub claim', async () => {
    const token = await sign({})
    const result = await verifyBearerToken(`Bearer ${token}`, config)
    expect(result).toEqual({ ok: false, reason: 'missing_claims' })
  })
})
