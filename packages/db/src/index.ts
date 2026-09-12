/**
 * @gede/db — Drizzle schema, `pg` connection factory and the migration runner.
 * The schema is the typed mirror of `migrations/*.sql`; the SQL is what runs.
 */
export * as schema from './schema.js';
export * from './schema.js';
export {
  createDb,
  createPool,
  poolConfigFromEnv,
  type Db,
  type Env,
  type PoolOptions,
  type SslMode,
} from './client.js';
export {
  applyMigrations,
  MigrationError,
  type MigrationClient,
  type MigrationLogger,
  type MigrationOptions,
  type MigrationPool,
  type MigrationResult,
} from './migrate.js';
