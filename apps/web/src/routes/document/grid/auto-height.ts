/**
 * Auto-fit row heights (GRID-09, ADR-049): a wrapped row is as tall as its
 * tallest wrapped cell, and a row stays tall enough for its type size
 * (ADR-034). Heights are document data — addresses depend on them, so every
 * replica must agree — and text can only be measured where it is drawn, so
 * the replica that makes a local edit measures the rows the edit touched
 * and stores what they need. A collaborator receives the heights and never
 * measures; undo restores the heights it wrote in the same step.
 *
 * Runs outside React: one deep observer on the tables map, answering only
 * local transactions that were not an undo or a redo, and writing in a
 * transaction of the document's own origin so the undo manager folds the
 * height into the step that caused it (KEYS-03). A height write touches
 * `height` and `fit` alone, which this observer ignores, so it
 * never answers itself.
 */
import {
  needsLegacyHeightSettling,
  rowMeta,
  setRowHeights,
  settleLegacyRowHeights,
  tableMap,
  tableRecord,
  type GedeDoc,
  type Id,
} from '@gede/core';
import * as Y from 'yjs';

import { fitRowsToContent, rowsToMeasure, type FitOptions } from '../style/fit.js';

/** Keys of a row meta map whose change never needs a re-measure. */
const HEIGHT_KEYS = new Set(['height', 'fit']);
/**
 * Keys of the table map whose change needs every row re-measured: table-scope
 * wrap, and a nested map born in this transaction (its first override, span
 * or format lands as the map itself, not as a key of it).
 */
const TABLE_KEYS = new Set(['wrap', 'cells', 'cellAppearance', 'cellFormat', 'spans']);

/** Which rows of which tables a set of events touched; `null` means every row. */
export type Touched = Map<Id, Set<Id> | null>;

function rowOfKey(key: unknown): Id | null {
  if (typeof key !== 'string') return null;
  const at = key.indexOf(':');
  return at > 0 ? key.slice(0, at) : null;
}

function touch(out: Touched, tableId: Id, rowId: Id | null): void {
  if (rowId === null) {
    out.set(tableId, null);
    return;
  }
  const rows = out.get(tableId);
  if (rows === null) return;
  if (rows === undefined) out.set(tableId, new Set([rowId]));
  else rows.add(rowId);
}

/**
 * The rows whose content, width, wrap or type size a set of table events
 * may have changed. Exported for the tests; the observer feeds it every
 * local transaction's events.
 */
