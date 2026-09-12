import { describe, expect, test } from 'vitest';

import {
  APP_ROLE_BOOTSTRAP_SQL,
  APP_ROLE_SETTING_PASSWORD,
  APP_ROLE_SETTING_USER,
  applyMigrations,
  LOCK_TIMEOUT_MS,
  migrationChecksum,
  MigrationError,
  SESSION_RESET_SQL,
  type MigrationClient,
  type MigrationPool,
} from './migrate.js';

/**
 * A labelled fake of the `pg` pool surface the runner uses. It records every
 * statement and simulates the `__migrations` ledger; it is not a database.
 */
function fakePool(
  options: { ledger?: string[]; checksums?: Record<string, string | null>; failOn?: string } = {},
) {
  /** name → checksum (null for a row applied before migration 0005). */
  const ledger = new Map<string, string | null>(
    (options.ledger ?? []).map((name) => [name, options.checksums?.[name] ?? null]),
  );
  const statements: string[] = [];
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  let released = 0;
  let inTransaction = false;

  const client: MigrationClient = {
    query(text, values) {
      statements.push(text);
      calls.push({ text, values });
      if (text === 'BEGIN') inTransaction = true;
      if (text === 'COMMIT' || text === 'ROLLBACK') inTransaction = false;
      if (text === 'SELECT name, checksum FROM __migrations') {
        return Promise.resolve({
          rows: [...ledger].map(([name, checksum]) => ({ name, checksum })),
        });
      }
      if (text.startsWith('INSERT INTO __migrations')) {
        ledger.set(String(values?.[0]), String(values?.[1]));
      }
      if (text.startsWith('UPDATE __migrations SET checksum')) {
        ledger.set(String(values?.[0]), String(values?.[1]));
      }
      if (options.failOn !== undefined && text.includes(options.failOn)) {
        return Promise.reject(new Error(`boom: ${options.failOn}`));
      }
      return Promise.resolve({ rows: [] });
    },
    release() {
      released += 1;
    },
  };

  const pool: MigrationPool = { connect: () => Promise.resolve(client) };
  return {
    pool,
    statements,
    calls,
    ledger,
    get released() {
      return released;
    },
    get inTransaction() {
      return inTransaction;
    },
  };
}

const files = [
  { name: '0000_init.sql', sql: 'CREATE TABLE a ()' },
  { name: '0001_second.sql', sql: 'CREATE TABLE b ()' },
  { name: '0002_third.sql', sql: 'CREATE TABLE c ()' },
];

const readFiles = () => Promise.resolve([...files].reverse()); // deliberately unsorted input

