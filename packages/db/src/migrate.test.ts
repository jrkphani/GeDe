import { describe, expect, test } from 'vitest';

import {
  applyMigrations,
  MigrationError,
  type MigrationClient,
  type MigrationPool,
} from './migrate.js';

/**
 * A labelled fake of the `pg` pool surface the runner uses. It records every
 * statement and simulates the `__migrations` ledger; it is not a database.
 */
function fakePool(options: { ledger?: string[]; failOn?: string } = {}) {
  const ledger = new Set(options.ledger ?? []);
  const statements: string[] = [];
  let released = 0;
  let inTransaction = false;

  const client: MigrationClient = {
    query(text, values) {
      statements.push(text);
      if (text === 'BEGIN') inTransaction = true;
      if (text === 'COMMIT' || text === 'ROLLBACK') inTransaction = false;
      if (text === 'SELECT name FROM __migrations') {
        return Promise.resolve({ rows: [...ledger].map((name) => ({ name })) });
      }
      if (text.startsWith('INSERT INTO __migrations')) {
        ledger.add(String(values?.[0]));
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
    expect(db.statements[0]).toContain('pg_advisory_lock');
    expect(db.statements[1]).toContain('CREATE TABLE IF NOT EXISTS __migrations');
    expect(db.statements.at(-1)).toContain('pg_advisory_unlock');
    expect(db.released).toBe(1);
    expect(db.inTransaction).toBe(false);

    const perFile = db.statements.slice(3, 8);
    expect(perFile).toEqual([
      'BEGIN',
      'CREATE TABLE a ()',
      'INSERT INTO __migrations (name) VALUES ($1)',
      'COMMIT',
      'BEGIN',
    ]);
    expect([...db.ledger]).toEqual(['0000_init.sql', '0001_second.sql', '0002_third.sql']);
  });

  test('LOAD-06 skips files already in the ledger and reports the count', async () => {
    const db = fakePool({ ledger: ['0000_init.sql', '0001_second.sql'] });
    const result = await applyMigrations(db.pool, '/ignored', { readFiles });
    expect(result).toEqual({ applied: ['0002_third.sql'], skipped: 2 });
    expect(db.statements.filter((s) => /^CREATE TABLE [abc] /.test(s))).toEqual([
      'CREATE TABLE c ()',
    ]);
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

    expect([...db.ledger]).toEqual(['0000_init.sql']);
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
