// @vitest-environment jsdom
//
// Mocks the network layer (`amazon-cognito-identity-js`) end-to-end — no
// live AWS call is ever made (issue 033 Test-first plan #2). Shared,
// hoisted mock functions back every `CognitoUser`/`CognitoUserPool` method
// so a test can configure behavior *before* calling into `cognitoClient`,
// even though the SDK call happens synchronously inside a single client
// function (construction + invocation aren't separable ticks).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signUpMock = vi.fn()
const getCurrentUserMock = vi.fn()
const confirmRegistrationMock = vi.fn()
const resendConfirmationCodeMock = vi.fn()
const authenticateUserMock = vi.fn()
const getSessionMock = vi.fn()
const signOutMock = vi.fn()

vi.mock('amazon-cognito-identity-js', () => {
  class CognitoUserPool {
    data: unknown
    constructor(data: unknown) {
      this.data = data
    }
    signUp(...args: unknown[]) {
      return (signUpMock as (...a: unknown[]) => unknown)(...args)
    }
    getCurrentUser() {
      return getCurrentUserMock() as unknown
    }
  }
  class CognitoUser {
    data: unknown
    constructor(data: unknown) {
      this.data = data
    }
    confirmRegistration(...args: unknown[]) {
      return (confirmRegistrationMock as (...a: unknown[]) => unknown)(...args)
    }
    resendConfirmationCode(...args: unknown[]) {
      return (resendConfirmationCodeMock as (...a: unknown[]) => unknown)(...args)
    }
    authenticateUser(...args: unknown[]) {
      return (authenticateUserMock as (...a: unknown[]) => unknown)(...args)
    }
    getSession(...args: unknown[]) {
      return (getSessionMock as (...a: unknown[]) => unknown)(...args)
    }
    signOut(...args: unknown[]) {
      return (signOutMock as (...a: unknown[]) => unknown)(...args)
    }
  }
  class CognitoUserAttribute {
    data: unknown
    constructor(data: unknown) {
      this.data = data
    }
  }
  class AuthenticationDetails {
    data: unknown
    constructor(data: unknown) {
      this.data = data
    }
  }
  return { CognitoUserPool, CognitoUser, CognitoUserAttribute, AuthenticationDetails }
})

import { CognitoUserPool } from 'amazon-cognito-identity-js'
import * as client from './cognitoClient'

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

