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
 * hands off no items and runs only for the tables a transaction touched. A
 * table's rows are filled only while no change to that table is outstanding:
 * a Worker answers in order, so while a later request touching the table is
 * pending its cached result may still be the previous formula's, and filling
 * from it would revert a peer's change (its formula, or the rows its replica
 * filled) and broadcast the revert. A pending change to an operand's table
 * alone cannot do that: the rows still match the cached result, so the fill
 * writes nothing until the operand's answer arrives with the new result.
 */
import { useEffect } from 'react';
import * as Y from 'yjs';
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
  // `formula`: another person's Fill of the same table won the merge (ADR-056 ruling a).
  const stopRefusals = observeRefusedFills(gd, (tableId, colId, reason) => {
    const column = tableById(gd, tableId)?.columns.find((c) => c.id === colId);
    if (column === undefined) return;
    const key = reason === 'formula' ? 'set.fillSuperseded' : 'set.fillRefused';
    announce(translate(activeLocale(), key, { column: column.label }));
  });
  let stopped = false;
  /** Tables whose fill waits for a change to them to be answered. */
  const waiting = new Set<string>();
  const waitFor = (tableId: string): void => {
    if (waiting.has(tableId)) return;
    waiting.add(tableId);
    void host.settledFor(tableId).then(() => {
      waiting.delete(tableId);
      if (!stopped) run();
    });
  };
  // SET-08: a computed table's formula, evaluated once in the Worker, fills its table's rows —
  // only once every change to that table is answered (see the header), so formula traffic in
  // other tables never holds it back. A Worker that gave up answers nothing: its cached
  // results predate the document, and nothing is filled from them until Retry.
  const fillComputed = (): void => {
    if (host.status.failed) return;
    for (const { tableId, items, members } of computedItemsOf(gd, (id) => host.result(id))) {
      if (host.busyFor(tableId)) waitFor(tableId);
      else reconcileComputed(gd, tableId, items, members);
    }
  };
  // Ruling (d): the soundness pass, with no items (see the header).
  const keepComputedSound = (tables: ReadonlySet<string>): void => {
    for (const { tableId } of computedItemsOf(gd, () => undefined, tables)) {
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
  // Ruling (d): once per burst of transactions other than its own, coalesced into one pass
  // over the tables they touched.
  const touched = new Set<string>();
  const onTransaction = (tr: Y.Transaction): void => {
    if (tr.origin === COMPUTED_ORIGIN) return;
    const before = touched.size;
    for (const type of tr.changed.keys()) {
      let t: unknown = type;
      while (t instanceof Y.AbstractType && t.parent !== gd.tables) t = t.parent;
      const id: unknown = t instanceof Y.Map ? t.get('id') : undefined;
      if (typeof id === 'string') touched.add(id);
    }
    if (before > 0 || touched.size === 0) return;
    queueMicrotask(() => {
      const tables = new Set(touched);
      touched.clear();
      if (!stopped) keepComputedSound(tables);
    });
  };
  doc.on('afterTransaction', onTransaction);
  return () => {
    stopped = true;
    stopPulls();
    stopRefusals();
    stopResults();
    doc.off('afterTransaction', onTransaction);
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
