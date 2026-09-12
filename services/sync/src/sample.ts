/**
 * The guided sample workscape (ONB-01): `Q3 Delivery — Guided sample`, seeded
 * once per account the first time the service sees it — whatever the first
 * request is, so a person who arrives through a shared link finds the sample
 * in their library too (ONB-02, PRD-DIGEST §24 resolutions).
 *
 * Same shape as `POST /api/documents`: the seeded Y.Doc from `@gede/core`
 * goes to S3 as snapshot seq 1, then the row, its `snapshots` row and the
 * audit row land in one transaction. The repository runs that transaction
 * under a per-owner advisory lock and calls back for the S3 put only when
 * the owner has no sample yet, so racing seeders — across tasks as well as
 * within this process, where requests are also coalesced per account —
 * write exactly one object and adopt one row. Nothing is orphaned.
 *
 * A seed that fails (S3 down, the insert refused) never fails the account's
 * request: `ensure` logs `guided sample seed failed` (the ops alarm counts
 * those lines), counts it in `stats`, and answers `sampleDocumentId: null`;
 * the resolver does not cache such an answer, so the next request retries.
 */
import { randomUUID } from 'node:crypto';

import { encodeSampleWorkscape, SAMPLE_TITLE } from '@gede/core';

import type { Config } from './config.js';
import type { SnapshotStore } from './deps.js';
import type { Logger } from './logger.js';
import type { ProjectionWorker } from './projection/worker.js';
import type { Repo, UserRecord } from './repo/types.js';
import { INITIAL_SNAPSHOT_SEQ } from './routes/api.js';
import { snapshotKey } from './s3.js';

export interface SampleSeederDeps {
  readonly repo: Pick<Repo, 'documents'>;
  readonly s3: Pick<SnapshotStore, 'put'>;
  readonly config: Pick<Config, 'DOCS_PREFIX'>;
  readonly projection: Pick<ProjectionWorker, 'schedule'>;
  readonly logger: Logger;
}

/** The log line a failed seed writes; `infra` turns it into `GeDe/Sync SampleSeedFailures`. */
export const SAMPLE_SEED_FAILED = 'guided sample seed failed';

export interface SampleSeederStats {
  /** Seeds this process wrote (object + row). */
  seeded: number;
  /** Requests that found another seeder's row (this process or another task) and adopted it. */
  adopted: number;
  /** Seeds that failed; the account went on without a sample and retries next request. */
  failures: number;
}

export class SampleSeeder {
  readonly stats: SampleSeederStats = { seeded: 0, adopted: 0, failures: 0 };
  /** In-flight seeds by user id, so parallel first requests in this process share one attempt. */
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly deps: SampleSeederDeps) {}

  /**
   * The user with `sampleDocumentId` set, seeding when the account has none.
   * Never throws: on failure the id stays null and the failure is logged.
   */
  async ensure(user: UserRecord): Promise<UserRecord> {
    if (user.sampleDocumentId !== null) return user;
    let inFlight = this.pending.get(user.id);
    if (inFlight === undefined) {
      inFlight = this.seed(user.id).finally(() => {
        this.pending.delete(user.id);
      });
      this.pending.set(user.id, inFlight);
    }
    try {
      return { ...user, sampleDocumentId: await inFlight };
    } catch (error) {
      this.stats.failures += 1;
      this.deps.logger.error({ err: error, userId: user.id }, SAMPLE_SEED_FAILED);
      return { ...user, sampleDocumentId: null };
    }
  }

  private async seed(ownerId: string): Promise<string> {
    const { repo, s3, config, projection, logger } = this.deps;
    const id = randomUUID();
    const bytes = encodeSampleWorkscape();
    const key = snapshotKey(config.DOCS_PREFIX, id, INITIAL_SNAPSHOT_SEQ);
    const outcome = await repo.documents.createSample({
      id,
      ownerId,
      title: SAMPLE_TITLE,
      snapshot: { seq: INITIAL_SNAPSHOT_SEQ, s3Key: key, sizeBytes: bytes.byteLength },
      // Called by the repository only when this seeder holds the owner's lock and no sample exists.
      writeSnapshot: () => s3.put(key, bytes),
    });
    if (!outcome.created) {
      this.stats.adopted += 1;
      return outcome.document.id;
    }
    this.stats.seeded += 1;
    projection.schedule(id, bytes);
    logger.info({ documentId: id, userId: ownerId }, 'guided sample seeded');
    return id;
  }
}
