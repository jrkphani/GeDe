// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted above the module's top-level statements, so
// the mock fns they close over must be created via `vi.hoisted` — a plain
// `const` here would still be in its temporal dead zone when the factory runs.
const {
  isAuthConfiguredMock,
  getCurrentSessionMock,
  signUpMock,
  confirmSignUpMock,
  resendConfirmationCodeMock,
  signInMock,
  signOutMock,
} = vi.hoisted(() => ({
  isAuthConfiguredMock: vi.fn(() => true),
  getCurrentSessionMock: vi.fn(),
  signUpMock: vi.fn(),
  confirmSignUpMock: vi.fn(),
  resendConfirmationCodeMock: vi.fn(),
  signInMock: vi.fn(),
  signOutMock: vi.fn(),
}))

vi.mock('../auth/cognitoClient', () => ({
  isAuthConfigured: () => isAuthConfiguredMock(),
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args) as unknown,
  signUp: (...args: unknown[]) => signUpMock(...args) as unknown,
  confirmSignUp: (...args: unknown[]) => confirmSignUpMock(...args) as unknown,
  resendConfirmationCode: (...args: unknown[]) => resendConfirmationCodeMock(...args) as unknown,
  signIn: (...args: unknown[]) => signInMock(...args) as unknown,
  signOut: (...args: unknown[]) => signOutMock(...args) as unknown,
}))

import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetSyncStore, useSyncStore } from './sync'
import { workspaceIdForSub } from '../domain/workspaceId'

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `getIdToken()` runs the real `isJwtExpired` against the cached token, so
 *  the fake session needs a real JWT shape (future `exp`), not a bare string. */
function fakeIdToken(sub: string, email: string | null, expired = false): string {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({ sub, email, exp, iat: 1 }))
  return `${header}.${body}.fake-signature`
}

function fakeSession(overrides: { sub?: string; email?: string | null } = {}) {
  const sub = overrides.sub ?? 'user-1'
  const email = overrides.email ?? 'a@b.com'
  return {
    idToken: fakeIdToken(sub, email),
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    sub,
    email,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  isAuthConfiguredMock.mockReturnValue(true)
  resetAuthStoreForTests()
  resetSyncStore()
})

describe('hydrate', () => {
  it('goes straight to unauthenticated (never "checking") when this build has no Cognito config', async () => {
    isAuthConfiguredMock.mockReturnValue(false)
    await useAuthStore.getState().hydrate()
    const state = useAuthStore.getState()
    expect(state.status).toBe('unauthenticated')
    expect(state.configured).toBe(false)
    expect(getCurrentSessionMock).not.toHaveBeenCalled()
  })

  it('restores an authenticated session already persisted by the SDK (reload/SW-boot path)', async () => {
    const session = fakeSession({ sub: 'persisted' })
    getCurrentSessionMock.mockResolvedValue(session)
    await useAuthStore.getState().hydrate()
    const state = useAuthStore.getState()
    expect(state.status).toBe('authenticated')
    expect(state.user).toEqual({ sub: 'persisted', email: 'a@b.com' })
    expect(state.idToken).toBe(session.idToken)
  })

  it('lands on unauthenticated when there is no persisted session', async () => {
    getCurrentSessionMock.mockResolvedValue(null)
    await useAuthStore.getState().hydrate()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
  })
})

describe('signUp / confirmSignUp / resendCode', () => {
  it('signUp clears any prior error and delegates to the client', async () => {
    useAuthStore.setState({ error: 'stale error' })
    signUpMock.mockResolvedValue({ userSub: 'sub-1' })
    await useAuthStore.getState().signUp('a@b.com', 'Passw0rd!')
    expect(useAuthStore.getState().error).toBeNull()
    expect(signUpMock).toHaveBeenCalledWith('a@b.com', 'Passw0rd!')
  })

  it('signUp surfaces a calm error message and rethrows on failure', async () => {
    signUpMock.mockRejectedValue(new Error('email already registered'))
    await expect(useAuthStore.getState().signUp('a@b.com', 'x')).rejects.toThrow('already registered')
    expect(useAuthStore.getState().error).toBe('email already registered')
  })

  it('confirmSignUp delegates and surfaces errors the same way', async () => {
    confirmSignUpMock.mockRejectedValue(new Error('bad code'))
    await expect(useAuthStore.getState().confirmSignUp('a@b.com', '000000')).rejects.toThrow('bad code')
    expect(useAuthStore.getState().error).toBe('bad code')
  })

  it('resendCode delegates to the client', async () => {
    resendConfirmationCodeMock.mockResolvedValue(undefined)
    await useAuthStore.getState().resendCode('a@b.com')
    expect(resendConfirmationCodeMock).toHaveBeenCalledWith('a@b.com')
  })
})

