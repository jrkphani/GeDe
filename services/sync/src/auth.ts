/**
 * Auth middleware (ARCHITECTURE §1.3 "Auth Middleware"): verifies the Cognito
 * JWT on every REST call and on the WebSocket upgrade, and maps `sub` to a
 * `users` row.
 *
 * Which claims a Cognito token carries:
 *   - An *access* token (what the SPA sends, and the only kind the verifier
 *     accepts) has `sub`, `username`, `client_id`, `scope` — and no `email`.
 *     This pool signs in by email as a *username attribute*
 *     (`signInAliases: { email: true }` in `AuthStack`), so Cognito generates
 *     the username: `username` is a UUID, never the address.
 *   - An *id* token has `email` and `email_verified`.
 * So in production `users.email` is **never bound from an access token**:
 * every one yields `null` here, and the row keeps its email null until the
 * SPA presents its *ID token* to `PATCH /api/me { idToken }` — verified here
 * with `tokenUse: 'id'`, its `sub` matched against the caller's, its address
 * taken only beside `email_verified: true` (`verifiedEmailFromIdClaims`).
 * A client-claimed address is never accepted: the binding decides which
 * invitations convert into shares (SHARE-02), so it must be Cognito's word.
 * `emailFromClaims` remains the place an access token's claims could bind an
 * address — guarded (`email_verified`, an email-shaped `username`) for a pool
 * configured otherwise. Nothing is fetched from Cognito at request time.
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from './config.js';
import type { TokenVerifier } from './deps.js';
import { AppError } from './errors.js';
import type { Repo, TokenIdentity, UserRecord } from './repo/types.js';

export interface AuthUser {
  readonly id: string;
  readonly sub: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** I18N-05: the persisted locale choice, or null until the user makes one. */
  readonly locale: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email an identity may be bound to, or null. An `email` claim counts
 * only with `email_verified: true` beside it (#42: an identity provider that
 * hands out unverified emails must never bind one to a `users` row); an
 * email-shaped `username` counts because a pool that uses the address as the
 * username (alias sign-in) verifies it before any token exists. In *this*
 * pool neither is present on an access token (see the header), so the result
 * is `null` for every production request.
 */
export function emailFromClaims(claims: {
  email?: unknown;
  email_verified?: unknown;
  username?: unknown;
}): string | null {
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (verified && typeof claims.email === 'string' && EMAIL_RE.test(claims.email)) {
    return claims.email;
  }
  if (typeof claims.username === 'string' && EMAIL_RE.test(claims.username)) return claims.username;
  return null;
}

/**
 * The address an ID token attests, or null: `email` counts only beside
 * `email_verified: true`. Unlike `emailFromClaims` an email-shaped `username`
 * is not accepted — the ID token is the one place the pool states the
 * address explicitly, so nothing is inferred.
 */
export function verifiedEmailFromIdClaims(claims: {
  email?: unknown;
  email_verified?: unknown;
}): string | null {
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (verified && typeof claims.email === 'string' && EMAIL_RE.test(claims.email)) {
    return claims.email;
  }
  return null;
}

export function createCognitoVerifier(config: Config): TokenVerifier {
  // `clientId` may be a list: a token from any listed app client verifies (the SPA's and gede-e2e's).
  const pool = {
    userPoolId: config.COGNITO_USER_POOL_ID,
    clientId: [...config.COGNITO_CLIENT_IDS],
  };
  const access = CognitoJwtVerifier.create({ ...pool, tokenUse: 'access' });
  const id = CognitoJwtVerifier.create({ ...pool, tokenUse: 'id' });
  return {
    async verify(token) {
      const payload = await access.verify(token);
      return { sub: payload.sub, email: emailFromClaims(payload) };
    },
    async verifyIdToken(token) {
      const payload = await id.verify(token);
      return { sub: payload.sub, email: verifiedEmailFromIdClaims(payload) };
    },
  };
}

/**
 * Resolves a bearer token to a user row. Caches `sub → user` briefly so a
 * client issuing many requests per second does not upsert on every one; the
 * upsert also refreshes `last_seen_at`.
 */
export class UserResolver {
  private readonly cache = new Map<string, { user: UserRecord; at: number }>();

  constructor(
    private readonly verifier: TokenVerifier,
    private readonly repo: Repo,
    private readonly ttlMs = 60_000,
  ) {}

  async fromToken(token: string): Promise<AuthUser> {
    let identity: TokenIdentity;
    try {
      identity = await this.verifier.verify(token);
    } catch {
      throw new AppError(401, 'unauthenticated', 'Your session ended');
    }
    const cached = this.cache.get(identity.sub);
    const now = Date.now();
    if (
      cached &&
      now - cached.at < this.ttlMs &&
      (identity.email === null || cached.user.email !== null)
    ) {
      return toAuthUser(cached.user);
    }
    const user = await this.repo.users.upsertFromToken(identity);
    this.cache.set(identity.sub, { user, at: now });
    return toAuthUser(user);
  }

  /** Replace the cached row after a profile change so the next request sees it. */
  remember(user: UserRecord): void {
    this.cache.set(user.cognitoSub, { user, at: Date.now() });
  }
}

export function toAuthUser(user: UserRecord): AuthUser {
  return {
    id: user.id,
    sub: user.cognitoSub,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale,
  };
}

export function bearerToken(request: Pick<FastifyRequest, 'headers'>): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

/** `preValidation` hook for `/api/*` (after the rate limiter): 401 without a valid bearer token. */
export function requireUser(resolver: UserResolver) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token === null) throw new AppError(401, 'unauthenticated', 'Your session ended');
    request.user = await resolver.fromToken(token);
  };
}

/** The user attached by `requireUser`; throws if the hook did not run (a wiring bug, not a client error). */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new Error('route is missing the auth hook');
  return request.user;
}
