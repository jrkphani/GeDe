/**
 * Auth middleware (ARCHITECTURE §1.3 "Auth Middleware"): verifies the Cognito
 * JWT on every REST call and on the WebSocket upgrade, and maps `sub` to a
 * `users` row.
 *
 * Which claims a Cognito token carries:
 *   - An *access* token (what the SPA sends) has `sub`, `username`, `client_id`,
 *     `scope` — and no `email` unless the pool is configured to add it as a
 *     custom claim. `username` is the sign-in alias, which for email-code
 *     sign-in is the email address and for Apple federation is an opaque id.
 *   - An *id* token has `email`.
 * We store an email only when the token gives us one we can trust (an `email`
 * claim, or a `username` that is an email). Otherwise `users.email` stays
 * null until a later request carries it; the SPA can also PATCH a profile
 * later. Nothing is fetched from Cognito at request time.
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
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailFromClaims(claims: { email?: unknown; username?: unknown }): string | null {
  if (typeof claims.email === 'string' && EMAIL_RE.test(claims.email)) return claims.email;
  if (typeof claims.username === 'string' && EMAIL_RE.test(claims.username)) return claims.username;
  return null;
}

export function createCognitoVerifier(config: Config): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    clientId: config.COGNITO_CLIENT_ID,
    tokenUse: 'access',
  });
  return {
    async verify(token) {
      const payload = await verifier.verify(token);
      return { sub: payload.sub, email: emailFromClaims(payload) };
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
}

function toAuthUser(user: UserRecord): AuthUser {
  return { id: user.id, sub: user.cognitoSub, email: user.email, displayName: user.displayName };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

/** `onRequest` hook for `/api/*`: 401 without a valid bearer token. */
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
