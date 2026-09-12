/**
 * The logger contract the service depends on: pino's call shapes, so a pino
 * instance satisfies it directly and tests can pass `pino({ level: 'silent' })`.
 */
import type { FastifyBaseLogger } from 'fastify';

export type Logger = FastifyBaseLogger;
