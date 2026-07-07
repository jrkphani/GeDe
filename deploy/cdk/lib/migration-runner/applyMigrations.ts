import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The pure, testable core of the migration runner (issue 045, ADR-0008 "one
 * dialect, no migration cliff"). Mirrors `src/db/migrate.ts`'s PGlite runner
 * (same `__migrations` ledger table, same filename-order application) and
 * `deploy/migration-parity/check-migrations.sh`'s CI proof — this file reads
 * and executes the IDENTICAL `src/db/migrations/*.sql` files those two paths
 * already apply. It never forks the SQL; `migrationsDir` always points at a
 * copy of that exact directory (see `migration-stack.ts`'s bundling command
 * hook, which copies it verbatim alongside the deployed Lambda).
 *
 * Dependency-injected over a minimal `MigrationSqlExecutor` (a `.query`
 * method) so this logic is unit-testable without a live Postgres/Docker —
 * mirrors `src/server/writeApi/handler.ts` vs `albAdapter.ts`'s "thin AWS
 * adapter, pure core" split (ADR-0010). `handler.ts` in this directory is the
 * AWS-specific adapter that wires a real `pg.Client` (via Secrets Manager
 * credentials) and calls this.
 */
export interface MigrationSqlExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

export interface ApplyMigrationsResult {
  /** Filenames applied THIS run, in the order they were applied. */
  readonly applied: readonly string[];
  /** Filenames already present in the `__migrations` ledger — skipped, not re-applied. */
  readonly skipped: readonly string[];
}

/**
 * Lists the migration `.sql` filenames in `migrationsDir`, sorted in the
 * exact filename order `src/db/migrate.ts` and `check-migrations.sh` apply
 * them in (drizzle-kit's numeric prefixes: `0000_`, `0001_`, ... sort
 * lexicographically the same as numerically at this width).
 */
export function listMigrationFiles(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Applies every migration file in `migrationsDir` (filename order) against
 * `executor`, tracking applied filenames in a `__migrations` ledger table —
 * identical shape/semantics to `src/db/migrate.ts`'s PGlite runner. Idempotent
 * (issue 045 test-first plan item 1): a file already recorded in
 * `__migrations` is skipped, never re-applied, and re-running this function
 * against an already-migrated database is a safe no-op (no error, no
 * duplicate DDL).
 */
export async function applyMigrations(
  executor: MigrationSqlExecutor,
  migrationsDir: string,
): Promise<ApplyMigrationsResult> {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS __migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of listMigrationFiles(migrationsDir)) {
    const seen = await executor.query('SELECT name FROM __migrations WHERE name = $1', [name]);
    if (seen.rows.length > 0) {
      skipped.push(name);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf-8');
    await executor.query(sql);
    await executor.query('INSERT INTO __migrations (name) VALUES ($1)', [name]);
    applied.push(name);
  }

  return { applied, skipped };
}
