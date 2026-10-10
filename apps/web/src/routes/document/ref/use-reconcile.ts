/**
 * Keeps pulls (REF-02), `Split()` children (HIER-07) and computed rows (SET-08) reconciled while a
 * document is open for editing. One installation per document, reference-
 * counted by the tables that mount it; a read-only session (phone, viewer)
 * installs nothing — the replica that can write reconciles for both, and
 * concurrent reconciles converge (packages/core/src/ref).
 *
 * Pulls follow the document (`observePulls`). Split children follow the
 * engine: after every batch of results the pieces of each table's split
 * column are read off the results and materialised as rows. Values are never
 * computed here; the engine's Worker did that. Computed tables are also kept
 * sound after every other update, remote or local (ADR-056 ruling d): a merge
 * can refuse a Fill, return a removed noted row or leave a row twice, and a
 * cleared note lets a lost row go (SET-12), with no result changing. That pass
 * hands off no items: the cached result may still be the previous formula's (a
 * Worker answers later), so removing and labelling rows by it would revert a
 * peer's formula change; only a result batch fills rows.
 */
import { useEffect } from 'react';
import type * as Y from 'yjs';
import {
  COMPUTED_ORIGIN,
  computedItemsOf,
  observePulls,
  observeRefusedFills,
  openDocument,
  reconcileComputed,
  reconcileFilteredPulls,
  reconcileSplitChildren,
  splitPiecesOf,
  tableById,
  workbookCellId,
  type CellKey,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { engineFor } from '../../../doc/engine.js';
import { translate } from '../../../i18n/index.js';
import { activeLocale } from '../../../locale.js';

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
  // SET-10 after a merge: a Fill column refused here or on another replica is said, not silent.
  const stopRefusals = observeRefusedFills(gd, (tableId, colId) => {
    const column = tableById(gd, tableId)?.columns.find((c) => c.id === colId);
    if (column === undefined) return;
    announce(translate(activeLocale(), 'set.fillRefused', { column: column.label }));
  });
  // SET-08: a computed table's formula, evaluated once in the Worker, fills its table's rows.
  const fillComputed = (): void => {
    for (const { tableId, items, members } of computedItemsOf(gd, (id) => host.result(id))) {
      reconcileComputed(gd, tableId, items, members);
    }
  };
  // Ruling (d): the soundness pass, with no items (see the header).
  const keepComputedSound = (): void => {
    for (const { tableId } of computedItemsOf(gd, () => undefined)) {
      reconcileComputed(gd, tableId, null);
    }
  };
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    try {
      for (const [tableId, pieces] of splitPiecesOf(gd, (id) => host.result(id))) {
        reconcileSplitChildren(gd, tableId, pieces);
      }
      fillComputed();
      // Results moved: a filtered pull over engine-backed cells may admit different rows now.
      reconcileFilteredPulls(gd, { cellValue });
    } finally {
      running = false;
    }
  };
  const stopResults = host.subscribeAll(run);
  run();
  // Ruling (d): once per burst of updates other than its own, coalesced into one pass.
  // ponytail: runs after every local edit too (a scan of each computed table's rows);
  // gate on the transaction touching a computed table if keystrokes ever feel it.
  let queued = false;
  let stopped = false;
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === COMPUTED_ORIGIN || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!stopped) keepComputedSound();
    });
  };
  doc.on('update', onUpdate);
  return () => {
    stopped = true;
    stopPulls();
    stopRefusals();
    stopResults();
    doc.off('update', onUpdate);
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
