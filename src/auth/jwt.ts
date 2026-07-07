// Pure JWT payload decode (issue 033) — no signature verification. The
// client only needs the claims/expiry to drive UI state and to know when to
// refresh; the server side (issues 032/034) is the one that verifies the
// signature against Cognito's JWKS — see deploy/cdk/lib/auth-stack.ts's
// `UserPoolJwksUri` output for that seam. Never trust this decode for an
// authorization decision on the client (there is none here — auth gates the
// shared server, not the local app, issue 033 design brief).

export interface JwtPayload {
  sub: string
  email?: string
  exp: number
  iat: number
  [claim: string]: unknown
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (normalized.length % 4)) % 4
  const padded = normalized + '='.repeat(padLength)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

/** Decodes a JWT's payload segment. Returns null for anything malformed or
 *  missing the two claims every Cognito ID token carries (`sub`, `exp`). */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1] as string)) as JwtPayload
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null
    return payload
  } catch {
    return null
  }
}

/** True when the token is missing, malformed, or expired — with a small
 *  safety skew so a caller doesn't race a same-second expiry against the
 *  server clock. */
export function isJwtExpired(token: string | null, skewSeconds = 30): boolean {
  if (!token) return true
  const payload = decodeJwtPayload(token)
  if (!payload) return true
  return Date.now() >= (payload.exp - skewSeconds) * 1000
}
