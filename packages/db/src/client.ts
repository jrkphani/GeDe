/**
 * Connection factory. Reads the libpq-style `PG*` variables so the same code
 * runs against a local Postgres (`PGSSLMODE=disable`) and RDS in production
 * (`PGSSLMODE=verify-full` with the RDS global CA bundle).
 */
import { readFileSync } from 'node:fs';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import type { AppRole } from './migrate.js';
import * as schema from './schema.js';

const { Pool } = pg;

export type Env = Record<string, string | undefined>;

export interface PoolOptions {
  /** Upper bound on open connections. One Fargate task at 0.5 vCPU needs few. */
  max?: number;
  /** Fail a `connect()` that takes longer than this (ms). */
  connectionTimeoutMillis?: number;
  /**
   * Connect as this role instead of `PGUSER`/`PGPASSWORD` (#36): the runtime
   * pool uses the least-privilege role the migration runner bootstrapped;
   * the runner's own pool keeps the master credentials.
   */
  as?: AppRole;
}

export type SslMode = 'disable' | 'require' | 'verify-full';

function sslMode(env: Env): SslMode {
  const raw = env.PGSSLMODE ?? 'disable';
  if (raw !== 'disable' && raw !== 'require' && raw !== 'verify-full') {
    throw new Error(
      `PGSSLMODE must be disable, require or verify-full, got ${JSON.stringify(raw)}`,
    );
  }
  // Production talks to RDS over the public-subnet path with a verified CA, or
  // not at all (#42): `require` skips certificate validation and `disable`
  // is plaintext — both are for a local database only.
  if (env.NODE_ENV === 'production' && raw !== 'verify-full') {
    throw new Error(`PGSSLMODE must be verify-full when NODE_ENV=production, got ${raw}`);
  }
  return raw;
}

/**
 * Session limits applied to every pooled connection (#42): a runaway
 * statement, a lock wait or a transaction left open by a crashed request
 * cannot hold one of the few connections a `db.t4g.micro` allows for long.
 * The migration runner sets its own, longer limits on its session.
 */
export const POOL_TIMEOUTS = {
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
  idleInTransactionSessionTimeoutMs: 30_000,
} as const;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

/**
 * The least-privilege runtime role from `PGAPPUSER`/`PGAPPPASSWORD` (#36),
 * injected by ECS from the `gede/<env>/db-app` secret. `undefined` when
 * neither is set: a local database, where the runtime is the master user.
 * Production never falls back to the master user: a task whose secret
 * injection failed must refuse to boot, not run with `rds_superuser`.
 */
export function appRoleFromEnv(env: Env): AppRole | undefined {
  const user = env.PGAPPUSER;
  const password = env.PGAPPPASSWORD;
  const hasUser = user !== undefined && user !== '';
  const hasPassword = password !== undefined && password !== '';
  if (hasUser && hasPassword) return { user, password };
  if (hasUser || hasPassword) {
    throw new Error('PGAPPUSER and PGAPPPASSWORD must be set together');
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'PGAPPUSER and PGAPPPASSWORD are required when NODE_ENV=production; the runtime never connects as the master user',
    );
  }
  return undefined;
}

/** Translate `PG*` env into `pg.PoolConfig`. Exported for tests; `createPool` wraps it. */
export function poolConfigFromEnv(env: Env, options: PoolOptions = {}): pg.PoolConfig {
  const mode = sslMode(env);
  const config: pg.PoolConfig = {
    host: required(env, 'PGHOST'),
    port: Number(env.PGPORT ?? '5432'),
    user: options.as?.user ?? required(env, 'PGUSER'),
    password: options.as?.password ?? required(env, 'PGPASSWORD'),
    database: required(env, 'PGDATABASE'),
    max: options.max ?? 8,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    statement_timeout: POOL_TIMEOUTS.statementTimeoutMs,
    lock_timeout: POOL_TIMEOUTS.lockTimeoutMs,
    idle_in_transaction_session_timeout: POOL_TIMEOUTS.idleInTransactionSessionTimeoutMs,
  };
  if (!Number.isInteger(config.port) || (config.port ?? 0) <= 0) {
    throw new Error(`PGPORT must be a port number, got ${JSON.stringify(env.PGPORT)}`);
  }
  if (mode === 'verify-full') {
    const caPath = required(env, 'PGSSLROOTCERT');
    config.ssl = { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  } else if (mode === 'require') {
    // Encrypted but not authenticated. Acceptable only for a throwaway instance.
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

export function createPool(env: Env = process.env, options: PoolOptions = {}): pg.Pool {
  return new Pool(poolConfigFromEnv(env, options));
}

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
