/**
 * Keeps pulls reconciled as the document changes (REF-02 "values stay
 * live"; here the *row set* stays live — the values are the engine's).
 *
 * One observer per open document, installed by the app while the document
 * is editable. A transaction re-runs the reconcile only for the pulls whose
 * source table (or receiving table) it touched, and only when it touched
 * something the row set can depend on — cells, rows, columns, row meta — so
 * a resize or a move reconciles nothing. A reconcile's own transaction
 * (`REF_ORIGIN`) is ignored, so the loop closes. Remote and undo
 * transactions count too: a phone that only reads never reconciles, so the
 * replica that can write does it for both, and concurrent reconciles
 * converge (see `pull.ts`).
 *
 * Cost (PRD §20, 16 ms per keystroke): the contains filter reads every row
 * of the source, so the observer keeps each row's lower-cased text and drops
 * only the rows a transaction's cells changed. Rows that read a formula or a
 * derived cell are never cached — their text is the engine's and changes
 * without a document transaction; `reconcileFilteredPulls` re-runs those
 * after a results batch.
 */
import type * as Y from 'yjs';

import {
  cellsMap,
  readString,
  tableRecord,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';
import { cellKey, splitCellKey, type Id } from '../ids.js';
import { pullOf, REF_ORIGIN, reconcilePull, tablesWithPulls, type PullReader } from './pull.js';

/** What a transaction touched in one table: which rows' cells, or its structure. */
export interface TableTouch {
  /** Row ids whose cells changed; `null` when the structure changed (everything may have). */
  readonly rows: ReadonlySet<Id> | null;
}

/** The tables a batch of deep events touched, with how (a table added or removed counts as structure). */
export function touchedTables(
  gd: GedeDoc,
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
): Map<Id, TableTouch> {
  const out = new Map<Id, { rows: Set<Id> | null }>();
  const touch = (tableId: Id, rowId: Id | null): void => {
    const entry = out.get(tableId) ?? { rows: new Set<Id>() };
    if (rowId === null) entry.rows = null;
    else entry.rows?.add(rowId);
    out.set(tableId, entry);
  };
  for (const event of events) {
    if (event.target === gd.tables) {
      for (const key of event.changes.keys.keys()) touch(key, null);
      continue;
    }
    // Walk up to the table map; the chain's last node is the table's direct child.
    const chain: Y.AbstractType<unknown>[] = [];
    let node: Y.AbstractType<unknown> | null = event.target;
    while (node !== null && node.parent !== gd.tables) {
      chain.push(node);
      node = node.parent;
    }
    if (node === null) continue;
    const table = node as TableMap;
    const tableId = readString(table, 'id');
    if (tableId === '') continue;
    const direct = chain[chain.length - 1];
    const keys = [...event.changes.keys.keys()];
    if (direct === undefined) {
      // The table map's own keys: title, position, sizes… none of which the row set reads.
      if (keys.some((k) => ['rows', 'columns', 'cells', 'rowMeta'].includes(k))) {
        touch(tableId, null);
      }
    } else if (direct === cellsMap(table)) {
      if (chain.length === 1) {
        for (const key of keys) touch(tableId, splitCellKey(key).rowId);
      } else {
        const key = chain[chain.length - 2]?._item?.parentSub ?? null;
        if (key === null) touch(tableId, null);
        else touch(tableId, splitCellKey(key).rowId);
      }
    } else if (direct === table.get('columns')) {
      // Columns came or went, or a column's source, pull, derive or link changed. Its
      // width, wrap, label or format change nothing the row set reads.
      if (
        chain.length === 1 ||
        keys.some((k) => ['source', 'pull', 'derive', 'link'].includes(k))
      ) {
        touch(tableId, null);
      }
    } else if (direct === table.get('rowMeta')) {
      // Only provenance matters here (one hop): a meta map born with `pulledFrom`, or set later.
      if (chain.length === 1) {
        const metas = direct as Y.Map<Y.Map<unknown>>;
        if (keys.some((k) => metas.get(k)?.get('pulledFrom') !== undefined)) touch(tableId, null);
      } else if (keys.includes('pulledFrom')) {
        touch(tableId, null);
      }
    } else {
      touch(tableId, null); // the rows array
    }
  }
  return out;
}

/** The tables whose pull depends on any of `touched` (their source or themselves). */
export function pullsAffectedBy(gd: GedeDoc, touched: ReadonlySet<Id>): Id[] {
  const out: Id[] = [];
  for (const tableId of tablesWithPulls(gd)) {
    const table = gd.tables.get(tableId);
    if (table === undefined) continue;
    const pull = pullOf(table);
    if (touched.has(tableId) || (pull !== null && touched.has(pull.spec.tableId))) {
      out.push(tableId);
    }
  }
  return out;
}

/** Whether a row's text depends on the engine (a formula cell, or a derived column in the table). */
function readsEngine(source: TableMap, record: TableRecord, rowId: Id): boolean {
  if (record.columns.some((c) => c.derive !== null)) return true;
  // One lookup per column, never a walk of the whole cells map: this runs per row per
  // reconcile, and a walk made a keystroke cost rows × cells (≈1 s at 1,000 × 2,000).
  const cells = cellsMap(source);
  return record.columns.some((c) => typeof cells.get(cellKey(rowId, c.id)) === 'string');
}

/**
 * A reader whose per-row text survives across reconciles until `forget`
 * drops it; rows that read the engine are computed every time.
 */
export function cachingPullReader(cellValue: PullReader['cellValue']): {
  readonly reader: PullReader;
  readonly forget: (tableId: Id, rows: ReadonlySet<Id> | null) => void;
} {
  const cache = new Map<Id, Map<Id, string>>();
  return {
    reader: {
      cellValue,
      rowText: (source, record, rowId, compute) => {
        if (readsEngine(source, record, rowId)) return compute();
        let rows = cache.get(record.id);
        if (rows === undefined) {
          rows = new Map();
          cache.set(record.id, rows);
        }
        let text = rows.get(rowId);
        if (text === undefined) {
          text = compute();
          rows.set(rowId, text);
        }
        return text;
      },
    },
    forget: (tableId, rows) => {
      if (rows === null) {
        cache.delete(tableId);
        return;
      }
      const cached = cache.get(tableId);
      if (cached === undefined) return;
      for (const rowId of rows) cached.delete(rowId);
    },
  };
}

function runPasses(gd: GedeDoc, tables: readonly Id[], reader: PullReader): void {
  // A table pulling from a table that pulls settles on a second pass; bounded.
  for (let pass = 0; pass < 4; pass += 1) {
    let writes = 0;
    for (const tableId of tables) writes += reconcilePull(gd, tableId, REF_ORIGIN, reader);
    if (writes === 0) break;
  }
}

export interface ObservePullsOptions {
  /** The engine's evaluated value for a formula or derived cell (the app passes its result lookup). */
  readonly cellValue?: PullReader['cellValue'] | undefined;
}

/**
 * Start reconciling pulls for a document. Reconciles once on install (a
 * document opened after its source changed elsewhere catches up), then on
 * every relevant transaction. Returns the unsubscribe.
 */
export function observePulls(gd: GedeDoc, options: ObservePullsOptions = {}): () => void {
  const { reader, forget } = cachingPullReader(options.cellValue);
  let active = false;
  const run = (tables: readonly Id[]): void => {
    if (active || tables.length === 0) return;
    active = true;
    try {
      runPasses(gd, tables, reader);
    } finally {
      active = false;
    }
  };
  const handler = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ): void => {
    if (transaction.origin === REF_ORIGIN) return;
    const touched = touchedTables(gd, events);
    for (const [tableId, touch] of touched) forget(tableId, touch.rows);
    run(pullsAffectedBy(gd, new Set(touched.keys())));
  };
  run(tablesWithPulls(gd));
  gd.tables.observeDeep(handler);
  return () => {
    gd.tables.unobserveDeep(handler);
  };
}

/**
 * Re-run the pulls whose row set can depend on the engine — a filter over a
 * source with formula or derived cells — after a batch of results. Nothing
 * else is touched.
 */
export function reconcileFilteredPulls(gd: GedeDoc, reader: PullReader): number {
  const tables: Id[] = [];
  for (const tableId of tablesWithPulls(gd)) {
    const table = gd.tables.get(tableId);
    const pull = table === undefined ? null : pullOf(table);
    if (pull === null || pull.spec.filter.trim() === '') continue;
    const source = gd.tables.get(pull.spec.tableId);
    if (source === undefined) continue;
    const engineBacked =
      tableRecord(source).columns.some((c) => c.derive !== null) ||
      [...cellsMap(source).values()].some((content) => typeof content === 'string');
    if (engineBacked) tables.push(tableId);
  }
  let writes = 0;
  for (const tableId of tables) writes += reconcilePull(gd, tableId, REF_ORIGIN, reader);
  return writes;
}
