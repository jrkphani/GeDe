/**
 * Persistence Writer (ARCHITECTURE §1.3): appends every client update to
 * `doc_updates`, compacts to an S3 snapshot on a threshold, and prunes the log
 * after the snapshot is durable.
 *
 * Writes are coalesced over a short window (a typing burst is a few updates
 * per second) into one multi-row insert. Flushes and compactions are chained
 * on one promise per document so their order is total: a compaction never
 * runs between an append and its sequence-number assignment.
 */
import * as Y from 'yjs';

import type { Config } from '../config.js';
import type { SnapshotStore } from '../deps.js';
import type { Logger } from '../logger.js';
import type { UpdatesRepo } from '../repo/types.js';
import { snapshotKey } from '../s3.js';

interface PendingUpdate {
  readonly update: Uint8Array;
  readonly authorId: string | null;
}

export interface PersistenceStats {
  /** Updates persisted to the log by this writer. */
  persisted: number;
  /** Snapshots written by this writer. */
  snapshots: number;
  /** Failed flush attempts (retried). */
  flushFailures: number;
  /** Compactions the database refused because a newer snapshot was already committed (#39). */
  staleSnapshots: number;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;
/** Flush passes `close()` makes before giving up on a database that keeps failing. */
const CLOSE_MAX_FLUSHES = 5;

export class PersistenceWriter {
  private pending: PendingUpdate[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private retryDelay = RETRY_BASE_MS;
  private closed = false;

  /** Highest sequence number known to be in the log (or covered by the snapshot). */
  private lastSeq: number;
  /** Sequence number the current snapshot covers. */
  private snapshotSeq: number;
  /** Everything up to here was in the doc when it was loaded, or in this writer's last snapshot. */
  private coversFrom: number;
  /** Updates this writer has appended since `coversFrom`; what its next snapshot adds. */
  private appendedSince = 0;

  readonly stats: PersistenceStats = {
    persisted: 0,
    snapshots: 0,
    flushFailures: 0,
    staleSnapshots: 0,
  };

  constructor(
    private readonly documentId: string,
    private readonly doc: Y.Doc,
    private readonly repo: UpdatesRepo,
    private readonly s3: SnapshotStore,
    private readonly config: Pick<
      Config,
      'SNAPSHOT_EVERY_UPDATES' | 'SNAPSHOT_IDLE_MS' | 'PERSIST_COALESCE_MS' | 'DOCS_PREFIX'
    >,
    private readonly logger: Logger,
    initial: { snapshotSeq: number; lastSeq: number },
    /** Called with the snapshot's bytes after each successful compaction (the projection hook). */
    private readonly onSnapshot?: (bytes: Uint8Array, seq: number) => void,
    /** Called when a commit was refused because another task wrote to the document (#39). */
    private readonly onSuperseded?: () => void,
  ) {
    this.snapshotSeq = initial.snapshotSeq;
    this.lastSeq = initial.lastSeq;
    this.coversFrom = initial.lastSeq;
    this.armIdleTimer();
  }

  get persistedSeq(): number {
    return this.lastSeq;
  }

  get currentSnapshotSeq(): number {
    return this.snapshotSeq;
  }

  /** Queue a client update. Returns immediately; the write happens within the coalescing window. */
  enqueue(update: Uint8Array, authorId: string | null): void {
    if (this.closed) {
      this.logger.warn({ documentId: this.documentId }, 'update after writer closed; dropped');
      return;
    }
    this.pending.push({ update, authorId });
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.config.PERSIST_COALESCE_MS);
    this.armIdleTimer();
  }

  /** Write everything queued so far. Resolves after the write (or the failed attempt) completes. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushNow());
    return this.chain;
  }

  /** Snapshot the current state if anything has been persisted since the last snapshot. */
  compact(): Promise<void> {
    this.chain = this.chain.then(() => this.compactNow());
    return this.chain;
  }

  /** True once `close()` has drained the queue; later updates are refused, never silently dropped. */
  get sealed(): boolean {
    return this.closed;
  }

