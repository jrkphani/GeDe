/**
 * Migration runner. Runs at service boot (root CLAUDE.md: "Migrations run on
 * service boot under an advisory lock") so several ECS tasks starting at once
 * apply each file exactly once.
 *
 * Contract:
 *   - `dir/*.sql` sorted by name is the migration order (`0000_init.sql`, `0001_…`).
 *   - Each file runs in its own transaction and is recorded in `__migrations`.
 *   - A failure aborts the boot; the file that failed is named in the error.
 *
 * The runner depends on the smallest slice of `pg` it needs so tests can pass
 * a fake pool without a live database.
 */
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
    await client.query(LOCK_KEY_SQL);
    try {
      await client.query(LEDGER_SQL);
      const ledger = await client.query('SELECT name FROM __migrations');
      const done = new Set(ledger.rows.map((row) => String(row.name)));

      for (const file of files) {
        if (done.has(file.name)) {
          skipped += 1;
          continue;
        }
        log.info('applying migration', { migration: file.name });
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query('INSERT INTO __migrations (name) VALUES ($1)', [file.name]);
          await client.query('COMMIT');
        } catch (cause) {
          await client.query('ROLLBACK').catch((rollbackError: unknown) => {
            log.error('rollback failed', { migration: file.name, error: String(rollbackError) });
          });
          throw new MigrationError(file.name, cause);
        }
        applied.push(file.name);
      }
    } finally {
      await client.query(UNLOCK_KEY_SQL);
    }
  } finally {
    client.release();
  }

  log.info('migrations complete', { applied: applied.length, skipped });
  return { applied, skipped };
}
