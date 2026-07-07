import { useAuthStore } from '../store/auth'

/*
 * "Identity on the wire" (issue 033 scope item 3): the client-side half of
 * the JWT seam. An authenticated client attaches this header to its
 * sync/API connection; issue 032's Electric/API client (and, behind it,
 * issue 034's RLS) validates the JWT against Cognito's JWKS — the endpoint
 * published as `UserPoolJwksUri` by deploy/cdk/lib/auth-stack.ts — and reads
 * the `sub` claim as the row-scoping identity (ADR-0009). Full server-side
 * verification is out of scope for 033; this module only builds the header
 * a caller merges into its own request/connection init.
 *
 * Deliberately resolves to `{}` rather than throwing when signed out — an
 * unauthenticated connection is just unauthenticated (local-mode / public
 * reads), never a broken one (issue 033 design brief: auth is an on-ramp).
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await useAuthStore.getState().getIdToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