describe('signIn', () => {
  it('sets an authenticated session on success', async () => {
    signInMock.mockResolvedValue(fakeSession({ sub: 'user-9', email: 'me@example.com' }))
    await useAuthStore.getState().signIn('me@example.com', 'Passw0rd!')
    const state = useAuthStore.getState()
    expect(state.status).toBe('authenticated')
    expect(state.user).toEqual({ sub: 'user-9', email: 'me@example.com' })
  })

  it('surfaces the calm error and stays unauthenticated on failure', async () => {
    signInMock.mockRejectedValue(new Error('Incorrect username or password.'))
    await expect(useAuthStore.getState().signIn('me@example.com', 'wrong')).rejects.toThrow(
      'Incorrect username or password',
    )
    const state = useAuthStore.getState()
    expect(state.status).not.toBe('authenticated')
    expect(state.error).toBe('Incorrect username or password.')
  })
})

describe('signOut', () => {
  it('clears the session and calls the client synchronously', async () => {
    signInMock.mockResolvedValue(fakeSession())
    await useAuthStore.getState().signIn('a@b.com', 'x')
    useAuthStore.getState().signOut()
    const state = useAuthStore.getState()
    expect(state.status).toBe('unauthenticated')
    expect(state.user).toBeNull()
    expect(state.idToken).toBeNull()
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('clears the sync store workspace scope back to null', async () => {
    signInMock.mockResolvedValue(fakeSession({ sub: 'sub-to-clear' }))
    await useAuthStore.getState().signIn('a@b.com', 'x')
    expect(useSyncStore.getState().workspaceId).not.toBeNull()
    useAuthStore.getState().signOut()
    expect(useSyncStore.getState().workspaceId).toBeNull()
  })
})

// Issue 050, test-first plan item 3 — "given a token with a sub, sign-in
// calls setWorkspaceId(workspaceIdForSub(sub)); signed-out/no sub -> no
// crash, stays local." The workspace id is a pure function of the sub
// (src/domain/workspaceId.ts) — no lookup, no network call — so this is
// exercised directly against the real useSyncStore rather than a mock.
describe('workspace scoping on sign-in (issue 050)', () => {
  it('signIn computes workspaceIdForSub(sub) and hands it to the sync store', async () => {
    const sub = 'sign-in-sub'
    signInMock.mockResolvedValue(fakeSession({ sub }))
    await useAuthStore.getState().signIn('a@b.com', 'x')
    expect(useSyncStore.getState().workspaceId).toBe(workspaceIdForSub(sub))
  })

  it('hydrate (restored session on reload) computes the same workspace id', async () => {
    const sub = 'hydrated-sub'
    getCurrentSessionMock.mockResolvedValue(fakeSession({ sub }))
    await useAuthStore.getState().hydrate()
    expect(useSyncStore.getState().workspaceId).toBe(workspaceIdForSub(sub))
  })

  it('a failed sign-in never sets a workspace id', async () => {
    signInMock.mockRejectedValue(new Error('nope'))
    await expect(useAuthStore.getState().signIn('a@b.com', 'wrong')).rejects.toThrow()
    expect(useSyncStore.getState().workspaceId).toBeNull()
  })

  it('signed-out hydrate (no persisted session) never sets a workspace id — stays local, no crash', async () => {
    getCurrentSessionMock.mockResolvedValue(null)
    await expect(useAuthStore.getState().hydrate()).resolves.not.toThrow()
    expect(useSyncStore.getState().workspaceId).toBeNull()
  })

  it('a build with no Cognito configuration never sets a workspace id', async () => {
    isAuthConfiguredMock.mockReturnValue(false)
    await useAuthStore.getState().hydrate()
    expect(useSyncStore.getState().workspaceId).toBeNull()
  })

  it('the SAME sub always produces the SAME workspace id across independent sign-ins', async () => {
    const sub = 'stable-across-signins'
    signInMock.mockResolvedValue(fakeSession({ sub }))
    await useAuthStore.getState().signIn('a@b.com', 'x')
    const first = useSyncStore.getState().workspaceId
    useAuthStore.getState().signOut()
    signInMock.mockResolvedValue(fakeSession({ sub }))
    await useAuthStore.getState().signIn('a@b.com', 'x')
    expect(useSyncStore.getState().workspaceId).toBe(first)
  })
})

describe('getIdToken', () => {
  it('returns the cached token without a network call when it is not near expiry', async () => {
    const session = fakeSession()
    signInMock.mockResolvedValue(session)
    await useAuthStore.getState().signIn('a@b.com', 'x')
    getCurrentSessionMock.mockClear()
    const token = await useAuthStore.getState().getIdToken()
    expect(token).toBe(session.idToken)
    expect(getCurrentSessionMock).not.toHaveBeenCalled()
  })

  it('refreshes via getCurrentSession when there is no cached token yet (fresh store)', async () => {
    const session = fakeSession({ sub: 'refreshed' })
    getCurrentSessionMock.mockResolvedValue(session)
    const token = await useAuthStore.getState().getIdToken()
    expect(token).toBe(session.idToken)
    expect(getCurrentSessionMock).toHaveBeenCalledTimes(1)
  })

  it('resolves null and flips to unauthenticated when refresh finds no session', async () => {
    getCurrentSessionMock.mockResolvedValue(null)
    const token = await useAuthStore.getState().getIdToken()
    expect(token).toBeNull()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
  })
})
