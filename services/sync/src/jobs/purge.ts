/**
 * Nightly purge (LIB-08): documents whose soft-deletion is older than the
 * 30-day Recently Deleted window are deleted for good. Per batch (#109):
 *
 *   1. read up to `batchSize` expired documents (no transaction held);
 *   2. remove each one's S3 objects — outside any transaction, so a slow or
 *      retried S3 call can never hit the pool's 30 s idle-in-transaction
 *      timeout (`25P03`), which used to kill the claim and fail the night;
 *   3. delete the rows of the documents whose objects went, in one short
 *      transaction, with a `document.purge` audit row each (system actor).
 *
 * Retry-safe: a document past the window cannot be recovered, so nothing
 * read in step 1 comes back to life; deleting a prefix twice is harmless; a
 * run that dies between 2 and 3 leaves rows whose objects are gone, and the
 * next run deletes them (step 2 finds nothing to remove and succeeds). A
 * document whose objects could not be removed keeps its rows and is retried
 * next run — never an orphaned object behind a deleted row. A batch whose
 * row delete fails is logged with its ids and skipped for the rest of the
 * run; the run reports it and exits non-zero, but the other batches go.
 *
 * Run as `node main.js --job purge` by an EventBridge Scheduler task
 * (`infra/lib/stacks/ops-stack.ts`); the same code is callable from tests.
 * Any failure is reported in the result and makes the job exit non-zero.
 */
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import type { PurgedDocument, Repo } from '../repo/types.js';
import { documentPrefix } from '../s3.js';

/** Documents per batch: bounds the row-delete transaction and the lock footprint. */
export const PURGE_BATCH_SIZE = 50;

export interface PurgeResult {
  /** Documents whose objects and rows were deleted. */
  readonly purged: number;
  /** S3 objects removed. */
  readonly objectsDeleted: number;
  /** Documents left in place because their objects could not be removed, or whose batch failed (retried next run). */
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
    const candidates = await deps.repo.documents.expiredForPurge({
      limit: batchSize,
      exclude: failed,
    });
    if (candidates.length === 0) break;
    const cleared: PurgedDocument[] = [];
    for (const doc of candidates) {
      const prefix = documentPrefix(deps.docsPrefix, doc.id);
      try {
        const removed = await deps.s3.deletePrefix(prefix);
        objectsDeleted += removed;
        cleared.push(doc);
      } catch (error) {
        deps.logger.error(
          { err: error, documentId: doc.id, prefix },
          'snapshot objects not removed; the document is kept for the next run',
        );
        failed.push(doc.id);
      }
    }
    if (cleared.length > 0) {
      try {
        const gone = await deps.repo.documents.purge(cleared.map((d) => d.id));
        purged += gone.length;
        for (const doc of gone) {
          deps.logger.info({ documentId: doc.id }, 'expired document purged');
        }
      } catch (error) {
        // The objects are gone; the rows wait for the next run, which finds
        // nothing to remove in S3 and deletes them then. Not retried tonight:
        // a database that refused once is not asked fifty more times.
        const ids = cleared.map((d) => d.id);
        deps.logger.error(
          { err: error, documents: ids },
          'purge batch failed after its objects were removed; rows kept for the next run',
        );
        failed.push(...ids);
      }
    }
    if (candidates.length < batchSize) break;
  }
  deps.logger.info(
    { purged, objectsDeleted, failed: failed.length },
    failed.length === 0 ? 'purge complete' : 'purge complete with failures',
  );
  return { purged, objectsDeleted, failed };
}
