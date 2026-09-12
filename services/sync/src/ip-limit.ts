/**
 * Coarse per-address limit (#37, review of #66): an `onRequest` hook on every
 * route — REST, the WebSocket upgrade and anything unauthenticated — keyed by
 * `request.ip` as the ALB reports it. On the direct `/ws` path that is the
 * real client; on the CloudFront `/api` path it is the edge, so this bucket
 * is deliberately generous there and the per-user limit (`server.ts`,
 * `preHandler` on `/api`, keyed by the verified user) is the precise one.
 * The point of this bucket is what the per-user limit cannot see: callers
 * with no or an invalid token, and token-rotating callers.
 *
 * In-memory, per task: fine while one task serves everything (growth step 1
 * moves this behind Redis with the rooms' fan-out).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from './errors.js';
import { TokenBucket } from './ws/throttle.js';

/** Addresses tracked at once; the least recently seen is evicted beyond this. */
const MAX_TRACKED_ADDRESSES = 10_000;

export class AddressLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Take one token for `address`; false when it is over its budget. */
  take(address: string): boolean {
    let bucket = this.buckets.get(address);
    if (bucket) {
      // Refresh recency: Map iteration order is insertion order.
      this.buckets.delete(address);
    } else {
      bucket = new TokenBucket(this.perMinute / 60, this.perMinute, this.now);
      if (this.buckets.size >= MAX_TRACKED_ADDRESSES) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    this.buckets.set(address, bucket);
    return bucket.take();
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Routes never limited: the ALB's and the 503 page's health probes. */
export function isHealthRoute(request: Pick<FastifyRequest, 'url'>): boolean {
  return request.url === '/healthz' || request.url === '/api/health';
}

export function registerAddressLimit(app: FastifyInstance, limiter: AddressLimiter): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (!isHealthRoute(request) && !limiter.take(request.ip)) {
      done(new AppError(429, 'too_many_requests', 'Too many requests from this address'));
      return;
    }
    done();
  });
}
