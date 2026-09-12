/**
 * Nightly purge (LIB-08): documents whose soft-deletion is older than the
 * 30-day Recently Deleted window are deleted for good. Per batch, the rows
 * are claimed in a transaction, each document's S3 objects are removed while
 * the claim is held, and only the documents whose objects are gone lose their
 * rows when the transaction commits (a `document.purge` audit row each, with
 * the system actor). A document whose objects could not be removed keeps its
 * rows and is retried on the next run — an S3 failure never leaves an
 * orphaned object behind a deleted row (review finding 3). Retry-safe: a
 * second run finds no rows for what went and touches nothing.
 *
 * Run as `node main.js --job purge` by an EventBridge Scheduler task
 * (`infra/lib/stacks/ops-stack.ts`); the same code is callable from tests.
 * Any failure is reported in the result and makes the job exit non-zero.
 */
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import type { Repo } from '../repo/types.js';
import { documentPrefix } from '../s3.js';

/**
 * Documents per transaction. The claim is held while their objects are removed
 * (one `ListObjectsV2` + one `DeleteObjects` each), so the batch bounds how long
 * the transaction stays open as well as the lock footprint.
 */
export const PURGE_BATCH_SIZE = 50;

export interface PurgeResult {
  /** Documents whose objects and rows were deleted. */
  readonly purged: number;
  /** S3 objects removed. */
  readonly objectsDeleted: number;
  /** Documents left in place because their objects could not be removed (retried next run). */
  readonly failed: readonly string[];
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
  const failed: string[] = [];
  for (;;) {
    const batch = await deps.repo.documents.purgeExpired({
      limit: batchSize,
      exclude: failed,
      removeObjects: async (doc) => {
        const prefix = documentPrefix(deps.docsPrefix, doc.id);
        try {
          const removed = await deps.s3.deletePrefix(prefix);
          objectsDeleted += removed;
          deps.logger.info({ documentId: doc.id, objects: removed }, 'expired document purged');
          return true;
        } catch (error) {
          deps.logger.error(
            { err: error, documentId: doc.id, prefix },
            'snapshot objects not removed; the document is kept for the next run',
          );
          return false;
        }
      },
    });
    purged += batch.purged.length;
    failed.push(...batch.failed.map((d) => d.id));
    if (batch.purged.length + batch.failed.length < batchSize) break;
  }
  deps.logger.info(
    { purged, objectsDeleted, failed: failed.length },
    failed.length === 0 ? 'purge complete' : 'purge complete with failures',
  );
  return { purged, objectsDeleted, failed };
}
