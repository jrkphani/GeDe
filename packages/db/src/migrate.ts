/**
 * Migration runner. Runs at service boot (root CLAUDE.md: "Migrations run on
 * service boot under an advisory lock") so several ECS tasks starting at once
 * apply each file exactly once.
 *
 * Contract:
 *   - `dir/*.sql` sorted by name is the migration order (`0000_init.sql`, `0001_…`).
 *   - Each file runs in its own transaction and is recorded in `__migrations`
 *     with the SHA-256 of its text (migration 0005). A file whose text no
 *     longer matches its ledger row fails the boot (#42): a shipped migration
 *     is never edited, a new one alters. Rows from before 0005 have no
 *     checksum and are pinned on the next run.
 *   - A failure aborts the boot; the file that failed is named in the error.
 *   - Waiting for the advisory lock is bounded by `LOCK_TIMEOUT_MS`; a
 *     migration statement itself is not (DDL on a big table may be slow).
 *
 * The runner depends on the smallest slice of `pg` it needs so tests can pass
 * a fake pool without a live database.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MigrationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface MigrationResult {
  /** File names applied by this call, in order. */
  applied: string[];
  /** Files already present in the ledger. */
  skipped: number;
}

export interface MigrationOptions {
  logger?: MigrationLogger;
  /** Override file discovery (tests). Defaults to reading `*.sql` from `dir`. */
  readFiles?: (dir: string) => Promise<{ name: string; sql: string }[]>;
}

const LOCK_KEY_SQL = "SELECT pg_advisory_lock(hashtext('gede_migrations'))";
const UNLOCK_KEY_SQL = "SELECT pg_advisory_unlock(hashtext('gede_migrations'))";
const LEDGER_SQL =
  'CREATE TABLE IF NOT EXISTS __migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())';
/** Rows applied before 0005 carry no checksum; the column may not exist yet on first boot. */
const LEDGER_CHECKSUM_SQL = 'ALTER TABLE __migrations ADD COLUMN IF NOT EXISTS checksum text';
const LEDGER_READ_SQL = 'SELECT name, checksum FROM __migrations';

/** How long a booting task waits for another task's migration run before giving up (#42). */
export const LOCK_TIMEOUT_MS = 120_000;
/** Bound the session while it holds the advisory lock; a migration statement itself is unbounded. */
const SESSION_TIMEOUTS_SQL = [
  `SET lock_timeout = '${String(LOCK_TIMEOUT_MS)}ms'`,
  "SET idle_in_transaction_session_timeout = '60s'",
  "SET statement_timeout = '0'",
];

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

const silentLogger: MigrationLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    override readonly cause: unknown,
  ) {
    super(
      `migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MigrationError';
  }
}

async function readSqlFiles(dir: string): Promise<{ name: string; sql: string }[]> {
  const entries = await readdir(dir);
  const names = entries.filter((name) => name.endsWith('.sql'));
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

export async function applyMigrations(
  pool: MigrationPool,
  dir: string,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const log = options.logger ?? silentLogger;
  const files = [...(await (options.readFiles ?? readSqlFiles)(dir))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const client = await pool.connect();
  const applied: string[] = [];
  let skipped = 0;

  try {
    for (const statement of SESSION_TIMEOUTS_SQL) await client.query(statement);
    await client.query(LOCK_KEY_SQL);
    let failure: unknown;
    try {
      await client.query(LEDGER_SQL);
      await client.query(LEDGER_CHECKSUM_SQL);
      const ledger = await client.query(LEDGER_READ_SQL);
      const done = new Map(
        ledger.rows.map((row) => [
          String(row.name),
          typeof row.checksum === 'string' ? row.checksum : null,
        ]),
      );

      for (const file of files) {
        const checksum = migrationChecksum(file.sql);
        const recorded = done.get(file.name);
        if (recorded !== undefined) {
          if (recorded === null) {
            // Applied before checksums existed: pin the text that is on disk now.
            await client.query('UPDATE __migrations SET checksum = $2 WHERE name = $1', [
              file.name,
              checksum,
            ]);
            log.info('migration checksum recorded', { migration: file.name });
          } else if (recorded !== checksum) {
            throw new MigrationError(
              file.name,
              new Error(
                `file text differs from what was applied (ledger ${recorded.slice(0, 12)}…, disk ${checksum.slice(0, 12)}…); shipped migrations are never edited, write a new one`,
              ),
            );
          }
          skipped += 1;
          continue;
        }
        log.info('applying migration', { migration: file.name });
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query('INSERT INTO __migrations (name, checksum) VALUES ($1, $2)', [
            file.name,
            checksum,
          ]);
          await client.query('COMMIT');
        } catch (cause) {
          await client.query('ROLLBACK').catch((rollbackError: unknown) => {
            log.error('rollback failed', { migration: file.name, error: String(rollbackError) });
          });
          throw new MigrationError(file.name, cause);
        }
        applied.push(file.name);
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // An unlock failure must not mask the migration error that got us here.
      await client.query(UNLOCK_KEY_SQL).catch((unlockError: unknown) => {
        log.error('advisory unlock failed', { error: String(unlockError) });
        if (failure === undefined) throw unlockError;
      });
    }
  } finally {
    client.release();
  }

  log.info('migrations complete', { applied: applied.length, skipped });
  return { applied, skipped };
}
