/**
 * Undo, scoped per document (KEYS-03). Tracks only transactions with the
 * document's local origin, so remote collaborators' edits, seeding and
 * persistence replays never land on the local undo stack.
 */
import * as Y from 'yjs';

import type { GedeDoc } from './schema.js';

export interface UndoOptions {
  /** Edits closer together than this merge into one undo step. Default 500 ms. */
  captureTimeout?: number;
}

export function createUndoManager(gd: GedeDoc, options: UndoOptions = {}): Y.UndoManager {
  const manager = new Y.UndoManager([gd.sheets, gd.tables, gd.graphs, gd.meta], {
    trackedOrigins: new Set<unknown>([gd.origin]),
    captureTimeout: options.captureTimeout ?? 500,
  });
  return manager;
}
