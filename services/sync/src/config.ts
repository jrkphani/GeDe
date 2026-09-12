/**
 * Environment configuration, validated once at boot. Every value the service
 * needs comes from here; nothing reads `process.env` elsewhere.
 *
 * There is deliberately no auth bypass flag for any environment. Tests inject
 * a fake token verifier through `buildServer` deps instead.
 */
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  COGNITO_USER_POOL_ID: z.string().min(1),
  /**
   * App clients whose tokens are accepted, comma-separated: the SPA client and the
   * pipeline's `gede-e2e` client (the live suite signs in through it). `aws-jwt-verify`
   * checks the access token's `client_id` / the ID token's `aud` against the list.
   */
  COGNITO_CLIENT_IDS: z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    )
    .pipe(z.array(z.string().min(1)).nonempty()),
  COGNITO_REGION: z.string().min(1),
  /**
   * `true` once the task role holds `cognito-idp:AdminDeleteUser` on the pool
   * (#111, ADR-037): `DELETE /api/me` then deletes the Cognito user after the
   * database erasure. Off, the erasure still happens and the tombstone row
   * refuses the identity; the operator deletes the pool user by hand.
   */
  COGNITO_ERASE_IDENTITY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** S3 bucket for compacted Yjs snapshots (`docs`). */
  DOCS_BUCKET: z.string().min(1),
  /** Key prefix inside the bucket; a trailing `/` is added when missing. */
  DOCS_PREFIX: z
    .string()
    .default('')
    .transform((p) => (p === '' || p.endsWith('/') ? p : `${p}/`)),

  /** Exact origin of the SPA (`https://gede.work`). Used for CORS and the WebSocket Origin check. */
  WEB_ORIGIN: z.string().url(),

  /** Compact to a snapshot after this many persisted updates (ARCHITECTURE §1.2: 500). */
  SNAPSHOT_EVERY_UPDATES: positiveInt.default(500),
  /** …or after this long with no new update (ARCHITECTURE §1.2: 5 min). */
  SNAPSHOT_IDLE_MS: positiveInt.default(300_000),
  /** Evict an in-memory room after this long with no sockets. */
  ROOM_IDLE_MS: positiveInt.default(600_000),
  /** Coalescing window for the persistence writer. */
  PERSIST_COALESCE_MS: positiveInt.default(50),
  /** Debounce between a compaction and the projection write that follows it. */
  PROJECTION_DEBOUNCE_MS: positiveInt.default(1_000),
  /** Largest awareness update accepted from a client, in bytes. */
  AWARENESS_MAX_BYTES: positiveInt.default(4096),
  /**
   * Largest client → server frame, in bytes (#99, ADR-036): `ws` closes 1009
   * before the frame is assembled. A client's sync step 2 or update never
   * approaches this; server → client frames (a step 2 of a large document)
   * are not bounded by it.
   */
  WS_MAX_UPDATE_BYTES: positiveInt.default(2 * 1024 * 1024),
  /**
   * Bytes a socket may leave unread before it is closed as a slow consumer
   * (#37, #99). The step 2 the room sends a socket on join is allowed on top
   * of this once, so a large document can still be served.
   */
  WS_MAX_BUFFERED_BYTES: positiveInt.default(2 * 1024 * 1024),
  /** Sync messages (step 1, step 2, updates, awareness queries) a connection may send per second, sustained; over the burst it is closed (4429). */
  WS_UPDATES_PER_SEC: positiveInt.default(200),
  WS_UPDATES_BURST: positiveInt.default(400),
  /** Bytes of sync payload a connection may send per second, sustained; over the burst it is closed (4429) (#99). */
  WS_BYTES_PER_SEC: positiveInt.default(1024 * 1024),
  WS_BYTES_BURST: positiveInt.default(4 * 1024 * 1024),
  /** Awareness updates a connection may send per second, sustained; excess is dropped. */
  WS_AWARENESS_PER_SEC: positiveInt.default(20),
  WS_AWARENESS_BURST: positiveInt.default(40),
  /** Open rooms one task serves; a join that would open one more is refused 1013 (#99). */
  WS_MAX_ROOMS: positiveInt.default(500),
  /** Sockets one verified user may hold on one task, across documents; the next is refused 4429 (#99). */
  WS_MAX_SOCKETS_PER_USER: positiveInt.default(16),
  /** Sockets one task serves in total; the next is refused 1013 (#99). */
  WS_MAX_SOCKETS: positiveInt.default(2000),
  /**
   * How often a connection's permission (and its token's expiry) is
   * re-resolved from the database (#104): a share change made on another
   * task, or by hand, reaches the socket within this interval.
   */
  WS_PERMISSION_RECHECK_MS: positiveInt.default(60_000),
  /**
   * Bytes appended to `doc_updates` since the last snapshot before the room
   * compacts early (#99, ADR-036): the log never holds more than this per
   * document between snapshots, whatever the update count.
   */
  DOC_LOG_MAX_BYTES: positiveInt.default(8 * 1024 * 1024),
  /**
   * Hard ceiling on one document's state, in bytes (#99, ADR-036). An update
   * that would take the document past it is refused and the socket closed
   * 4413; the ceiling is checked against the room's running estimate, which
   * the next snapshot corrects to the encoded size.
   */
  DOC_MAX_BYTES: positiveInt.default(64 * 1024 * 1024),
  /** `/api` requests per minute per verified user before 429 (#37). */
  RATE_LIMIT_PER_MINUTE: positiveInt.default(300),
  /**
   * Requests per minute per client address on every route (REST, upgrade,
   * unauthenticated). Generous because `/api` arrives through CloudFront, whose
   * edge is the address every user behind that POP shares (`server.ts`).
   */
  RATE_LIMIT_PER_IP_PER_MINUTE: positiveInt.default(3000),
  /**
   * Invitations one verified user may send per hour before 429 (SHARE-02).
   * A stricter bucket than the request limit: every invitation is an
   * outbound email from the product's domain.
   */
  RATE_LIMIT_INVITES_PER_HOUR: positiveInt.default(30),
  /** Graceful shutdown budget; ECS sends SIGKILL 30 s after SIGTERM. */
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(25_000),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return parsed.data;
}