  /**
   * Drain, seal, optionally compact. Called on room eviction, on delete and
   * on shutdown. Updates keep being accepted while the drain runs — a frame
   * that lands during the final append is flushed by the next pass — and
   * the writer seals only once a pass finds nothing pending, in the same
   * synchronous step as that check; `beforeCompact` (the room closing its
   * sockets) runs in that step too. The room checks `sealed` before it
   * applies a message, so no update can slip in between. A flush that keeps
   * failing (database down) is retried `CLOSE_MAX_FLUSHES` times with the
   * usual backoff and then given up with the count in the log; the process
   * shutdown deadline bounds the wait.
   */
  async close(options: { compact: boolean; beforeCompact?: () => void }): Promise<void> {
    this.clearFlushTimer();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    let attempts = 0;
    do {
      attempts += 1;
      // Chains behind a pass already in flight (its batch is no longer in
      // `pending`), then writes whatever arrived meanwhile.
      await this.flush();
      // A failed pass arms its own retry timer; this loop is the retry.
      this.clearFlushTimer();
      if (this.pending.length > 0 && attempts < CLOSE_MAX_FLUSHES) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
      }
    } while (this.pending.length > 0 && attempts < CLOSE_MAX_FLUSHES);
    // Same synchronous step as the last `pending` check: nothing can enqueue in between.
    this.closed = true;
    this.clearFlushTimer();
    options.beforeCompact?.();
    if (this.pending.length > 0) {
      this.logger.error(
        { documentId: this.documentId, pending: this.pending.length, attempts },
        'writer closed with updates still unpersisted',
      );
      return;
    }
    if (options.compact) await this.compact();
  }

  /** A method, not inline: an `await` may have re-armed the timer TypeScript's narrowing believes is null. */
  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.lastSeq > this.snapshotSeq || this.pending.length > 0) void this.compact();
    }, this.config.SNAPSHOT_IDLE_MS);
    // Do not keep a process alive just to snapshot an idle document.
    this.idleTimer.unref();
  }

  private async flushNow(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      const range = await this.repo.append(this.documentId, batch);
      this.lastSeq = range.lastSeq;
      this.appendedSince += batch.length;
      this.stats.persisted += batch.length;
      this.retryDelay = RETRY_BASE_MS;
      this.logger.debug(
        { documentId: this.documentId, count: batch.length, lastSeq: range.lastSeq },
        'updates persisted',
      );
    } catch (error) {
      // Keep the updates: they are still applied in memory and will be retried.
      this.pending = batch.concat(this.pending);
      this.stats.flushFailures += 1;
      this.logger.error(
        { err: error, documentId: this.documentId, pending: this.pending.length },
        'persisting updates failed; will retry',
      );
      if (!this.closed && this.flushTimer === null) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
      }
      return;
    }
    if (this.lastSeq - this.snapshotSeq >= this.config.SNAPSHOT_EVERY_UPDATES) {
      await this.compactNow();
    }
  }

  private async compactNow(): Promise<void> {
    if (this.pending.length > 0) await this.flushNow();
    const seq = this.lastSeq;
    if (seq <= this.snapshotSeq) return;
    const bytes = Y.encodeStateAsUpdate(this.doc);
    const key = snapshotKey(this.config.DOCS_PREFIX, this.documentId, seq);
    let committed: boolean;
    try {
      await this.s3.put(key, bytes);
      committed = await this.repo.commitSnapshot({
        documentId: this.documentId,
        seq,
        s3Key: key,
        sizeBytes: bytes.byteLength,
        coversFrom: this.coversFrom,
        appended: this.appendedSince,
      });
    } catch (error) {
      // The log is intact, so nothing is lost; the next threshold retries.
      this.logger.error({ err: error, documentId: this.documentId, seq }, 'snapshot failed');
      return;
    }
    if (!committed) {
      // Another task compacted this document past `seq`, or wrote to it rows
      // this snapshot does not contain (#39): the database kept its pointer and
      // log, our object is unreferenced, and this writer is behind. Nothing to
      // advance; the next compaction re-reads the truth.
      this.stats.staleSnapshots += 1;
      this.logger.warn({ documentId: this.documentId, seq }, 'snapshot superseded; not committed');
      this.onSuperseded?.();
      return;
    }
    this.snapshotSeq = seq;
    this.coversFrom = seq;
    this.appendedSince = 0;
    this.stats.snapshots += 1;
    this.logger.info(
      { documentId: this.documentId, seq, bytes: bytes.byteLength, key },
      'snapshot written',
    );
    this.onSnapshot?.(bytes, seq);
  }
}
