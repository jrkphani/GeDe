/**
 * Projection Worker (ARCHITECTURE §1.3): debounced after each compaction, it
 * materialises the document into the relational projection tables for search
 * (FIND-03), audit and reporting. It runs in the service process today; the
 * interface (bytes in, rows out) is what lets growth step 2 move it to its own
 * service without touching the rooms.
 *
 * Input is the snapshot's own bytes rather than the room's live `Y.Doc`: the
 * room may be evicted (and its doc destroyed) before the debounce fires, and
 * the same code then serves `--job reproject`, which has only stored bytes.
 * Writes for one document are serialised; documents are independent.
 */
import * as Y from 'yjs';

import type { Logger } from '../logger.js';
import type { ProjectionRepo } from '../repo/types.js';
import { projectDocument } from './project.js';

export interface ProjectionStats {
  /** Projections written. */
  runs: number;
  /** Projections that failed (the previous projection stays in place). */
  failures: number;
  /** Schedules coalesced into a later run by the debounce. */
  coalesced: number;
}

interface Pending {
  bytes: Uint8Array;
  timer: NodeJS.Timeout;
}

export class ProjectionWorker {
  readonly stats: ProjectionStats = { runs: 0, failures: 0, coalesced: 0 };
  private readonly pending = new Map<string, Pending>();
  private readonly chains = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly repo: ProjectionRepo,
    private readonly config: { PROJECTION_DEBOUNCE_MS: number },
    private readonly logger: Logger,
  ) {}

  /** Project `bytes` (a full Yjs state) for `documentId` once the debounce window closes. */
  schedule(documentId: string, bytes: Uint8Array): void {
    if (this.closed) {
      this.logger.warn({ documentId }, 'projection scheduled after shutdown; dropped');
      return;
    }
    const current = this.pending.get(documentId);
    if (current) {
      clearTimeout(current.timer);
      this.stats.coalesced += 1;
    }
    const timer = setTimeout(() => {
      this.pending.delete(documentId);
      void this.run(documentId, bytes);
    }, this.config.PROJECTION_DEBOUNCE_MS);
    timer.unref();
    this.pending.set(documentId, { bytes, timer });
  }

  /** Project now, bypassing the debounce (jobs). Resolves after the write; rejects on failure. */
  projectNow(documentId: string, bytes: Uint8Array): Promise<void> {
    // `bytes` is newer than anything still waiting in the debounce window for this
    // document; letting that timer fire later would overwrite this projection with the
    // older state (seen on CodeBuild: the seed projection from POST /api/documents
    // landed after a job's projectNow and emptied the search index).
    const current = this.pending.get(documentId);
    if (current) {
      clearTimeout(current.timer);
      this.pending.delete(documentId);
      this.stats.coalesced += 1;
    }
    return this.run(documentId, bytes, { rethrow: true });
  }

  /** Run everything still pending and wait for every in-flight write (shutdown). */
  async flush(): Promise<void> {
    for (const [documentId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(documentId);
      void this.run(documentId, entry.bytes);
    }
    await Promise.all(this.chains.values());
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private run(documentId: string, bytes: Uint8Array, options = { rethrow: false }): Promise<void> {
    const previous = this.chains.get(documentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.write(documentId, bytes))
      .then(
        () => {
          this.stats.runs += 1;
        },
        (error: unknown) => {
          this.stats.failures += 1;
          this.logger.error({ err: error, documentId }, 'projection failed; previous rows kept');
          if (options.rethrow) throw error;
        },
      )
      .finally(() => {
        if (this.chains.get(documentId) === next) this.chains.delete(documentId);
      });
    this.chains.set(documentId, next);
    return next;
  }

  private async write(documentId: string, bytes: Uint8Array): Promise<void> {
    const doc = new Y.Doc({ gc: true });
    let projection;
    try {
      Y.applyUpdate(doc, bytes);
      projection = projectDocument(doc, documentId);
    } finally {
      doc.destroy();
    }
    await this.repo.replace(projection);
    this.logger.info(
      {
        documentId,
        sheets: projection.sheets.length,
        tables: projection.tables.length,
        cells: projection.cells.length,
      },
      'projection written',
    );
  }
}
