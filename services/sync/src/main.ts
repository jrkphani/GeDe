/**
 * Process entry point. Boot order: config → pool → migrations (fail fast) →
 * server → listen. SIGTERM starts a graceful shutdown that must finish inside
 * the ECS stop timeout (30 s): stop accepting, flush rooms, close the pool.
 *
 * The same image runs the scheduled jobs (`node main.js --job purge`,
 * `node main.js --job reproject <docId|all>`): identical config, pool and
 * migrations, then the job, then exit — non-zero when the job reports a
 * failure, which EventBridge turns into an alert (infra/lib/stacks/ops-stack.ts).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { S3Client } from '@aws-sdk/client-s3';
import pino from 'pino';
import type pg from 'pg';

import { applyMigrations, createDb, createPool } from '@gede/db';

import { createCognitoVerifier } from './auth.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { parseInvocation, type Invocation } from './jobs/invocation.js';
import { purgeExpired } from './jobs/purge.js';
import { reproject } from './jobs/reproject.js';
import { REDACTED_PATHS, requestSerializer, type Logger } from './logger.js';
import { ProjectionWorker } from './projection/worker.js';
import { createPgRepo } from './repo/pg.js';
import type { Repo } from './repo/types.js';
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

interface Runtime {
  readonly config: Config;
  readonly logger: Logger;
  readonly version: string;
  readonly pool: pg.Pool;
  readonly repo: Repo;
  readonly s3: S3Client;
}

async function boot(role: string): Promise<Runtime> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = pino({
    level: config.LOG_LEVEL,
    base: { service: 'gede-sync', role },
    // Fastify adopts these: no access token from the deprecated `?token=` or a header reaches a log line.
    serializers: { req: requestSerializer },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  });
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

  const s3 = new S3Client({ region: config.COGNITO_REGION });
  return { config, logger, version, pool, repo: createPgRepo(createDb(pool), logger), s3 };
}

async function runServer(rt: Runtime): Promise<void> {
  const { config, logger } = rt;
  const app = await buildServer({
    config,
    logger,
    version: rt.version,
    verifier: createCognitoVerifier(config),
    db: rt.repo,
    s3: createS3SnapshotStore(rt.s3, config.DOCS_BUCKET),
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
        await app.close(); // stops accepting; onClose flushes rooms and the projection
        await rt.pool.end();
        rt.s3.destroy();
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

/** Run one job to completion and exit with its outcome; 1 when anything failed. */
async function runJob(
  rt: Runtime,
  invocation: Extract<Invocation, { kind: 'job' }>,
): Promise<number> {
  const { config, logger } = rt;
  const s3 = createS3SnapshotStore(rt.s3, config.DOCS_BUCKET);
  try {
    if (invocation.job === 'purge') {
      const result = await purgeExpired({
        repo: rt.repo,
        s3,
        docsPrefix: config.DOCS_PREFIX,
        logger,
      });
      if (result.orphanedPrefixes.length > 0) {
        logger.error({ prefixes: result.orphanedPrefixes }, 'purge left orphaned snapshot objects');
        return 1;
      }
      return 0;
    }
    const worker = new ProjectionWorker(rt.repo.projection, config, logger);
    const result = await reproject({ repo: rt.repo, s3, worker, logger }, invocation.target);
    return result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    logger.error({ err: error, job: invocation.job }, 'job failed');
    return 1;
  } finally {
    await rt.pool.end().catch(() => undefined);
    rt.s3.destroy();
  }
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.kind === 'server') {
    await runServer(await boot('server'));
    return;
  }
  const rt = await boot(invocation.job);
  const code = await runJob(rt, invocation);
  rt.logger.info({ job: invocation.job, exitCode: code }, 'job finished');
  process.exit(code);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
