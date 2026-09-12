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
  COGNITO_CLIENT_ID: z.string().min(1),
  COGNITO_REGION: z.string().min(1),

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
  /** Largest awareness update accepted from a client, in bytes. */
  AWARENESS_MAX_BYTES: positiveInt.default(4096),
  /** Largest WebSocket frame accepted, in bytes (a sync step 2 of a large document). */
  WS_MAX_PAYLOAD_BYTES: positiveInt.default(16 * 1024 * 1024),
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
