/**
 * Everything `buildServer` needs from the outside world, so tests can
 * substitute fakes for the JWT verifier, the database, S3 and SES without a
 * network. `main.ts` wires the real implementations.
 */
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { MailEventQueue } from './mail/events.js';
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

/**
 * The identity provider's side of account erasure (#111, ADR-038): delete the
 * Cognito user so the identity cannot sign in again. Cognito
 * (`AdminDeleteUser`) in production when `COGNITO_ERASE_IDENTITY` is on, a
 * recording fake in tests, `null` when the deploy has not granted the task
 * role the permission yet — the database erasure still happens and the
 * tombstone refuses the identity meanwhile.
 */
export interface IdentityStore {
  /** Delete the user `sub` identifies. Resolves when gone (or already gone); rejects on any other failure. */
  deleteUser(sub: string): Promise<void>;
}

export interface Deps {
  readonly config: Config;
  readonly logger: Logger;
  readonly verifier: TokenVerifier;
  /** The repository — `createPgRepo` in production, an in-memory fake in tests. */
  readonly db: Repo;
  readonly s3: SnapshotStore;
  readonly mail: Mailer;
  /** Null until the task role may delete Cognito users (`COGNITO_ERASE_IDENTITY`). */
  readonly identity: IdentityStore | null;
  /**
   * The SES events queue (bounces, complaints, rejects; ADR-046): SQS when
   * `SES_EVENTS_QUEUE_URL` is set, a fake in tests, `null` locally — no
   * poller runs and no address is ever suppressed.
   */
  readonly mailEvents: MailEventQueue | null;
  /** Reported by `/healthz`. */
  readonly version: string;
}
