import { create } from 'zustand'
import * as cognito from '../auth/cognitoClient'
import { isJwtExpired } from '../auth/jwt'

// Session/identity store (issue 033, ADR-0009). Deliberately separate from
// every other store: `hydrate()` never blocks the local-first app's own
// boot (App.tsx calls it alongside, not before, `projectsStore.init()`) —
// "session ≠ sync" (issue 033 design brief). A build with no Cognito
// configuration (`configured: false`) simply never leaves 'unauthenticated'.

export type AuthStatus = 'idle' | 'checking' | 'authenticated' | 'unauthenticated'

export interface AuthUser {
  sub: string
  email: string | null
}

interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  idToken: string | null
  accessToken: string | null
  error: string | null
  configured: boolean
  /** Reads any session the SDK already persisted (reload/SW boot) — never
   *  throws, never blocks the local app. */
  hydrate: () => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  confirmSignUp: (email: string, code: string) => Promise<void>
  resendCode: (email: string) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
  clearError: () => void
  /** The wire-identity seam (src/auth/wireIdentity.ts): a currently-valid ID
   *  token, transparently refreshed if the cached one is stale. Resolves
   *  null when signed out or the refresh itself fails. */
  getIdToken: () => Promise<string | null>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong — try again.'
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'idle',
  user: null,
  idToken: null,
  accessToken: null,
  error: null,
  configured: cognito.isAuthConfigured(),

  async hydrate() {
    if (!cognito.isAuthConfigured()) {
      set({ status: 'unauthenticated', configured: false })
      return
    }
    set({ status: 'checking', configured: true })
    const session = await cognito.getCurrentSession()
    if (session) {
      set({
        status: 'authenticated',
        user: { sub: session.sub, email: session.email },
        idToken: session.idToken,
        accessToken: session.accessToken,
      })
    } else {
      set({ status: 'unauthenticated', user: null, idToken: null, accessToken: null })
    }
  },

  async signUp(email, password) {
    set({ error: null })
    try {
      await cognito.signUp(email, password)
    } catch (err) {
      set({ error: errorMessage(err) })
      throw err
    }
  },

  async confirmSignUp(email, code) {
    set({ error: null })
    try {
      await cognito.confirmSignUp(email, code)
    } catch (err) {
      set({ error: errorMessage(err) })
      throw err
    }
  },

  async resendCode(email) {
    set({ error: null })
    try {
      await cognito.resendConfirmationCode(email)
    } catch (err) {
      set({ error: errorMessage(err) })
      throw err
    }
  },

  async signIn(email, password) {
    set({ error: null })
    try {
      const session = await cognito.signIn(email, password)
      set({
        status: 'authenticated',
        user: { sub: session.sub, email: session.email },
        idToken: session.idToken,
        accessToken: session.accessToken,
      })
    } catch (err) {
      set({ error: errorMessage(err) })
      throw err
    }
  },

  signOut() {
    cognito.signOut()
    set({ status: 'unauthenticated', user: null, idToken: null, accessToken: null, error: null })
  },

  clearError() {
    set({ error: null })
  },

  async getIdToken() {
    const { idToken } = get()
    if (idToken && !isJwtExpired(idToken)) return idToken
    const session = await cognito.getCurrentSession()
    if (!session) {
      set({ status: 'unauthenticated', user: null, idToken: null, accessToken: null })
      return null
    }
    set({ idToken: session.idToken, accessToken: session.accessToken })
    return session.idToken
  },
}))

/** Test-only reset — mirrors the reset helpers the other stores expose. */
export function resetAuthStoreForTests(): void {
  useAuthStore.setState({
    status: 'idle',
    user: null,
    idToken: null,
    accessToken: null,
    error: null,
    configured: cognito.isAuthConfigured(),
  })
}
