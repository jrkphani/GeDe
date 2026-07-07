import {
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  AuthenticationDetails,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js'
import { getCognitoConfig } from './config'
import { decodeJwtPayload } from './jwt'

/*
 * Thin Promise wrapper over `amazon-cognito-identity-js` (issue 033,
 * ADR-0009) — the SDK the custom login screen drives directly (no Cognito
 * Hosted UI, no redirect). `authenticateUser` uses SRP (Secure Remote
 * Password): the plaintext password never crosses the wire, matching the
 * App Client's `ALLOW_USER_SRP_AUTH`-only auth flow (auth-stack.ts).
 *
 * The pool is created lazily from build-time config (src/auth/config.ts)
 * and cached; `setUserPoolForTests` lets tests inject a fake pool instead of
 * hitting the network (mirrors src/store/database.ts's `setDatabase` seam).
 */

let poolOverride: CognitoUserPool | null | undefined
let cachedPool: CognitoUserPool | null = null

export function setUserPoolForTests(pool: CognitoUserPool | null): void {
  poolOverride = pool
}

export function resetUserPoolForTests(): void {
  poolOverride = undefined
  cachedPool = null
}

function getPool(): CognitoUserPool | null {
  if (poolOverride !== undefined) return poolOverride
  if (cachedPool) return cachedPool
  const config = getCognitoConfig()
  if (!config) return null
  cachedPool = new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.clientId })
  return cachedPool
}

/** True once a User Pool/Client is configured for this build — components
 *  use this to decide whether to offer sign-in at all (unconfigured builds
 *  degrade to local-only, never a broken sign-in screen). */
export function isAuthConfigured(): boolean {
  return getPool() !== null
}

export interface CognitoSession {
  idToken: string
  accessToken: string
  refreshToken: string
  sub: string
  email: string | null
}

function unavailable(): Error {
  return new Error('Sign-in is unavailable — this build has no Cognito configuration.')
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return new Error(message)
  }
  return new Error('Something went wrong — try again.')
}

function sessionFromCognito(session: CognitoUserSession): CognitoSession {
  const idToken = session.getIdToken().getJwtToken()
  const accessToken = session.getAccessToken().getJwtToken()
  const refreshToken = session.getRefreshToken().getToken()
  const payload = decodeJwtPayload(idToken)
  return {
    idToken,
    accessToken,
    refreshToken,
    sub: payload?.sub ?? '',
    email: typeof payload?.email === 'string' ? payload.email : null,
  }
}

export function signUp(email: string, password: string): Promise<{ userSub: string }> {
  return new Promise((resolve, reject) => {
    const pool = getPool()
    if (!pool) {
      reject(unavailable())
      return
    }
    const attributes = [new CognitoUserAttribute({ Name: 'email', Value: email })]
    pool.signUp(email, password, attributes, [], (err, result) => {
      if (err || !result) {
        reject(toError(err))
        return
      }
      resolve({ userSub: result.userSub })
    })
  })
}

export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pool = getPool()
    if (!pool) {
      reject(unavailable())
      return
    }
    const user = new CognitoUser({ Username: email, Pool: pool })
    user.confirmRegistration(code, true, (err) => {
      if (err) {
        reject(toError(err))
        return
      }
      resolve()
    })
  })
}

export function resendConfirmationCode(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pool = getPool()
    if (!pool) {
      reject(unavailable())
      return
    }
    const user = new CognitoUser({ Username: email, Pool: pool })
    user.resendConfirmationCode((err) => {
      if (err) {
        reject(toError(err))
        return
      }
      resolve()
    })
  })
}

export function signIn(email: string, password: string): Promise<CognitoSession> {
  return new Promise((resolve, reject) => {
    const pool = getPool()
    if (!pool) {
      reject(unavailable())
      return
    }
    const user = new CognitoUser({ Username: email, Pool: pool })
    const details = new AuthenticationDetails({ Username: email, Password: password })
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(sessionFromCognito(session)),
      onFailure: (err: unknown) => reject(toError(err)),
      // Admin-created users / forced resets aren't part of this slice's
      // self-service sign-up flow — surface as a calm error rather than
      // hang the login screen on an unhandled challenge.
      newPasswordRequired: () =>
        reject(new Error('This account needs a password reset — contact an admin.')),
    })
  })
}

/** Synchronous, mirroring the SDK — clears the persisted Cognito session. */
export function signOut(): void {
  const pool = getPool()
  const user = pool?.getCurrentUser() ?? null
  user?.signOut()
}

/**
 * Reads the session the SDK already persisted (localStorage, by default —
 * `amazon-cognito-identity-js`'s own storage helper) without any credentials
 * — this is what makes sign-in durable across reload/SW boot (issue 033
 * Test-first plan #2). The SDK's `getSession` transparently refreshes an
 * expired access/ID token using the stored refresh token; resolves `null`
 * when there is no user, no session, or the refresh itself fails (refresh
 * token expired/revoked) — never throws, so callers can treat it as "not
 * signed in" uniformly.
 */
export function getCurrentSession(): Promise<CognitoSession | null> {
  return new Promise((resolve) => {
    const pool = getPool()
    const user = pool?.getCurrentUser() ?? null
    if (!user) {
      resolve(null)
      return
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) {
        resolve(null)
        return
      }
      resolve(sessionFromCognito(session))
    })
  })
}
