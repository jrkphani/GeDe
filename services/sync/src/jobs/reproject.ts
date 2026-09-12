/**
 * `node main.js --job reproject <docId|all>`: rebuild the relational
 * projection of one document, or of every live document, from stored state
 * (snapshot + log). The projection is rebuildable by contract
 * (packages/db/CLAUDE.md); this is the tool that proves it, and the fix when
 * a projection is found stale or a schema change adds a projected column.
 */
import * as Y from 'yjs';

import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import type { ProjectionWorker } from '../projection/worker.js';
import type { Repo } from '../repo/types.js';
import { loadStoredState } from '../ws/state.js';

export interface ReprojectResult {
  /** Documents whose projection was rebuilt. */
  readonly projected: number;
  /** Documents that could not be rebuilt (missing snapshot object, database error); logged individually. */
  readonly failed: readonly string[];
}

export interface ReprojectDeps {
  readonly repo: Repo;
  readonly s3: SnapshotStore;
  readonly worker: Pick<ProjectionWorker, 'projectNow'>;
  readonly logger: Logger;
}

export async function reproject(deps: ReprojectDeps, target: string): Promise<ReprojectResult> {
  const ids = target === 'all' ? await deps.repo.projection.liveDocumentIds() : [target];
  let projected = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const doc = new Y.Doc({ gc: true });
    try {
      const state = await loadStoredState(doc, id, deps.repo.updates, deps.s3);
      const bytes = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      await deps.worker.projectNow(id, bytes);
      projected += 1;
      deps.logger.info({ documentId: id, lastSeq: state.lastSeq }, 'projection rebuilt');
    } catch (error) {
      doc.destroy();
      failed.push(id);
      deps.logger.error({ err: error, documentId: id }, 'projection rebuild failed');
    }
  }
  deps.logger.info({ projected, failed: failed.length, target }, 'reproject complete');
  return { projected, failed };
}
