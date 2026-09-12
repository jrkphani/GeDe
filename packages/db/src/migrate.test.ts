import { describe, expect, test } from 'vitest';

import {
  applyMigrations,
  LOCK_TIMEOUT_MS,
  migrationChecksum,
  MigrationError,
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
  let released = 0;
  let inTransaction = false;

  const client: MigrationClient = {
    query(text, values) {
      statements.push(text);
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
    expect(db.statements.at(-1)).toContain('pg_advisory_unlock');
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
    expect(db.statements.at(-1)).toContain('pg_advisory_unlock');
    expect(db.released).toBe(1);
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
    expect(db.statements.filter((s) => s === 'CREATE TABLE c ()')).toEqual([]);
    expect(db.released).toBe(2);
    expect(logs).toContain('info applying migration');
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
