// Tier-2 write-path auth gate (issue 043, ADR-0009/ADR-0010). Validates a
// Cognito-issued JWT against its JWKS — the same validation the sync
// connection (issue 032) performs, so the two paths can share this module
// once 032 lands.
//
// Issue 033 (Cognito User Pool + `Gede-<Env>-Auth` stack) has not shipped in
// this worktree yet, so there is no live User Pool/JWKS endpoint to point at.
// This module is nonetheless REAL, working JWKS/RS256 verification (via
// `jose`) — it is fully exercised in tests against a locally-generated RSA
// keypair (no network), and in production needs only the deployed User
// Pool's issuer URL wired into `JwtVerifierConfig`. Nothing here is a stub;
// it is a documented integration seam (HANDOFF: "no live AWS/Electric/
// Cognito reachable in tests").
import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose'

/**
 * The claims the write-path API needs out of a verified Cognito access
 * token. `workspaceId` is read from a custom Cognito attribute
 * (`custom:workspace_id`) — issue 034 (workspace/RLS tenancy) owns how that
 * attribute is populated at sign-up/invite time; this module only reads it.
 */
export interface CognitoClaims {
  readonly sub: string
  readonly workspaceId: string
}

export interface JwtVerifierConfig {
  /** Cognito User Pool issuer, e.g. `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`. */
  readonly issuer: string
  /** JWKS resolver — `createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'))` in production, `createLocalJWKSet(...)` in tests. */
  readonly getKey: JWTVerifyGetKey
}

export type AuthFailureReason = 'missing_token' | 'invalid_token' | 'expired_token' | 'missing_claims'

export type AuthResult =
  | { readonly ok: true; readonly claims: CognitoClaims }
  | { readonly ok: false; readonly reason: AuthFailureReason }

const WORKSPACE_CLAIM = 'custom:workspace_id'

/**
 * Verifies the `Authorization: Bearer <jwt>` header. Test-first plan item 1:
 * "a mutation with no/invalid/expired Cognito JWT is rejected (401/403); a
 * valid one is accepted — asserted at the API boundary."
 */
export async function verifyBearerToken(
  authorizationHeader: string | undefined,
  config: JwtVerifierConfig,
): Promise<AuthResult> {
  if (!authorizationHeader) return { ok: false, reason: 'missing_token' }
  const [scheme, token] = authorizationHeader.split(' ')
  if (scheme !== 'Bearer' || !token) return { ok: false, reason: 'missing_token' }

  try {
    const { payload } = await jwtVerify(token, config.getKey, { issuer: config.issuer })
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined
    const workspaceClaim = payload[WORKSPACE_CLAIM]
    const workspaceId = typeof workspaceClaim === 'string' ? workspaceClaim : undefined
    if (!sub || !workspaceId) return { ok: false, reason: 'missing_claims' }
    return { ok: true, claims: { sub, workspaceId } }
  } catch (err) {
    if (err instanceof errors.JWTExpired) return { ok: false, reason: 'expired_token' }
    return { ok: false, reason: 'invalid_token' }
  }
}
