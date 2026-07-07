// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { decodeJwtPayload, isJwtExpired } from './jwt'

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

describe('decodeJwtPayload', () => {
  it('decodes a well-formed token payload', () => {
    const token = fakeJwt({ sub: 'user-1', email: 'a@example.com', exp: 9999999999, iat: 1 })
    expect(decodeJwtPayload(token)).toEqual({
      sub: 'user-1',
      email: 'a@example.com',
      exp: 9999999999,
      iat: 1,
    })
  })

  it('returns null for a malformed token (wrong segment count)', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull()
    expect(decodeJwtPayload('a.b')).toBeNull()
  })

  it('returns null when the payload is not valid JSON', () => {
    const token = `${base64url('{}')}.${base64url('not-json')}.sig`
    expect(decodeJwtPayload(token)).toBeNull()
  })

  it('returns null when required claims (sub/exp) are missing', () => {
    const token = fakeJwt({ email: 'a@example.com' })
    expect(decodeJwtPayload(token)).toBeNull()
  })
})

describe('isJwtExpired', () => {
  it('is true for a null token', () => {
    expect(isJwtExpired(null)).toBe(true)
  })

  it('is true for a malformed token', () => {
    expect(isJwtExpired('garbage')).toBe(true)
  })

  it('is false for a token that expires well in the future', () => {
    const token = fakeJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 })
    expect(isJwtExpired(token)).toBe(false)
  })

  it('is true for a token that already expired', () => {
    const token = fakeJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 3600, iat: 1 })
    expect(isJwtExpired(token)).toBe(true)
  })

  it('applies the safety skew — a token expiring in 10s counts as expired at the default 30s skew', () => {
    const token = fakeJwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 10, iat: 1 })
    expect(isJwtExpired(token)).toBe(true)
    expect(isJwtExpired(token, 0)).toBe(false)
  })
})
