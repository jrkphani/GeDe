import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyMigrations, listMigrationFiles, type MigrationSqlExecutor } from '../lib/migration-runner/applyMigrations';

// The REAL src/db/migrations directory — never a fixture/fork (issue 045
// scope: "reuse the existing SQL... do not fork a second migration path").
const REAL_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'db', 'migrations');

/**
 * A fake SQL executor good enough to exercise applyMigrations.ts's own
 * control flow (filename ordering + the __migrations idempotency ledger)
 * WITHOUT a live Postgres/Docker. It does not parse or validate the
 * migration SQL itself — that's already proven against real Postgres/PGlite
 * by deploy/migration-parity/check-migrations.sh and src/db/workspaceRls.test.ts
 * respectively. It only has to behave like Postgres for the three query
 * shapes applyMigrations.ts issues: create-ledger-if-missing, ledger lookup,
 * ledger insert — plus recording (not executing) each migration file's SQL,
 * so tests can assert exactly what was "applied" and in what order.
 */
function fakeExecutor(): MigrationSqlExecutor & { readonly executedSql: readonly string[] } {
  const appliedNames = new Set<string>();
  const executedSql: string[] = [];
  return {
    executedSql,
    async query(text: string, params?: readonly unknown[]) {
      if (text.includes('CREATE TABLE IF NOT EXISTS __migrations')) return { rows: [] };
      if (text.startsWith('SELECT name FROM __migrations')) {
        const name = params?.[0] as string;
        return { rows: appliedNames.has(name) ? [{ name }] : [] };
      }
      if (text.startsWith('INSERT INTO __migrations')) {
        appliedNames.add(params?.[0] as string);
        return { rows: [] };
      }
      executedSql.push(text);
      return { rows: [] };
    },
  };
}

describe('listMigrationFiles (issue 045)', () => {
  it('lists the real src/db/migrations/*.sql files, sorted in filename order (0000 first, 0012 last — issue 058 added 0012)', () => {
    const files = listMigrationFiles(REAL_MIGRATIONS_DIR);
    expect(files).toHaveLength(13); // 0000-0012
    expect(files[0]).toBe('0000_init.sql');
    expect(files.at(-1)).toBe('0012_electric_replica_identity.sql');
    expect(files).toEqual([...files].sort());
  });
});

describe('applyMigrations (issue 045 test-first plan item 1 — idempotency + ordering)', () => {
  it('applies every real migration file, in filename order, on a fresh (empty-ledger) database', async () => {
    const executor = fakeExecutor();
    const expectedOrder = listMigrationFiles(REAL_MIGRATIONS_DIR);

    const result = await applyMigrations(executor, REAL_MIGRATIONS_DIR);

    expect(result.applied).toEqual(expectedOrder);
    expect(result.skipped).toEqual([]);
    // One "migration file's SQL" executed per applied file (this fake
    // records every non-ledger query verbatim).
    expect(executor.executedSql).toHaveLength(expectedOrder.length);
  });

  it('a second run against an already-migrated ledger is a no-op — no error, no duplicate DDL', async () => {
    const executor = fakeExecutor();
    await applyMigrations(executor, REAL_MIGRATIONS_DIR);
    const executedAfterFirstRun = executor.executedSql.length;

    const second = await applyMigrations(executor, REAL_MIGRATIONS_DIR);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(listMigrationFiles(REAL_MIGRATIONS_DIR));
    // No migration file's SQL was re-executed — genuinely a no-op, not just
    // a "no error" facade.
    expect(executor.executedSql).toHaveLength(executedAfterFirstRun);
  });

  it('a partially-migrated ledger (e.g. mid-rollout) applies only the remaining files, still in order', async () => {
    const executor = fakeExecutor();
    const allFiles = listMigrationFiles(REAL_MIGRATIONS_DIR);
    const halfway = Math.floor(allFiles.length / 2);

    // Simulate "already applied 0000..<halfway>" by seeding the ledger
    // directly through the executor's own INSERT path (never hand-rolled
    // ledger state — exercises the exact same code path a real prior run
    // would have taken).
    await executor.query(`CREATE TABLE IF NOT EXISTS __migrations (name text PRIMARY KEY, applied_at timestamptz)`);
    for (const name of allFiles.slice(0, halfway)) {
      await executor.query('INSERT INTO __migrations (name) VALUES ($1)', [name]);
    }

    const result = await applyMigrations(executor, REAL_MIGRATIONS_DIR);

    expect(result.skipped).toEqual(allFiles.slice(0, halfway));
    expect(result.applied).toEqual(allFiles.slice(halfway));
  });

  it('parity guard: the runner reads the SAME migrations directory check-migrations.sh globs — no forked SQL (test-first plan item 3)', () => {
    const files = listMigrationFiles(REAL_MIGRATIONS_DIR);
    expect(files).toHaveLength(13); // 0000-0012 (issue 058 added 0012)

    const parityScript = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'migration-parity', 'check-migrations.sh'),
      'utf-8',
    );
    // check-migrations.sh sets MIGRATIONS_DIR="${REPO_ROOT}/src/db/migrations"
    // — the exact directory this test (and migration-stack.ts's bundling
    // hook) resolves to via `path.resolve(__dirname, '..', '..', '..', 'src', 'db', 'migrations')`.
    expect(parityScript).toContain('MIGRATIONS_DIR="${REPO_ROOT}/src/db/migrations"');
    expect(fs.existsSync(REAL_MIGRATIONS_DIR)).toBe(true);
  });
});
