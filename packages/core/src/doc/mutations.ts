/**
 * Mutation helpers. Every write runs inside `doc.transact(fn, gd.origin)` so
 * one user gesture is one undo step and one sync message, and every position
 * or size snaps to the lattice before it is stored (GRID-01).
 */
import * as Y from 'yjs';

import { cellKey, newId, type Id } from '../ids.js';
import { snapPoint, snapSizeToUnits, type LatticeUnits, type Pixels } from '../lattice.js';
import {
  cellsMap,
  columnsArray,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  fragmentText,
  isFormula,
  listSheets,
  readString,
  rowMetaMap,
  rowsArray,
  tableMap,
  tablesOnSheet,
  textFragment,
  type ColumnMap,
  type GedeDoc,
  type RowMetaMap,
  type SheetMap,
  type TableMap,
} from './schema.js';

function transact<T>(gd: GedeDoc, fn: () => T): T {
  let out!: T;
  gd.doc.transact(() => {
    out = fn();
  }, gd.origin);
  return out;
}

function requireTable(gd: GedeDoc, tableId: Id): TableMap {
  const table = tableMap(gd, tableId);
  if (table === null) throw new RangeError(`no table ${tableId}`);
  return table;
}

// ---------------------------------------------------------------------------
// Document meta
// ---------------------------------------------------------------------------

export function setTitle(gd: GedeDoc, title: string): void {
  transact(gd, () => {
    gd.meta.set('title', title);
  });
}

/**
 * Seed `meta` from the server record the first time a document opens, without
 * touching the undo stack. No-op when the document already carries a title.
 */
export function seedMeta(gd: GedeDoc, seed: { title: string; createdAt?: string }): void {
  gd.doc.transact(() => {
    if (readString(gd.meta, 'title') === '') gd.meta.set('title', seed.title);
    if (gd.meta.get('createdAt') === undefined) {
      gd.meta.set('createdAt', seed.createdAt ?? new Date().toISOString());
    }
  }, 'seed');
}

// ---------------------------------------------------------------------------
// Sheets (DOC-03)
// ---------------------------------------------------------------------------

export function createSheet(
  gd: GedeDoc,
  options: { label?: string | undefined; parentContext?: string | null | undefined } = {},
): Id {
  return transact(gd, () => {
    const id = newId();
    const ordinal = gd.sheets.length + 1;
    const map: SheetMap = new Y.Map<unknown>();
    map.set('id', id);
    map.set('label', options.label ?? `Sheet ${ordinal}`);
    map.set('ordinal', ordinal);
    map.set('parentContext', options.parentContext ?? null);
    gd.sheets.push([map]);
    return id;
  });
}

export function renameSheet(gd: GedeDoc, sheetId: Id, label: string): void {
  transact(gd, () => {
    const map = gd.sheets.toArray().find((s) => readString(s, 'id') === sheetId);
    map?.set('label', label);
  });
}

/**
 * A document must always have a sheet; call this once the replica has synced
 * (never on a cold, empty doc — two clients would each add one). Returns the
 * first sheet's id. Seeding is not an undo step.
 */
