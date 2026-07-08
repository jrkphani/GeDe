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
import { workspaceIdForSub } from '../../domain/workspaceId'

/**
 * The claims the write-path API needs out of a verified Cognito token.
 * `workspaceId` is DERIVED from the verified `sub` (issue 050,
 * `workspaceIdForSub`) — the personal-workspace id is a pure function of the
 * subject, not a Cognito custom attribute (that would force a User Pool
 * replacement). The client scopes its writes to the same derived id.
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
    if (!sub) return { ok: false, reason: 'missing_claims' }
    return { ok: true, claims: { sub, workspaceId: workspaceIdForSub(sub) } }
  } catch (err) {
    if (err instanceof errors.JWTExpired) return { ok: false, reason: 'expired_token' }
    return { ok: false, reason: 'invalid_token' }
  }
}