export function touchedRows(events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): Touched {
  const out: Touched = new Map();
  for (const event of events) {
    const [tableId, section, third] = event.path;
    if (typeof tableId !== 'string') continue;
    if (section === undefined) {
      // The table map itself: table-scope wrap, or a nested map's birth (every row).
      for (const key of event.changes.keys.keys())
        if (TABLE_KEYS.has(key)) touch(out, tableId, null);
      continue;
    }
    switch (section) {
      case 'cells':
      case 'cellAppearance':
      case 'cellFormat': {
        if (third !== undefined) {
          touch(out, tableId, rowOfKey(third));
        } else {
          for (const key of event.changes.keys.keys()) touch(out, tableId, rowOfKey(key));
        }
        break;
      }
      case 'columns':
      case 'spans':
        touch(out, tableId, null);
        break;
      case 'rowMeta': {
        if (typeof third !== 'string') break;
        for (const key of event.changes.keys.keys()) {
          if (!HEIGHT_KEYS.has(key)) touch(out, tableId, third);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export interface AutoHeightDeps {
  /** How to measure now, or null when this browser cannot (no 2D context): then nothing is written. */
  fit: () => FitOptions | null;
  /** Whether this replica may write (RESP-02, SHARE-03); a view-only replica never measures. */
  editable: () => boolean;
}

/**
 * Measure `touched` rows that follow their content and store what changed;
 * a row set by hand (`fit` off) keeps its height (R-B). Returns the heights
 * written (row id → units) per table, for the tests and for callers that
 * fit on demand.
 */
export function fitTouched(
  gd: GedeDoc,
  touched: Touched,
  deps: AutoHeightDeps,
): Map<Id, Map<Id, number>> {
  const written = new Map<Id, Map<Id, number>>();
  if (!deps.editable()) return written;
  const options = deps.fit();
  if (options === null) return written;
  for (const [tableId, rows] of touched) {
    const table = tableMap(gd, tableId);
    if (table === null) continue;
    const record = tableRecord(table);
    const only =
      rows === null
        ? record.rows.filter((id) => rowMeta(table, id).fit)
        : rowsToMeasure(table, record, [...rows]).filter((id) => rowMeta(table, id).fit);
    if (only.length === 0) continue;
    const needs = fitRowsToContent(table, record, { ...options, only });
    const changes = needs.filter(({ rowId, units }) => units !== rowMeta(table, rowId).height);
    if (changes.length === 0) continue;
    const stored = setRowHeights(gd, tableId, changes, 'auto');
    written.set(tableId, new Map(changes.map((c, i) => [c.rowId, stored[i] ?? c.units])));
  }
  return written;
}

/**
 * ADR-049, review of #169: a table written before ADR-049 with a wrapping
 * column had its rows at two units by derivation, never stored. On this
 * replica — the first that can write — measure every row of such a table
 * once and store what it needs, under `LEGACY_HEIGHTS_ORIGIN` (local, so it
 * syncs; not an undo step; not answered by the observer). Readers never
 * measure (R-B). Idempotent: a settled row carries `fit`, and a table with
 * no unsettled row is skipped. Returns the ids of the tables settled.
 */
export function settleLegacyTables(
  gd: GedeDoc,
  deps: AutoHeightDeps,
  only?: ReadonlySet<Id>,
): Id[] {
  if (!deps.editable()) return [];
  const settled: Id[] = [];
  let options: FitOptions | null | undefined;
  gd.tables.forEach((table, tableId) => {
    if (only !== undefined && !only.has(tableId)) return;
    if (!needsLegacyHeightSettling(table)) return;
    options ??= deps.fit();
    if (options === null) return;
    const record = tableRecord(table);
    // A row set by hand since (a stored `fit: false`) keeps its height; the rest are measured.
    const rows = record.rows.filter((id) => rowMeta(table, id).fit);
    const needs = fitRowsToContent(table, record, { ...options, only: rows });
    settleLegacyRowHeights(gd, tableId, needs);
    settled.push(tableId);
  });
  return settled;
}

/**
 * Install the observer. Returns the disposer. A local transaction is answered
 * when its origin is neither an undo manager nor a string (seed, sweep,
 * legacy settling: housekeeping origins that never change what a row needs).
 * A remote transaction is not measured (R-B) — but the tables it brings are
 * checked for the legacy shape, as is everything already loaded at install,
 * so the first editing replica settles them once.
 */
export function installAutoHeight(gd: GedeDoc, deps: AutoHeightDeps): () => void {
  const onChange = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ): void => {
    if (!transaction.local) {
      const arrived = new Set<Id>();
      for (const event of events) {
        const [tableId] = event.path;
        if (typeof tableId === 'string') arrived.add(tableId);
        else if (event.target === gd.tables) {
          for (const key of event.changes.keys.keys()) arrived.add(key);
        }
      }
      if (arrived.size > 0) settleLegacyTables(gd, deps, arrived);
      return;
    }
    if (transaction.origin instanceof Y.UndoManager) return;
    if (typeof transaction.origin === 'string') return; // seed, sweep, legacy: housekeeping origins
    const touched = touchedRows(events);
    if (touched.size === 0) return;
    fitTouched(gd, touched, deps);
  };
  gd.tables.observeDeep(onChange);
  settleLegacyTables(gd, deps);
  return () => {
    gd.tables.unobserveDeep(onChange);
  };
}
