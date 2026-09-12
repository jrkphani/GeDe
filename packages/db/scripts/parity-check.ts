/**
 * Runs inside `parity.sh` against a live throwaway Postgres (PG* env set).
 * 1. Applies migrations; applies them again and requires a no-op.
 * 2. Compares every table and column in `src/schema.ts` with information_schema.
 * 3. Checks the constraints later migrations change (0003: no foreign key on
 *    `audit_log.document_id`, so a purge's audit row outlives the document).
 * 4. Requires every index `schema.ts` declares to exist (0004) and the ledger
 *    to carry a checksum for every applied file (0005).
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

import { applyMigrations, createPool } from '../src/index.js';
import * as schema from '../src/schema.js';

const tables: PgTable[] = [
  schema.users,
  schema.documents,
  schema.shares,
  schema.invites,
  schema.docUpdates,
  schema.snapshots,
  schema.sheets,
  schema.tables,
  schema.columns,
  schema.rows,
  schema.cells,
  schema.graphs,
  schema.auditLog,
];

const log = {
  info: (m: string, meta?: Record<string, unknown>) => {
    console.error(`[parity] ${m}`, meta ?? '');
  },
  warn: (m: string) => {
    console.error(`[parity] ${m}`);
  },
  error: (m: string) => {
    console.error(`[parity] ${m}`);
  },
};

const pool = createPool(process.env);
const dir = new URL('../migrations', import.meta.url).pathname;
try {
  const first = await applyMigrations(pool, dir, { logger: log });
  const second = await applyMigrations(pool, dir, { logger: log });
  if (second.applied.length !== 0) {
    throw new Error(
      `migrations are not idempotent; second run applied ${second.applied.join(', ')}`,
    );
  }
  log.info(`applied ${String(first.applied.length)} files; second run applied 0`);

  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const live = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = live.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    live.set(row.table_name, set);
  }

  const problems: string[] = [];
  for (const table of tables) {
    const name = getTableName(table);
    const liveColumns = live.get(name);
    if (!liveColumns) {
      problems.push(`table ${name} missing`);
      continue;
    }
    for (const column of Object.values(getTableColumns(table))) {
      if (!liveColumns.has(column.name)) problems.push(`column ${name}.${column.name} missing`);
    }
    const declared = new Set(Object.values(getTableColumns(table)).map((c) => c.name));
    for (const c of liveColumns) {
      if (!declared.has(c))
        problems.push(`column ${name}.${c} exists in the database but not in schema.ts`);
    }
  }
  const { rows: fks } = await pool.query<{ conname: string }>(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'audit_log'::regclass AND contype = 'f'",
  );
  if (fks.some((c) => c.conname === 'audit_log_document_id_fkey')) {
    problems.push('audit_log.document_id still has its foreign key (migration 0003 did not apply)');
  }
  const { rows: indexes } = await pool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  const liveIndexes = new Set(indexes.map((i) => i.indexname));
  for (const table of tables) {
    for (const idx of getTableConfig(table).indexes) {
      const name = idx.config.name;
      if (name !== undefined && !liveIndexes.has(name)) {
        problems.push(`index ${name} on ${getTableName(table)} missing (migration 0004)`);
      }
    }
  }
  const { rows: ledger } = await pool.query<{ name: string; checksum: string | null }>(
    'SELECT name, checksum FROM __migrations',
  );
  for (const row of ledger) {
    if (row.checksum === null) problems.push(`__migrations.${row.name} has no checksum (0005)`);
  }
  if (problems.length > 0) {
    throw new Error(`schema parity failed:\n  ${problems.join('\n  ')}`);
  }
  log.info(`schema parity ok across ${String(tables.length)} tables`);
} finally {
  await pool.end();
}
