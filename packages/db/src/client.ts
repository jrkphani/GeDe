/**
 * Connection factory. Reads the libpq-style `PG*` variables so the same code
 * runs against a local Postgres (`PGSSLMODE=disable`) and RDS in production
 * (`PGSSLMODE=verify-full` with the RDS global CA bundle).
 */
import { readFileSync } from 'node:fs';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

const { Pool } = pg;

export type Env = Record<string, string | undefined>;

export interface PoolOptions {
  /** Upper bound on open connections. One Fargate task at 0.5 vCPU needs few. */
  max?: number;
  /** Fail a `connect()` that takes longer than this (ms). */
  connectionTimeoutMillis?: number;
}

export type SslMode = 'disable' | 'require' | 'verify-full';

function sslMode(env: Env): SslMode {
  const raw = env.PGSSLMODE ?? 'disable';
  if (raw === 'disable' || raw === 'require' || raw === 'verify-full') return raw;
  throw new Error(`PGSSLMODE must be disable, require or verify-full, got ${JSON.stringify(raw)}`);
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

/** Translate `PG*` env into `pg.PoolConfig`. Exported for tests; `createPool` wraps it. */
export function poolConfigFromEnv(env: Env, options: PoolOptions = {}): pg.PoolConfig {
  const mode = sslMode(env);
  const config: pg.PoolConfig = {
    host: required(env, 'PGHOST'),
    port: Number(env.PGPORT ?? '5432'),
    user: required(env, 'PGUSER'),
    password: required(env, 'PGPASSWORD'),
    database: required(env, 'PGDATABASE'),
    max: options.max ?? 8,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
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
