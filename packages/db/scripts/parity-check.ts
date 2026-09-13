/**
 * Runs inside `parity.sh` against a live throwaway Postgres (PG* env set).
 * 1. Applies migrations; applies them again and requires a no-op.
 * 2. Compares every table and column in `src/schema.ts` with information_schema.
 * 3. Checks the constraints later migrations change (0003: no foreign key on
 *    `audit_log.document_id`, so a purge's audit row outlives the document;
 *    0008 and 0010: every CHECK `schema.ts` declares exists under its name).
 * 4. Requires every index `schema.ts` declares to exist (0004) and the ledger
 *    to carry a checksum for every applied file (0005).
 * 5. Bootstraps the app role from `PGAPPUSER`/`PGAPPPASSWORD` on both runs — as
 *    a non-superuser CREATEROLE database owner, what the RDS master is — and,
 *    connected as that role, requires DML on every schema table, read-only on
 *    the ledger, no TRUNCATE, no CREATE on the schema, no DDL, and none of the
 *    superuser-class attributes (#36).
 */
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

import { applyMigrations, appRoleFromEnv, createPool } from '../src/index.js';
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
  schema.mailEvents,
  schema.mailSuppressions,
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
const appRole = appRoleFromEnv(process.env);
if (appRole === undefined)
  throw new Error('parity needs PGAPPUSER and PGAPPPASSWORD (parity.sh sets them)');
const dir = new URL('../migrations', import.meta.url).pathname;
try {
  // The bootstrap must be proven from the privileges production has: the RDS master
  // is CREATEROLE and the database owner, not a superuser. A superuser here would
  // pass statements RDS refuses (parity.sh creates the equivalent role).
  const { rows: runner } = await pool.query<{
    rolsuper: boolean;
    rolcreaterole: boolean;
    owner: boolean;
  }>(
    `SELECT r.rolsuper, r.rolcreaterole, d.datdba = r.oid AS owner
       FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
      WHERE r.rolname = current_user`,
  );
  const who = runner[0];
  if (who === undefined || who.rolsuper || !who.rolcreaterole || !who.owner) {
    throw new Error(
      `parity must run as a non-superuser CREATEROLE role that owns the database, like the RDS master; got ${JSON.stringify(who)}`,
    );
  }

  const first = await applyMigrations(pool, dir, { logger: log, appRole });
  const second = await applyMigrations(pool, dir, { logger: log, appRole });
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
  const { rows: checks } = await pool.query<{ conname: string; conrelid: string }>(
    "SELECT conname, conrelid::regclass::text AS conrelid FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace",
  );
  const liveChecks = new Set(checks.map((c) => `${c.conrelid}.${c.conname}`));
  for (const table of tables) {
    for (const check of getTableConfig(table).checks) {
      if (!liveChecks.has(`${getTableName(table)}.${check.name}`)) {
        problems.push(
          `check ${check.name} on ${getTableName(table)} missing (migration 0008/0010/0011/0012)`,
        );
      }
    }
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

  const roleProblems = await checkAppRole(appRole);
  if (roleProblems.length > 0) {
    throw new Error(`app role parity failed:\n  ${roleProblems.join('\n  ')}`);
  }
  log.info(`app role ${appRole.user} is DML-only across ${String(tables.length)} tables`);
} finally {
  await pool.end();
}

/** Connected as the app role: what it may do, and everything it must not. */
async function checkAppRole(role: { user: string; password: string }): Promise<string[]> {
  const problems: string[] = [];
  const app = createPool(process.env, { as: role, max: 1 });
  try {
    const { rows: attrs } = await app.query<Record<string, boolean>>(
      'SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const attr = attrs[0];
    if (attr === undefined) {
      return ['pg_roles has no row for the connected app role'];
    }
    for (const [name, want] of Object.entries({
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    })) {
      if (attr[name] !== want)
        problems.push(`app role ${name} is ${String(attr[name])}, want ${String(want)}`);
    }

    const { rows: privileges } = await app.query<{
      name: string;
      s: boolean;
      i: boolean;
      u: boolean;
      d: boolean;
      t: boolean;
    }>(
      `SELECT c.relname AS name,
              has_table_privilege(c.oid, 'SELECT') AS s, has_table_privilege(c.oid, 'INSERT') AS i,
              has_table_privilege(c.oid, 'UPDATE') AS u, has_table_privilege(c.oid, 'DELETE') AS d,
              has_table_privilege(c.oid, 'TRUNCATE') AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const byName = new Map(privileges.map((p) => [p.name, p]));
    for (const table of tables) {
      const name = getTableName(table);
      const p = byName.get(name);
      if (p === undefined) {
        problems.push(`app role cannot see table ${name}`);
        continue;
      }
      if (!(p.s && p.i && p.u && p.d)) problems.push(`app role lacks DML on ${name}`);
      if (p.t) problems.push(`app role may TRUNCATE ${name}`);
    }
    const ledger = byName.get('__migrations');
    if (ledger === undefined || !ledger.s || ledger.i || ledger.u || ledger.d || ledger.t) {
      problems.push('app role must have SELECT and nothing else on __migrations');
    }

    const { rows: schemaRows } = await app.query<{ create: boolean; usage: boolean }>(
      "SELECT has_schema_privilege('public', 'CREATE') AS create, has_schema_privilege('public', 'USAGE') AS usage",
    );
    if (schemaRows[0]?.create !== false) problems.push('app role has CREATE on schema public');
    if (schemaRows[0]?.usage !== true) problems.push('app role lacks USAGE on schema public');

    // Sequences back the serial ids an insert touches; nothing else about them.
    const { rows: seqs } = await app.query<{ name: string; usage: boolean; update: boolean }>(
      `SELECT c.relname AS name, has_sequence_privilege(c.oid, 'USAGE') AS usage,
              has_sequence_privilege(c.oid, 'UPDATE') AS update
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'`,
    );
    for (const seq of seqs) {
      if (!seq.usage) problems.push(`app role lacks USAGE on sequence ${seq.name}`);
    }

    // DDL and destructive statements must be refused, not merely unused.
    for (const statement of [
      'CREATE TABLE parity_probe (id int)',
      'ALTER TABLE users ADD COLUMN parity_probe int',
      'TRUNCATE audit_log',
      "INSERT INTO __migrations (name) VALUES ('parity_probe')",
      'CREATE EXTENSION IF NOT EXISTS hstore',
      'CREATE ROLE parity_probe',
    ]) {
      const outcome = await app.query(statement).then(
        () => 'succeeded',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      if (outcome === 'succeeded') problems.push(`app role was allowed: ${statement}`);
    }

    // What the runtime actually does (services/sync/src/repo/pg.ts) must work.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO users (cognito_sub) VALUES ('parity_probe')");
      await client.query('SELECT id FROM users WHERE cognito_sub = $1 FOR UPDATE SKIP LOCKED', [
        'parity_probe',
      ]);
      await client.query(
        "SELECT count(*) FROM cells WHERE to_tsvector('simple', text_plain) @@ plainto_tsquery('simple', 'probe')",
      );
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      problems.push(
        `runtime DML failed as the app role: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.release();
    }
  } finally {
    await app.end();
  }
  return problems;
}
