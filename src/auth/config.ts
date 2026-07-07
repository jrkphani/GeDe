export interface CognitoConfig {
  region: string
  userPoolId: string
  clientId: string
}

/**
 * Reads the Cognito identifiers injected at build time (Vite
 * `VITE_COGNITO_*` env vars — populated from the Auth stack's
 * `UserPoolId`/`UserPoolClientId` outputs, deploy/cdk/lib/auth-stack.ts).
 * Returns null in any environment that hasn't configured them (local dev
 * without a `.env`, most tests) — callers must treat a missing config as
 * "auth unavailable" rather than throw, so the account-free local app never
 * depends on it booting (issue 033 design brief: "auth is an on-ramp, not a
 * gate").
 */
export function getCognitoConfig(): CognitoConfig | null {
  const env = import.meta.env
  const userPoolId = env.VITE_COGNITO_USER_POOL_ID
  const clientId = env.VITE_COGNITO_CLIENT_ID
  const region = env.VITE_COGNITO_REGION ?? 'us-east-1'
  if (!userPoolId || !clientId) return null
  return { region, userPoolId, clientId }
}
