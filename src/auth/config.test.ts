// Issue 044 test-first plan #1 — getCognitoConfig() driven directly by the
// build-time VITE_COGNITO_* env vars (import.meta.env), with no Cognito SDK
// or network involved. src/store/auth.ts's `configured` flag is derived from
// this indirectly via src/auth/cognitoClient.ts's isAuthConfigured(); this
// file pins the base case those all build on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCognitoConfig } from './config'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getCognitoConfig (issue 044)', () => {
  it('returns null when the pool/client ids are unset — the account-free local/test default', () => {
    expect(getCognitoConfig()).toBeNull()
  })

  it('returns null when only one of the two required ids is set', () => {
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_d0qKGDQmC')
    expect(getCognitoConfig()).toBeNull()
  })

  it('returns a non-null config once both the pool id and client id are set', () => {
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_d0qKGDQmC')
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', '5qbs9mgmms9mcf0u7r26npi3g2')
    expect(getCognitoConfig()).toEqual({
      region: 'us-east-1',
      userPoolId: 'us-east-1_d0qKGDQmC',
      clientId: '5qbs9mgmms9mcf0u7r26npi3g2',
    })
  })

  it('defaults the region to us-east-1 when unset', () => {
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_d0qKGDQmC')
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'client-1')
    expect(getCognitoConfig()?.region).toBe('us-east-1')
  })

  it('honors an explicit region override', () => {
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_d0qKGDQmC')
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'client-1')
    vi.stubEnv('VITE_COGNITO_REGION', 'eu-west-1')
    expect(getCognitoConfig()?.region).toBe('eu-west-1')
  })
})
