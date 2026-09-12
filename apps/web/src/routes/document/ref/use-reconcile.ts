/**
 * Keeps pulls (REF-02) and `Split()` children (HIER-07) reconciled while a
 * document is open for editing. One installation per document, reference-
 * counted by the tables that mount it; a read-only session (phone, viewer)
 * installs nothing — the replica that can write reconciles for both, and
 * concurrent reconciles converge (packages/core/src/ref).
 *
 * Pulls follow the document (`observePulls`). Split children follow the
 * engine: after every batch of results the pieces of each table's split
 * column are read off the results and materialised as rows. Values are never
 * computed here; the engine's Worker did that.
 */
import { useEffect } from 'react';
import type * as Y from 'yjs';
import {
  observePulls,
  openDocument,
  reconcileFilteredPulls,
  reconcileSplitChildren,
  splitPiecesOf,
  workbookCellId,
  type CellKey,
} from '@gede/core';

import { engineFor } from '../../../doc/engine.js';

interface Installation {
  count: number;
  stop: () => void;
}

const installs = new WeakMap<Y.Doc, Installation>();

function install(doc: Y.Doc): () => void {
  const gd = openDocument(doc);
  const host = engineFor(doc);
  // A pull's filter reads a formula or derived cell by the value the Worker evaluated.
  const cellValue = (tableId: string, key: CellKey) =>
    host.result(workbookCellId(tableId, key))?.value;
  const stopPulls = observePulls(gd, { cellValue });
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    try {
      for (const [tableId, pieces] of splitPiecesOf(gd, (id) => host.result(id))) {
        reconcileSplitChildren(gd, tableId, pieces);
      }
      // Results moved: a filtered pull over engine-backed cells may admit different rows now.
      reconcileFilteredPulls(gd, { cellValue });
    } finally {
      running = false;
    }
  };
  const stopResults = host.subscribeAll(run);
  run();
  return () => {
    stopPulls();
    stopResults();
  };
}

/**
 * Mount from any component that lives as long as the document view (each
 * TableView does). Installs once per document while `editable`.
 */
export function useReferenceReconciler(doc: Y.Doc | null, editable: boolean): void {
  useEffect(() => {
    if (doc === null || !editable) return undefined;
    let entry = installs.get(doc);
    if (entry === undefined) {
      entry = { count: 0, stop: install(doc) };
      installs.set(doc, entry);
    }
    const shared = entry;
    shared.count += 1;
    return () => {
      shared.count -= 1;
      if (shared.count === 0) {
        shared.stop();
        if (installs.get(doc) === shared) installs.delete(doc);
      }
    };
  }, [doc, editable]);
}
