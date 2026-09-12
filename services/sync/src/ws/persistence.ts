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
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;

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

  readonly stats: PersistenceStats = { persisted: 0, snapshots: 0, flushFailures: 0 };

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
  ) {
    this.snapshotSeq = initial.snapshotSeq;
    this.lastSeq = initial.lastSeq;
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

  /** Flush, stop timers. Called on room eviction and on shutdown. */
  async close(options: { compact: boolean }): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.flushTimer = null;
    this.idleTimer = null;
    await this.flush();
    if (options.compact) await this.compact();
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
    try {
      await this.s3.put(key, bytes);
      await this.repo.commitSnapshot({
        documentId: this.documentId,
        seq,
        s3Key: key,
        sizeBytes: bytes.byteLength,
      });
    } catch (error) {
      // The log is intact, so nothing is lost; the next threshold retries.
      this.logger.error({ err: error, documentId: this.documentId, seq }, 'snapshot failed');
      return;
    }
    this.snapshotSeq = seq;
    this.stats.snapshots += 1;
    this.logger.info(
      { documentId: this.documentId, seq, bytes: bytes.byteLength, key },
      'snapshot written',
    );
  }
}