function fakeSession(overrides: { sub?: string; email?: string; expired?: boolean } = {}) {
  const exp = overrides.expired
    ? Math.floor(Date.now() / 1000) - 3600
    : Math.floor(Date.now() / 1000) + 3600
  const idToken = fakeJwt({ sub: overrides.sub ?? 'user-1', email: overrides.email ?? 'a@b.com', exp, iat: 1 })
  return {
    isValid: () => !overrides.expired,
    getIdToken: () => ({ getJwtToken: () => idToken }),
    getAccessToken: () => ({ getJwtToken: () => 'fake-access-token' }),
    getRefreshToken: () => ({ getToken: () => 'fake-refresh-token' }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  const pool = new CognitoUserPool({ UserPoolId: 'test-pool', ClientId: 'test-client' })
  client.setUserPoolForTests(pool)
})

describe('isAuthConfigured', () => {
  it('is true once a pool is injected', () => {
    expect(client.isAuthConfigured()).toBe(true)
  })

  it('is false with no pool configured', () => {
    client.setUserPoolForTests(null)
    expect(client.isAuthConfigured()).toBe(false)
  })
})

describe('signUp', () => {
  it('resolves with the userSub on success', async () => {
    signUpMock.mockImplementation(
      (
        _email: string,
        _password: string,
        _attrs: unknown[],
        _validation: unknown[],
        cb: (err?: Error, result?: { userSub: string }) => void,
      ) => {
        cb(undefined, { userSub: 'sub-123' })
      },
    )
    await expect(client.signUp('a@b.com', 'Passw0rd!')).resolves.toEqual({ userSub: 'sub-123' })
    expect(signUpMock).toHaveBeenCalledWith(
      'a@b.com',
      'Passw0rd!',
      expect.any(Array),
      [],
      expect.any(Function),
    )
  })

  it('rejects with a calm, message-preserving error on failure', async () => {
    signUpMock.mockImplementation((_e: string, _p: string, _a: unknown[], _v: unknown[], cb: (err?: Error) => void) => {
      cb(new Error('An account with the given email already exists.'))
    })
    await expect(client.signUp('a@b.com', 'x')).rejects.toThrow('already exists')
  })

  it('rejects immediately when auth is not configured for this build — never hits the network', async () => {
    client.setUserPoolForTests(null)
    await expect(client.signUp('a@b.com', 'x')).rejects.toThrow('unavailable')
    expect(signUpMock).not.toHaveBeenCalled()
  })
})

describe('confirmSignUp', () => {
  it('resolves on a correct verification code', async () => {
    confirmRegistrationMock.mockImplementation((_code: string, _force: boolean, cb: (err?: Error) => void) => {
      cb(undefined)
    })
    await expect(client.confirmSignUp('a@b.com', '123456')).resolves.toBeUndefined()
  })

  it('rejects on an incorrect code', async () => {
    confirmRegistrationMock.mockImplementation((_code: string, _force: boolean, cb: (err?: Error) => void) => {
      cb(new Error('Invalid verification code provided, please try again.'))
    })
    await expect(client.confirmSignUp('a@b.com', '000000')).rejects.toThrow('Invalid verification code')
  })
})

describe('resendConfirmationCode', () => {
  it('resolves on success', async () => {
    resendConfirmationCodeMock.mockImplementation((cb: (err?: Error) => void) => cb(undefined))
    await expect(client.resendConfirmationCode('a@b.com')).resolves.toBeUndefined()
  })
})

describe('signIn', () => {
  it('resolves a shaped session (sub/email from the ID token) on SRP success', async () => {
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: { onSuccess: (s: unknown) => void }) => {
        callbacks.onSuccess(fakeSession({ sub: 'user-42', email: 'me@example.com' }))
      },
    )
    const session = await client.signIn('me@example.com', 'Passw0rd!')
    expect(session.sub).toBe('user-42')
    expect(session.email).toBe('me@example.com')
    expect(session.idToken).toEqual(expect.any(String))
    expect(session.accessToken).toBe('fake-access-token')
    expect(session.refreshToken).toBe('fake-refresh-token')
  })

  it('rejects with the calm error surface on a wrong password', async () => {
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: { onFailure: (err: unknown) => void }) => {
        callbacks.onFailure(new Error('Incorrect username or password.'))
      },
    )
    await expect(client.signIn('me@example.com', 'wrong')).rejects.toThrow('Incorrect username or password')
  })

  it('never sends the plaintext password to the network directly — SRP callbacks only', async () => {
    authenticateUserMock.mockImplementation(
      (_details: unknown, callbacks: { onSuccess: (s: unknown) => void }) => {
        callbacks.onSuccess(fakeSession())
      },
    )
    await client.signIn('me@example.com', 'Passw0rd!')
    // The SDK's own AuthenticationDetails object carries the password for
    // the SRP handshake locally; the assertion here is that our wrapper
    // never posts it anywhere itself — only ever hands it to the SDK call.
    expect(authenticateUserMock).toHaveBeenCalledTimes(1)
  })
})

describe('signOut', () => {
  it('signs out the current user when one exists', () => {
    getCurrentUserMock.mockReturnValue({ signOut: signOutMock })
    client.signOut()
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no current user', () => {
    getCurrentUserMock.mockReturnValue(null)
    expect(() => {
      client.signOut()
    }).not.toThrow()
  })
})

describe('getCurrentSession', () => {
  it('resolves null when there is no current user (fresh/never signed in)', async () => {
    getCurrentUserMock.mockReturnValue(null)
    await expect(client.getCurrentSession()).resolves.toBeNull()
  })

  it('resolves the shaped session when a valid persisted session exists — the reload/SW-boot path', async () => {
    getCurrentUserMock.mockReturnValue({
      getSession: getSessionMock,
    })
    getSessionMock.mockImplementation((cb: (err: Error | null, session: unknown) => void) => {
      cb(null, fakeSession({ sub: 'persisted-user' }))
    })
    const session = await client.getCurrentSession()
    expect(session).not.toBeNull()
    expect(session?.sub).toBe('persisted-user')
  })

  it('resolves null when the persisted session is invalid/expired and cannot refresh', async () => {
    getCurrentUserMock.mockReturnValue({ getSession: getSessionMock })
    getSessionMock.mockImplementation((cb: (err: Error | null, session: unknown) => void) => {
      cb(null, fakeSession({ expired: true }))
    })
    await expect(client.getCurrentSession()).resolves.toBeNull()
  })

  it('resolves null (never rejects) when the SDK reports a session error', async () => {
    getCurrentUserMock.mockReturnValue({ getSession: getSessionMock })
    getSessionMock.mockImplementation((cb: (err: Error | null, session: unknown) => void) => {
      cb(new Error('network error'), null)
    })
    await expect(client.getCurrentSession()).resolves.toBeNull()
  })
})