describe('applyMigrations', () => {
  test('LOAD-06 applies every file once, in name order, under the advisory lock, each in a transaction', async () => {
    const db = fakePool();
    const result = await applyMigrations(db.pool, '/ignored', {
      readFiles: () => Promise.resolve([...files].sort((a, b) => a.name.localeCompare(b.name))),
    });

    expect(result).toEqual({
      applied: ['0000_init.sql', '0001_second.sql', '0002_third.sql'],
      skipped: 0,
    });
    // Session limits first (bounded lock wait, no statement timeout for DDL), then the lock.
    expect(db.statements.slice(0, 3)).toEqual([
      `SET lock_timeout = '${String(LOCK_TIMEOUT_MS)}ms'`,
      "SET idle_in_transaction_session_timeout = '60s'",
      "SET statement_timeout = '0'",
    ]);
    expect(db.statements[3]).toContain('pg_advisory_lock');
    expect(db.statements[4]).toContain('CREATE TABLE IF NOT EXISTS __migrations');
    expect(db.statements[5]).toContain('ADD COLUMN IF NOT EXISTS checksum');
    // The lock goes first, then the session hands the pool's own limits back (#42).
    expect(db.statements.at(-4)).toContain('pg_advisory_unlock');
    expect(db.statements.slice(-3)).toEqual(SESSION_RESET_SQL);
    expect(db.released).toBe(1);
    expect(db.inTransaction).toBe(false);

    const perFile = db.statements.slice(7, 12);
    expect(perFile).toEqual([
      'BEGIN',
      'CREATE TABLE a ()',
      'INSERT INTO __migrations (name, checksum) VALUES ($1, $2)',
      'COMMIT',
      'BEGIN',
    ]);
    expect([...db.ledger.keys()]).toEqual(['0000_init.sql', '0001_second.sql', '0002_third.sql']);
    expect(db.ledger.get('0000_init.sql')).toBe(migrationChecksum('CREATE TABLE a ()'));
  });

  test('LOAD-06 skips files already in the ledger and reports the count; rows without a checksum are pinned', async () => {
    const db = fakePool({ ledger: ['0000_init.sql', '0001_second.sql'] });
    const result = await applyMigrations(db.pool, '/ignored', { readFiles });
    expect(result).toEqual({ applied: ['0002_third.sql'], skipped: 2 });
    expect(db.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([
      'CREATE TABLE c ()',
    ]);
    expect(db.ledger.get('0000_init.sql')).toBe(migrationChecksum('CREATE TABLE a ()'));
    expect(db.ledger.get('0001_second.sql')).toBe(migrationChecksum('CREATE TABLE b ()'));
  });

  test('LOAD-06 an edited shipped migration fails the boot with the file named (#42)', async () => {
    const db = fakePool({
      ledger: ['0000_init.sql'],
      checksums: { '0000_init.sql': migrationChecksum('CREATE TABLE a (was different)') },
    });
    await expect(applyMigrations(db.pool, '/ignored', { readFiles })).rejects.toThrow(
      /0000_init\.sql failed: file text differs/,
    );
    expect(db.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([]);
    expect(db.statements.at(-4)).toContain('pg_advisory_unlock');
    expect(db.statements.slice(-3)).toEqual(SESSION_RESET_SQL);
    expect(db.released).toBe(1);
  });

  test('LOAD-06 a shipped migration that was removed fails the boot with its name; a renamed one is refused under the old name and never re-applied under the new (#110)', async () => {
    const removed = fakePool({
      ledger: ['0000_init.sql', '0001_second.sql', '0002_third.sql'],
      checksums: {
        '0000_init.sql': migrationChecksum('CREATE TABLE a ()'),
        '0001_second.sql': migrationChecksum('CREATE TABLE b ()'),
        '0002_third.sql': migrationChecksum('CREATE TABLE c ()'),
      },
    });
    await expect(
      applyMigrations(removed.pool, '/ignored', {
        readFiles: () => Promise.resolve(files.filter((f) => f.name !== '0001_second.sql')),
      }),
    ).rejects.toThrow(/migration 0001_second\.sql failed: ledger row has no file on disk/);
    expect(removed.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([]);
    expect(removed.released).toBe(1);

    const renamed = fakePool({
      ledger: ['0000_init.sql', '0001_second.sql', '0002_third.sql'],
      checksums: {
        '0000_init.sql': migrationChecksum('CREATE TABLE a ()'),
        '0001_second.sql': migrationChecksum('CREATE TABLE b ()'),
        '0002_third.sql': migrationChecksum('CREATE TABLE c ()'),
      },
    });
    const error = await applyMigrations(renamed.pool, '/ignored', {
      readFiles: () =>
        Promise.resolve(
          files.map((f) => (f.name === '0002_third.sql' ? { ...f, name: '0002_third_v2.sql' } : f)),
        ),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).migration).toBe('0002_third.sql');
    expect((error as Error).message).toContain('never removed or renamed');
    // Under the new name nothing ran and nothing was recorded.
    expect(renamed.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([]);
    expect(renamed.ledger.has('0002_third_v2.sql')).toBe(false);
    expect(renamed.ledger.size).toBe(3);
  });

  test('LOAD-06 a new file that sorts before the newest applied migration is refused, not applied out of order (#110)', async () => {
    const db = fakePool({
      ledger: ['0000_init.sql', '0002_third.sql'],
      checksums: {
        '0000_init.sql': migrationChecksum('CREATE TABLE a ()'),
        '0002_third.sql': migrationChecksum('CREATE TABLE c ()'),
      },
    });
    await expect(applyMigrations(db.pool, '/ignored', { readFiles })).rejects.toThrow(
      /migration 0001_second\.sql failed: sorts before the newest applied migration 0002_third\.sql/,
    );
    expect(db.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([]);
    expect(db.ledger.size).toBe(2);
    expect(db.released).toBe(1);
  });

  test('LOAD-06 a ledger row newer than every file is a rolled-back deploy: logged, tolerated, nothing applied (#110)', async () => {
    const db = fakePool({
      ledger: ['0000_init.sql', '0001_second.sql', '0002_third.sql', '0003_from_the_future.sql'],
      checksums: {
        '0000_init.sql': migrationChecksum('CREATE TABLE a ()'),
        '0001_second.sql': migrationChecksum('CREATE TABLE b ()'),
        '0002_third.sql': migrationChecksum('CREATE TABLE c ()'),
        '0003_from_the_future.sql': migrationChecksum('CREATE TABLE d ()'),
      },
    });
    const warnings: { message: string; meta: Record<string, unknown> | undefined }[] = [];
    const result = await applyMigrations(db.pool, '/ignored', {
      readFiles,
      logger: {
        info: () => undefined,
        warn: (message, meta) => {
          warnings.push({ message, meta });
        },
        error: () => undefined,
      },
    });
    expect(result).toEqual({ applied: [], skipped: 3 });
    expect(warnings).toEqual([
      {
        message: 'ledger is ahead of the files on disk (a rolled-back deploy?)',
        meta: { migrations: ['0003_from_the_future.sql'] },
      },
    ]);
    expect(db.ledger.size).toBe(4);
  });

  test('LOAD-06 a second run is a no-op', async () => {
    const db = fakePool();
    await applyMigrations(db.pool, '/ignored', { readFiles });
    const again = await applyMigrations(db.pool, '/ignored', { readFiles });
    expect(again).toEqual({ applied: [], skipped: 3 });
  });

  test('LOAD-06 a failing file rolls back, is not recorded, stops the run, and still unlocks', async () => {
    const db = fakePool({ failOn: 'CREATE TABLE b' });
    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
    };

    await expect(
      applyMigrations(db.pool, '/ignored', { readFiles, logger }),
    ).rejects.toBeInstanceOf(MigrationError);
    await expect(applyMigrations(db.pool, '/ignored', { readFiles, logger })).rejects.toThrow(
      /0001_second\.sql/,
    );

    expect([...db.ledger.keys()]).toEqual(['0000_init.sql']);
    expect(db.statements).toContain('ROLLBACK');
    expect(db.statements.filter((s) => s.includes('pg_advisory_unlock')).length).toBe(2);
    // The session limits are reset on the failure path too, before the connection is released.
    expect(db.statements.filter((s) => s === 'RESET statement_timeout').length).toBe(2);
    expect(db.statements.slice(-3)).toEqual(SESSION_RESET_SQL);
    expect(db.statements.filter((s) => s === 'CREATE TABLE c ()')).toEqual([]);
    expect(db.released).toBe(2);
    expect(logs).toContain('info applying migration');
  });

  test('LOAD-06 a lock wait that times out releases the connection with its limits reset (#42)', async () => {
    const db = fakePool({ failOn: 'pg_advisory_lock(' });
    await expect(applyMigrations(db.pool, '/ignored', { readFiles })).rejects.toThrow(
      /pg_advisory_lock/,
    );
    expect(db.statements.some((s) => s.includes('pg_advisory_unlock'))).toBe(false);
    expect(db.statements.slice(-3)).toEqual(SESSION_RESET_SQL);
    expect(db.released).toBe(1);
  });

  describe('app role bootstrap (#36)', () => {
    const appRole = { user: 'gede_app', password: "s3cret'--pw" };

    test('SHARE-03 runs under the lock, after the ledger exists and before the first file, in its own transaction', async () => {
      const db = fakePool();
      const result = await applyMigrations(db.pool, '/ignored', { readFiles, appRole });
      expect(result.applied).toHaveLength(3);

      const lock = db.statements.findIndex((s) => s.includes('pg_advisory_lock'));
      const ledger = db.statements.findIndex((s) =>
        s.includes('ADD COLUMN IF NOT EXISTS checksum'),
      );
      const bootstrap = db.statements.indexOf(APP_ROLE_BOOTSTRAP_SQL);
      const firstFile = db.statements.indexOf('CREATE TABLE a ()');
      expect(lock).toBeLessThan(ledger);
      expect(ledger).toBeLessThan(bootstrap);
      expect(bootstrap).toBeLessThan(firstFile);
      // BEGIN, set_config ×2, DO block, COMMIT — then the ledger read and the files.
      expect(db.statements.slice(bootstrap - 3, bootstrap + 2)).toEqual([
        'BEGIN',
        'SELECT set_config($1, $2, true)',
        'SELECT set_config($1, $2, true)',
        APP_ROLE_BOOTSTRAP_SQL,
        'COMMIT',
      ]);
      expect(db.inTransaction).toBe(false);
    });

    test('SHARE-03 the password travels only as a bind value; no statement text carries it', async () => {
      const db = fakePool();
      await applyMigrations(db.pool, '/ignored', { readFiles, appRole });
      expect(db.statements.some((s) => s.includes(appRole.password))).toBe(false);
      expect(db.calls.map((c) => c.values)).toContainEqual([
        APP_ROLE_SETTING_PASSWORD,
        appRole.password,
      ]);
      expect(db.calls.map((c) => c.values)).toContainEqual([APP_ROLE_SETTING_USER, 'gede_app']);
    });

    test('SHARE-03 the role is DML-only: no CREATE, TRUNCATE, ownership or ledger writes', () => {
      const sql = APP_ROLE_BOOTSTRAP_SQL;
      expect(sql).toContain(
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      );
      expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public');
      expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public');
      expect(sql).toContain(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES',
      );
      expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON __migrations');
      expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      expect(sql).not.toMatch(/GRANT (ALL|CREATE|TRUNCATE|OWNER)/);
      // A non-superuser master (RDS) may not mention these in ALTER ROLE, even negated.
      expect(sql).not.toMatch(/ALTER ROLE[^']*(SUPERUSER|REPLICATION|BYPASSRLS)/);
    });

    test('SHARE-03 a failing ALTER ROLE is caught and re-raised without its statement text, so the server log never carries the password literal', () => {
      const sql = APP_ROLE_BOOTSTRAP_SQL;
      // The one statement whose text holds the password sits inside its own
      // EXCEPTION block; a caught error is flushed by the server, not logged
      // with `CONTEXT: SQL statement "ALTER ROLE … PASSWORD '…'"`.
      const alter = sql.indexOf("'ALTER ROLE %I");
      const guard = sql.indexOf('EXCEPTION WHEN OTHERS THEN', alter);
      const reraise = sql.indexOf('RAISE EXCEPTION', guard);
      expect(alter).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(alter);
      expect(reraise).toBeGreaterThan(guard);
      // The inner block holds exactly that one EXECUTE, and the re-raise never
      // mentions the password variable.
      const block = sql.slice(sql.lastIndexOf('BEGIN', alter), guard);
      expect(block.match(/EXECUTE/g)).toHaveLength(1);
      expect(sql.slice(reraise, sql.indexOf(';', reraise))).not.toContain('role_password');
    });

    test('SHARE-03 without an app role nothing about roles is sent (local database)', async () => {
      const db = fakePool();
      await applyMigrations(db.pool, '/ignored', { readFiles });
      expect(db.statements.some((s) => s.includes('set_config') || s.includes('ROLE'))).toBe(false);
    });

    test('SHARE-03 a malformed role name or empty password is refused before any statement reaches the role', async () => {
      const bad = fakePool();
      await expect(
        applyMigrations(bad.pool, '/ignored', {
          readFiles,
          appRole: { user: 'gede_app; DROP ROLE x', password: 'x' },
        }),
      ).rejects.toThrow(/not a plain identifier/);
      expect(bad.statements.some((s) => s.includes('set_config'))).toBe(false);
      expect(bad.statements.at(-4)).toContain('pg_advisory_unlock');
      expect(bad.released).toBe(1);

      const empty = fakePool();
      await expect(
        applyMigrations(empty.pool, '/ignored', {
          readFiles,
          appRole: { user: 'ok', password: '' },
        }),
      ).rejects.toThrow(/password is empty/);
    });

    test('SHARE-03 a failed bootstrap rolls back, applies no file, names itself, and still unlocks', async () => {
      const db = fakePool({ failOn: 'DO $bootstrap$' });
      await expect(applyMigrations(db.pool, '/ignored', { readFiles, appRole })).rejects.toThrow(
        /app role bootstrap failed/,
      );
      expect(db.statements).toContain('ROLLBACK');
      expect(db.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([]);
      expect(db.statements.at(-4)).toContain('pg_advisory_unlock');
      expect(db.statements.slice(-3)).toEqual(SESSION_RESET_SQL);
      expect(db.released).toBe(1);
    });
  });

  test('LOAD-06 reads real files from a directory and sorts them by name', async () => {
    const db = fakePool();
    const result = await applyMigrations(
      db.pool,
      new URL('../migrations', import.meta.url).pathname,
    );
    expect(result.applied[0]).toBe('0000_init.sql');
    expect(result.applied).toEqual([...result.applied].sort());
    expect(db.statements.some((s) => s.includes('CREATE EXTENSION IF NOT EXISTS citext'))).toBe(
      true,
    );
  });
});