export function ensureFirstSheet(gd: GedeDoc): Id {
  const existing = listSheets(gd)[0];
  if (existing !== undefined) return existing.id;
  let id = '';
  gd.doc.transact(() => {
    id = newId();
    const map: SheetMap = new Y.Map<unknown>();
    map.set('id', id);
    map.set('label', 'Sheet 1');
    map.set('ordinal', 1);
    map.set('parentContext', null);
    gd.sheets.push([map]);
  }, 'seed');
  return id;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface CreateTableOptions {
  sheetId: Id;
  /** Lattice origin as units, or as pixels at zoom 1 (snapped, GRID-01). */
  at: LatticeUnits | Pixels;
  columns?: number;
  rows?: number;
  title?: string;
}

function isPixels(at: LatticeUnits | Pixels): at is Pixels {
  return 'x' in at;
}

/** Whole, non-negative lattice units; NaN or ±Infinity must never reach the map (GRID-01). */
function snapUnits(at: LatticeUnits): LatticeUnits {
  if (!Number.isFinite(at.col) || !Number.isFinite(at.row)) {
    throw new RangeError(`lattice units must be finite, got ${String(at.col)},${String(at.row)}`);
  }
  return { col: Math.max(0, Math.round(at.col)), row: Math.max(0, Math.round(at.row)) };
}

/** A prelim column map cannot be read back until integrated, so the id is returned alongside it. */
function newColumn(label: string): { id: Id; map: ColumnMap } {
  const id = newId();
  const map: ColumnMap = new Y.Map<unknown>();
  map.set('id', id);
  map.set('label', label);
  map.set('width', DEFAULT_COLUMN_WIDTH);
  return { id, map };
}

/** A table at a lattice position with N columns and M empty rows. */
export function createTable(gd: GedeDoc, options: CreateTableOptions): Id {
  const columnCount = Math.max(1, Math.round(options.columns ?? 3));
  const rowCount = Math.max(0, Math.round(options.rows ?? 5));
  const origin = isPixels(options.at) ? snapPoint(options.at) : snapUnits(options.at);
  return transact(gd, () => {
    const id = newId();
    const map: TableMap = new Y.Map<unknown>();
    map.set('id', id);
    map.set('sheetId', options.sheetId);
    map.set(
      'title',
      options.title ?? `Table ${String(tablesOnSheet(gd, options.sheetId).length + 1)}`,
    );
    map.set('gridCol', origin.col);
    map.set('gridRow', origin.row);
    const columns = new Y.Array<ColumnMap>();
    columns.push(
      Array.from({ length: columnCount }, (_, i) => newColumn(`Column ${String(i + 1)}`).map),
    );
    map.set('columns', columns);
    const rows = new Y.Array<Id>();
    rows.push(Array.from({ length: rowCount }, () => newId()));
    map.set('rows', rows);
    map.set('cells', new Y.Map<unknown>());
    map.set('rowMeta', new Y.Map<RowMetaMap>());
    gd.tables.set(id, map);
    return id;
  });
}

export function setTableTitle(gd: GedeDoc, tableId: Id, title: string): void {
  transact(gd, () => {
    requireTable(gd, tableId).set('title', title);
  });
}

/** Move a table; pixels snap to the lattice, units clamp at A1 (GRID-01, DOC-04). */
export function setTablePosition(gd: GedeDoc, tableId: Id, at: LatticeUnits | Pixels): void {
  const origin = isPixels(at) ? snapPoint(at) : snapUnits(at);
  transact(gd, () => {
    const table = requireTable(gd, tableId);
    table.set('gridCol', origin.col);
    table.set('gridRow', origin.row);
  });
}

/** Append a row (or insert after `afterRowId`). Returns the new row id (GRID-07). */
export function addRow(gd: GedeDoc, tableId: Id, afterRowId?: Id): Id {
  return transact(gd, () => {
    const rows = rowsArray(requireTable(gd, tableId));
    const id = newId();
    const after = afterRowId === undefined ? -1 : rows.toArray().indexOf(afterRowId);
    rows.insert(after < 0 ? rows.length : after + 1, [id]);
    return id;
  });
}

/** Append a column (or insert after `afterColId`). Returns the new column id (GRID-07). */
export function addColumn(
  gd: GedeDoc,
  tableId: Id,
  options: { label?: string | undefined; afterColId?: Id | undefined } = {},
): Id {
  return transact(gd, () => {
    const columns = columnsArray(requireTable(gd, tableId));
    const { id, map: column } = newColumn(options.label ?? `Column ${String(columns.length + 1)}`);
    const after =
      options.afterColId === undefined
        ? -1
        : columns.toArray().findIndex((c) => readString(c, 'id') === options.afterColId);
    columns.insert(after < 0 ? columns.length : after + 1, [column]);
    return id;
  });
}

/** Column width from pixels, snapped to whole units and never below one (GRID-01, GRID-08). */
export function resizeColumn(gd: GedeDoc, tableId: Id, colId: Id, widthPx: number): number {
  const units = snapSizeToUnits(widthPx, 'col');
  transact(gd, () => {
    const column = columnsArray(requireTable(gd, tableId))
      .toArray()
      .find((c) => readString(c, 'id') === colId);
    if (column === undefined) throw new RangeError(`no column ${colId} in ${tableId}`);
    column.set('width', units);
  });
  return units;
}

function metaFor(table: TableMap, rowId: Id): RowMetaMap {
  const metas = rowMetaMap(table);
  let meta = metas.get(rowId);
  if (meta === undefined) {
    meta = new Y.Map<unknown>();
    meta.set('depth', 0);
    meta.set('collapsed', false);
    meta.set('height', DEFAULT_ROW_HEIGHT);
    metas.set(rowId, meta);
  }
  return meta;
}

/** A wrapped row occupies two lattice rows so addressing stays exact (GRID-09). */
export function setRowWrapped(gd: GedeDoc, tableId: Id, rowId: Id, wrapped: boolean): void {
  transact(gd, () => {
    metaFor(requireTable(gd, tableId), rowId).set('height', wrapped ? 2 : DEFAULT_ROW_HEIGHT);
  });
}

export function setRowDepth(gd: GedeDoc, tableId: Id, rowId: Id, depth: number): void {
  transact(gd, () => {
    metaFor(requireTable(gd, tableId), rowId).set('depth', Math.max(0, Math.round(depth)));
  });
}

/**
 * Write a cell. Text starting with `=` is stored as a formula string; anything
 * else becomes a paragraph fragment; an empty string clears the cell. The
 * fragment is replaced whole — character-level merging is the ProseMirror
 * binding's job in Wave 2.
 */
export function setCellText(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id, text: string): void {
  transact(gd, () => {
    const cells = cellsMap(requireTable(gd, tableId));
    const key = cellKey(rowId, colId);
    if (text === '') {
      cells.delete(key);
      return;
    }
    const current = cells.get(key);
    if (text.startsWith('=')) {
      if (current !== text) cells.set(key, text);
      return;
    }
    // An unchanged commit must not churn the CRDT (or drop marks the text already carries).
    if (current !== undefined && !isFormula(current) && fragmentText(current) === text) return;
    cells.set(key, textFragment(text));
  });
}

export function clearCell(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): void {
  setCellText(gd, tableId, rowId, colId, '');
}

export function deleteTable(gd: GedeDoc, tableId: Id): void {
  transact(gd, () => {
    gd.tables.delete(tableId);
  });
}
