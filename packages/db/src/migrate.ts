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
 *   - With `appRole` set, the least-privilege runtime role is created or
 *     updated under the same lock before the first file (#36); the runner
 *     itself always runs as the master user, which owns every object.
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

/** The least-privilege role the runtime connects as (#36); see `bootstrapAppRole`. */
export interface AppRole {
  user: string;
  password: string;
}

export interface MigrationOptions {
  logger?: MigrationLogger;
  /** Override file discovery (tests). Defaults to reading `*.sql` from `dir`. */
  readFiles?: (dir: string) => Promise<{ name: string; sql: string }[]>;
  /**
   * When set, the runner (as the master user, under the same lock, before the
   * first migration) creates or updates this login role and grants it DML on
   * everything in `public`, now and for tables later migrations add. Unset
   * locally, where the runtime connects as the master user.
   */
  appRole?: AppRole;
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
/** Undo the above before the connection goes back to the pool (RESET restores the startup parameters). */
export const SESSION_RESET_SQL = [
  'RESET lock_timeout',
  'RESET idle_in_transaction_session_timeout',
  'RESET statement_timeout',
];

/**
 * The app role bootstrap (#36). Runs as the master user on every boot and is
 * idempotent, so a rotated password (runbook §3) or a role someone dropped
 * by hand is repaired by the next deployment.
 *
 * The role name and password travel as bind parameters into session settings
 * (`set_config`, transaction-local) and the DO block reads them back with
 * `current_setting`, so neither the query text nor a `log_statement = 'ddl'`
 * line ever carries the password: `ALTER ROLE` cannot take a bind parameter
 * and `format('%L')` quotes the literal server-side.
 *
 * What the role gets: LOGIN, CONNECT, USAGE on `public`, SELECT/INSERT/UPDATE/
 * DELETE on every table and USAGE/SELECT on every sequence — both now and by
 * default for objects the migrating role creates later (`ALTER DEFAULT
 * PRIVILEGES` without `FOR ROLE` binds to the current, migrating, user). What
 * it never gets: CREATE on the schema (the PostgreSQL ≤ 14 grant to PUBLIC is
 * revoked as 15+ already does), TRUNCATE, DDL, ownership, role or database
 * creation, replication, RLS bypass, inheritance, or writes to the migration
 * ledger. Everything the runtime does (`services/sync/src/repo/pg.ts`) is
 * DML: row locks (`FOR UPDATE [SKIP LOCKED]`) and full-text search need no
 * further privilege.
 */
export const APP_ROLE_SETTING_USER = 'gede.app_role';
export const APP_ROLE_SETTING_PASSWORD = 'gede.app_password';
export const APP_ROLE_BOOTSTRAP_SQL = `DO $bootstrap$
DECLARE
  role_name text := current_setting('${APP_ROLE_SETTING_USER}');
  role_password text := current_setting('${APP_ROLE_SETTING_PASSWORD}');
  alter_detail text;
BEGIN
  -- The RDS master user is rds_superuser (CREATEROLE), not a superuser: it may
  -- create a role with SUPERUSER/REPLICATION/BYPASSRLS off, but ALTER ROLE
  -- refuses those three clauses from a non-superuser even as NO…, so they are
  -- set at creation only and asserted by db:parity.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
    EXECUTE format(
      'CREATE ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      role_name);
  END IF;
  -- An ALTER ROLE that fails (no ADMIN OPTION on a role someone else created)
  -- would reach the server log with its statement text as CONTEXT, password
  -- literal included. An error caught here is flushed, never logged; what is
  -- re-raised carries the message and detail but no statement text.
  BEGIN
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
      role_name, role_password);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS alter_detail = PG_EXCEPTION_DETAIL;
    RAISE EXCEPTION 'ALTER ROLE % failed: %', role_name, SQLERRM
      USING ERRCODE = SQLSTATE, DETAIL = alter_detail;
  END;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), role_name);
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role_name);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', role_name);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    role_name);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    role_name);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON __migrations FROM %I', role_name);
END
$bootstrap$`;
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

/** Role names are quoted with `%I` server-side; this only keeps a typo from reaching `CREATE ROLE`. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function bootstrapAppRole(
  client: MigrationClient,
  role: AppRole,
  log: MigrationLogger,
): Promise<void> {
  if (!ROLE_NAME.test(role.user)) {
    throw new Error(`app role name ${JSON.stringify(role.user)} is not a plain identifier`);
  }
  if (role.password === '') throw new Error('app role password is empty');
  log.info('bootstrapping app role', { role: role.user });
  await client.query('BEGIN');
  try {
    // `set_config(..., true)` is transaction-local: the values die with the COMMIT.
    await client.query('SELECT set_config($1, $2, true)', [APP_ROLE_SETTING_USER, role.user]);
    await client.query('SELECT set_config($1, $2, true)', [
      APP_ROLE_SETTING_PASSWORD,
      role.password,
    ]);
    await client.query(APP_ROLE_BOOTSTRAP_SQL);
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      log.error('rollback failed', { step: 'app role bootstrap', error: String(rollbackError) });
    });
    throw new MigrationError('app role bootstrap', cause);
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
  let resetFailure: Error | undefined;

  try {
    for (const statement of SESSION_TIMEOUTS_SQL) await client.query(statement);
    await client.query(LOCK_KEY_SQL);
    let failure: unknown;
    try {
      await client.query(LEDGER_SQL);
      await client.query(LEDGER_CHECKSUM_SQL);
      // After the ledger exists (so its write privileges can be revoked) and
      // before any file runs (so this run's tables fall under the defaults).
      if (options.appRole !== undefined) await bootstrapAppRole(client, options.appRole, log);
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
    // A SET is session-scoped: without this the connection goes back to the
    // pool with no statement timeout and a two-minute lock wait for the life
    // of the process. RESET restores the pool's startup parameters. A failed
    // reset is reported after the release; a migration error still wins.
    for (const statement of SESSION_RESET_SQL) {
      await client.query(statement).catch((resetError: unknown) => {
        log.error('migration session reset failed', { statement, error: String(resetError) });
        resetFailure ??=
          resetError instanceof Error
            ? resetError
            : new Error(`${statement}: ${String(resetError)}`);
      });
    }
    client.release();
  }
  if (resetFailure !== undefined) throw resetFailure;

  log.info('migrations complete', { applied: applied.length, skipped });
  return { applied, skipped };
}
