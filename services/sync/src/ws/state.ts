/**
 * Cold open (services/sync/CLAUDE.md, persistence contract step 3): the latest
 * snapshot from S3, then every `doc_updates` row after it, applied to a
 * `Y.Doc`. Shared by the room and by `--job reproject`, which rebuilds the
 * projection from stored state alone.
 */
import * as Y from 'yjs';

import type { SnapshotStore } from '../deps.js';
import type { UpdatesRepo } from '../repo/types.js';

/** Transaction origin for updates replayed from storage; never persisted or echoed. */
export const LOAD_ORIGIN = Symbol('load');

export interface LoadedState {
  /** Sequence number the snapshot covers (0 when there is none). */
  readonly snapshotSeq: number;
  /** Highest sequence number applied (snapshot or log). */
  readonly lastSeq: number;
  /** Log rows replayed after the snapshot. */
  readonly replayed: number;
  /** Bytes applied (snapshot plus replayed rows): the room's first estimate of the document's size (#99). */
  readonly bytes: number;
}

export async function loadStoredState(
  doc: Y.Doc,
  documentId: string,
  repo: UpdatesRepo,
  s3: SnapshotStore,
): Promise<LoadedState> {
  const state = await repo.loadState(documentId);
  let lastSeq = state.snapshotSeq;
  let bytes = 0;
  if (state.snapshotKey !== null) {
    const snapshot = await s3.get(state.snapshotKey);
    if (snapshot === undefined) {
      // The pointer exists but the object does not: refuse to serve a
      // document with silently missing history.
      throw new Error(`snapshot ${state.snapshotKey} is missing from the bucket`);
    }
    Y.applyUpdate(doc, snapshot, LOAD_ORIGIN);
    bytes += snapshot.byteLength;
  }
  for (const entry of state.updates) {
    Y.applyUpdate(doc, entry.update, LOAD_ORIGIN);
    lastSeq = Math.max(lastSeq, entry.seq);
    bytes += entry.update.byteLength;
  }
  return { snapshotSeq: state.snapshotSeq, lastSeq, replayed: state.updates.length, bytes };
}
