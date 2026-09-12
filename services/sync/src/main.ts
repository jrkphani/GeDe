/**
 * Process entry point. Boot order: config → pool → migrations (fail fast) →
 * server → listen. SIGTERM starts a graceful shutdown that must finish inside
 * the ECS stop timeout (30 s): stop accepting, flush rooms, close the pool.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { S3Client } from '@aws-sdk/client-s3';
import pino from 'pino';

import { applyMigrations, createDb, createPool } from '@gede/db';

import { createCognitoVerifier } from './auth.js';
import { ConfigError, loadConfig } from './config.js';
import { createPgRepo } from './repo/pg.js';
import { createS3SnapshotStore } from './s3.js';
import { buildServer } from './server.js';

declare const __GEDE_BUILD_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof process.env.GEDE_VERSION === 'string' && process.env.GEDE_VERSION !== '') {
    return process.env.GEDE_VERSION;
  }
  // Substituted by scripts/bundle.mjs; undefined when running from source with tsx.
  return typeof __GEDE_BUILD_VERSION__ === 'string' ? __GEDE_BUILD_VERSION__ : 'dev';
}

/** In the bundle the SQL files sit next to main.js; from source they are in packages/db. */
function resolveMigrationsDir(): string {
  const candidates = [
    new URL('./migrations/', import.meta.url),
    new URL('../../../packages/db/migrations/', import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  throw new Error('migrations directory not found next to the bundle or in packages/db');
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = pino({ level: config.LOG_LEVEL, base: { service: 'gede-sync' } });
  const version = resolveVersion();
  logger.info({ version, node: process.version }, 'starting');

  const pool = createPool(process.env);
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle pool client error');
  });

  try {
    const result = await applyMigrations(pool, resolveMigrationsDir(), {
      logger: {
        info: (m, meta) => {
          logger.info(meta ?? {}, m);
        },
        warn: (m, meta) => {
          logger.warn(meta ?? {}, m);
        },
        error: (m, meta) => {
          logger.error(meta ?? {}, m);
        },
      },
    });
    logger.info(result, 'migrations applied');
  } catch (error) {
    logger.fatal({ err: error }, 'migrations failed; exiting');
    await pool.end().catch(() => undefined);
    process.exit(1);
  }

  const db = createDb(pool);
  const s3 = new S3Client({ region: config.COGNITO_REGION });
  const app = await buildServer({
    config,
    logger,
    version,
    verifier: createCognitoVerifier(config),
    db: createPgRepo(db, logger),
    s3: createS3SnapshotStore(s3, config.DOCS_BUCKET),
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    void (async () => {
      try {
        await app.close(); // stops accepting; onClose flushes rooms
        await pool.end();
        s3.destroy();
        logger.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: '0.0.0.0', port: config.PORT });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
