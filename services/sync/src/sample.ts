/**
 * The guided sample workscape (ONB-01): `Q3 Delivery — Guided sample`, seeded
 * once per account the first time the service sees it — whatever the first
 * request is, so a person who arrives through a shared link finds the sample
 * in their library too (ONB-02, PRD-DIGEST §24 resolutions).
 *
 * Same shape as `POST /api/documents`: the seeded Y.Doc from `@gede/core`
 * goes to S3 as snapshot seq 1 first (a row must never point at a missing
 * object), then the row, its `snapshots` row and the audit row land in one
 * transaction. The row is `sample = true` and at most one per owner
 * (`documents_owner_sample_key`, migration 0009); when two first-sight
 * requests race, the loser's insert writes nothing, it adopts the winner's
 * row and logs the orphaned object with its key, as the create route does.
 * Requests in one process are additionally coalesced per account.
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

export class SampleSeeder {
  /** In-flight seeds by user id, so parallel first requests share one insert. */
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly deps: SampleSeederDeps) {}

  /** The user with `sampleDocumentId` set, seeding the sample when the account has none. */
  async ensure(user: UserRecord): Promise<UserRecord> {
    if (user.sampleDocumentId !== null) return user;
    let inFlight = this.pending.get(user.id);
    if (inFlight === undefined) {
      inFlight = this.seed(user.id).finally(() => {
        this.pending.delete(user.id);
      });
      this.pending.set(user.id, inFlight);
    }
    return { ...user, sampleDocumentId: await inFlight };
  }

  private async seed(ownerId: string): Promise<string> {
    const { repo, s3, config, projection, logger } = this.deps;
    const id = randomUUID();
    const bytes = encodeSampleWorkscape();
    const key = snapshotKey(config.DOCS_PREFIX, id, INITIAL_SNAPSHOT_SEQ);
    await s3.put(key, bytes);
    let outcome;
    try {
      outcome = await repo.documents.createSample({
        id,
        ownerId,
        title: SAMPLE_TITLE,
        snapshot: { seq: INITIAL_SNAPSHOT_SEQ, s3Key: key, sizeBytes: bytes.byteLength },
      });
    } catch (error) {
      logger.error(
        { err: error, documentId: id, key, userId: ownerId },
        'sample insert failed after its seed snapshot was written; the object is orphaned',
      );
      throw error;
    }
    if (!outcome.created) {
      logger.warn(
        { documentId: outcome.document.id, orphanKey: key, userId: ownerId },
        'sample already seeded by a concurrent request; the object is orphaned',
      );
      return outcome.document.id;
    }
    projection.schedule(id, bytes);
    logger.info({ documentId: id, userId: ownerId }, 'guided sample seeded');
    return id;
  }
}
