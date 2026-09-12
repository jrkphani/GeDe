/**
 * Nightly purge (LIB-08): documents whose soft-deletion is older than the
 * 30-day Recently Deleted window are deleted for good — rows in one
 * transaction per batch (`Repo.documents.purgeExpired`, a `document.purge`
 * audit row each with the system actor), then their S3 objects.
 *
 * Run as `node main.js --job purge` by an EventBridge Scheduler task
 * (`infra/lib/stacks/ops-stack.ts`); the same code is callable from tests.
 * Any S3 failure is reported in the result and makes the job exit non-zero
 * (the rows are already gone, so the operator has to remove the objects by
 * hand — the log names each prefix).
 */
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import type { Repo } from '../repo/types.js';
import { documentPrefix } from '../s3.js';

/** Documents per transaction; bounds the lock and the S3 fan-out. */
export const PURGE_BATCH_SIZE = 100;

export interface PurgeResult {
  /** Documents whose rows were deleted. */
  readonly purged: number;
  /** S3 objects removed. */
  readonly objectsDeleted: number;
  /** Prefixes whose objects could not be removed (rows are gone; see the log). */
  readonly orphanedPrefixes: readonly string[];
}

export interface PurgeDeps {
  readonly repo: Repo;
  readonly s3: SnapshotStore;
  readonly docsPrefix: string;
  readonly logger: Logger;
  readonly batchSize?: number | undefined;
}

export async function purgeExpired(deps: PurgeDeps): Promise<PurgeResult> {
  const batchSize = deps.batchSize ?? PURGE_BATCH_SIZE;
  let purged = 0;
  let objectsDeleted = 0;
  const orphanedPrefixes: string[] = [];
  for (;;) {
    const batch = await deps.repo.documents.purgeExpired(batchSize);
    if (batch.length === 0) break;
    purged += batch.length;
    for (const doc of batch) {
      const prefix = documentPrefix(deps.docsPrefix, doc.id);
      try {
        const removed = await deps.s3.deletePrefix(prefix);
        objectsDeleted += removed;
        deps.logger.info({ documentId: doc.id, objects: removed }, 'expired document purged');
      } catch (error) {
        orphanedPrefixes.push(prefix);
        deps.logger.error(
          { err: error, documentId: doc.id, prefix },
          'snapshot objects not purged; the database rows are gone',
        );
      }
    }
    if (batch.length < batchSize) break;
  }
  deps.logger.info(
    { purged, objectsDeleted, orphaned: orphanedPrefixes.length },
    orphanedPrefixes.length === 0 ? 'purge complete' : 'purge complete with orphaned objects',
  );
  return { purged, objectsDeleted, orphanedPrefixes };
}
