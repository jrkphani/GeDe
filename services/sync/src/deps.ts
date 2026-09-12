/**
 * Everything `buildServer` needs from the outside world, so tests can
 * substitute fakes for the JWT verifier, the database, S3 and SES without a
 * network. `main.ts` wires the real implementations.
 */
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Mail } from './mail/templates.js';
import type { Repo, TokenIdentity } from './repo/types.js';

/** What a verified Cognito ID token attests (SHARE-02: the only source an address is ever bound from). */
export interface IdTokenIdentity {
  readonly sub: string;
  /** Present only when the token carried `email` with `email_verified: true`. */
  readonly email: string | null;
}

export interface TokenVerifier {
  /** Verify a Cognito access token. Rejects (throws) when invalid or expired. */
  verify(token: string): Promise<TokenIdentity>;
  /**
   * Verify a Cognito ID token for the same pool and client. Rejects when
   * invalid or expired. The SPA presents one to `PATCH /api/me` so the
   * service can bind the verified address to the caller's row.
   */
  verifyIdToken(token: string): Promise<IdTokenIdentity>;
}

export interface SnapshotStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** `undefined` when the key does not exist. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Delete every object under `prefix` (a purged document's folder). Resolves to the count removed. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Outbound mail (share invitations, SHARE-02). SES v2 in production, a recording fake in tests. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface Deps {
  readonly config: Config;
  readonly logger: Logger;
  readonly verifier: TokenVerifier;
  /** The repository — `createPgRepo` in production, an in-memory fake in tests. */
  readonly db: Repo;
  readonly s3: SnapshotStore;
  readonly mail: Mailer;
  /** Reported by `/healthz`. */
  readonly version: string;
}
