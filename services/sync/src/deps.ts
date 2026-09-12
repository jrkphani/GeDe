/**
 * Everything `buildServer` needs from the outside world, so tests can
 * substitute fakes for the JWT verifier, the database and S3 without a
 * network. `main.ts` wires the real implementations.
 */
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Repo, TokenIdentity } from './repo/types.js';

export interface TokenVerifier {
  /** Verify a Cognito access token. Rejects (throws) when invalid or expired. */
  verify(token: string): Promise<TokenIdentity>;
}

export interface SnapshotStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** `undefined` when the key does not exist. */
  get(key: string): Promise<Uint8Array | undefined>;
}

export interface Deps {
  readonly config: Config;
  readonly logger: Logger;
  readonly verifier: TokenVerifier;
  /** The repository — `createPgRepo` in production, an in-memory fake in tests. */
  readonly db: Repo;
  readonly s3: SnapshotStore;
  /** Reported by `/healthz`. */
  readonly version: string;
}
