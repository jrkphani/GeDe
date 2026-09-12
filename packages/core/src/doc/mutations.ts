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
  objectCount,
  readNumber,
  readString,
  rowMetaMap,
  rowsArray,
  tableMap,
  tableRecord,
  tablesOnSheet,
  textFragment,
  WRAPPED_ROW_HEIGHT,
  type ColumnMap,
  type GedeDoc,
  type RowMetaMap,
  type SheetMap,
  type StripCount,
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
 * Reconcile `meta` with the server record on open, without touching the undo
 * stack. The record's title is the source of truth (the library and the
 * document must agree), so a differing `meta.title` is overwritten;
 * `createdAt` is only filled in when missing. Nothing is written when
 * everything already matches.
 */
export function seedMeta(gd: GedeDoc, seed: { title: string; createdAt?: string }): void {
  const titleDiffers = readString(gd.meta, 'title') !== seed.title;
  const createdMissing = gd.meta.get('createdAt') === undefined;
  if (!titleDiffers && !createdMissing) return;
  gd.doc.transact(() => {
    if (titleDiffers) gd.meta.set('title', seed.title);
    if (createdMissing) gd.meta.set('createdAt', seed.createdAt ?? new Date().toISOString());
  }, SEED_ORIGIN);
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
    const map: SheetMap = new Y.Map<unknown>();
    map.set('id', id);
    map.set('label', options.label ?? `Sheet ${String(gd.sheets.length + 1)}`);
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

/** Transaction origin for client-side seeding; never tracked by undo. */
export const SEED_ORIGIN = 'seed';

/** True when nobody has ever written to this document: no client in the struct store. */
export function isDocEmpty(doc: Y.Doc): boolean {
  return doc.store.clients.size === 0;
}

/**
 * A document must always have a sheet. Call this only once the replica has
 * synced and the store is still empty (`isDocEmpty`); the sheet is tagged
 * `seeded` so `dedupeSeededSheets` can collapse the duplicates two clients
 * produce when they both open an empty document offline. Returns the first
 * sheet's id. Seeding is not an undo step.
 *
 * TODO(Wave 2, services/sync): `POST /api/documents` should seed the initial
 * room state server-side so the client never has to.
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
    map.set('parentContext', null);
    map.set('seeded', true);
    gd.sheets.push([map]);
  }, SEED_ORIGIN);
  return id;
}

/**
 * After a merge, keep exactly one seeded sheet: the lowest id (earliest ULID)
 * wins; other seeded sheets that hold no objects are removed. A seeded sheet
 * someone already used stays — nothing a person made is discarded. Returns
 * the ids removed.
 */
export function dedupeSeededSheets(gd: GedeDoc): Id[] {
  const sheets = listSheets(gd);
  const seeded = sheets.filter((s) => s.seeded);
  if (seeded.length < 2) return [];
  const keep = seeded.reduce((a, b) => (b.id < a.id ? b : a));
  const removable = seeded.filter((s) => s.id !== keep.id && objectCount(gd, s.id) === 0);
  if (removable.length === 0) return [];
  gd.doc.transact(() => {
    for (const s of removable) {
      const index = gd.sheets.toArray().findIndex((m) => readString(m, 'id') === s.id);
      if (index >= 0) gd.sheets.delete(index, 1);
    }
  }, SEED_ORIGIN);
  return removable.map((s) => s.id);
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

/** Insert a row above `beforeRowId` (PRD §17 "Add row above"). Returns the new row id. */
export function insertRowBefore(gd: GedeDoc, tableId: Id, beforeRowId: Id): Id {
  return transact(gd, () => {
    const rows = rowsArray(requireTable(gd, tableId));
    const id = newId();
    const before = rows.toArray().indexOf(beforeRowId);
    rows.insert(before < 0 ? 0 : before, [id]);
    return id;
  });
}

function columnIndexOf(columns: Y.Array<ColumnMap>, colId: Id): number {
  return columns.toArray().findIndex((c) => readString(c, 'id') === colId);
}

function requireColumn(table: TableMap, tableId: Id, colId: Id): ColumnMap {
  const column = columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
  if (column === undefined) throw new RangeError(`no column ${colId} in ${tableId}`);
  return column;
}

/**
 * Append a column, or insert after `afterColId` / before `beforeColId`
 * (`beforeColId` wins when both are given). Returns the new column id (GRID-07).
 */
export function addColumn(
  gd: GedeDoc,
  tableId: Id,
  options: {
    label?: string | undefined;
    afterColId?: Id | undefined;
    beforeColId?: Id | undefined;
  } = {},
): Id {
  return transact(gd, () => {
    const columns = columnsArray(requireTable(gd, tableId));
    const { id, map: column } = newColumn(options.label ?? `Column ${String(columns.length + 1)}`);
    let index = columns.length;
    if (options.beforeColId !== undefined) {
      const before = columnIndexOf(columns, options.beforeColId);
      index = before < 0 ? 0 : before;
    } else if (options.afterColId !== undefined) {
      const after = columnIndexOf(columns, options.afterColId);
      index = after < 0 ? columns.length : after + 1;
    }
    columns.insert(index, [column]);
    return id;
  });
}

/** Delete every cell matching `predicate`; called inside a transaction. */
function deleteCells(table: TableMap, predicate: (key: string) => boolean): void {
  const cells = cellsMap(table);
  const doomed: string[] = [];
  cells.forEach((_value, key) => {
    if (predicate(key)) doomed.push(key);
  });
  for (const key of doomed) cells.delete(key);
}

/**
 * Delete a row with its cells and meta; the rows below recompute their
 * addresses (GRID-02). Returns false when the row is not in the table — a
 * concurrent delete already removed it, which is not an error.
 */
export function deleteRow(gd: GedeDoc, tableId: Id, rowId: Id): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table);
    const index = rows.toArray().indexOf(rowId);
    if (index < 0) return false;
    rows.delete(index, 1);
    rowMetaMap(table).delete(rowId);
    deleteCells(table, (key) => key.startsWith(`${rowId}:`));
    return true;
  });
}

/**
 * Delete a column with its cells (GRID-02). The frozen count shrinks with the
 * table so it never exceeds the columns that remain. Returns false when the
 * column is already gone.
 */
export function deleteColumn(gd: GedeDoc, tableId: Id, colId: Id): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const columns = columnsArray(table);
    const index = columnIndexOf(columns, colId);
    if (index < 0) return false;
    columns.delete(index, 1);
    deleteCells(table, (key) => key.endsWith(`:${colId}`));
    if (tableRecord(table).frozenColumns > columns.length) {
      table.set('frozenColumns', columns.length);
    }
    return true;
  });
}

/** Hide or show a column. Hidden keeps its data and width but has no lattice presence (GRID-02). */
export function setColumnHidden(gd: GedeDoc, tableId: Id, colId: Id, hidden: boolean): void {
  transact(gd, () => {
    requireColumn(requireTable(gd, tableId), tableId, colId).set('hidden', hidden);
  });
}

export function hideColumn(gd: GedeDoc, tableId: Id, colId: Id): void {
  setColumnHidden(gd, tableId, colId, true);
}

export function unhideColumn(gd: GedeDoc, tableId: Id, colId: Id): void {
  setColumnHidden(gd, tableId, colId, false);
}

/** Show every hidden column of a table in one undo step. Returns the ids revealed. */
export function unhideAllColumns(gd: GedeDoc, tableId: Id): Id[] {
  return transact(gd, () => {
    const revealed: Id[] = [];
    for (const column of columnsArray(requireTable(gd, tableId)).toArray()) {
      if (column.get('hidden') === true) {
        column.set('hidden', false);
        revealed.push(readString(column, 'id'));
      }
    }
    return revealed;
  });
}

/** Wrap every cell of a column; the table's rows become two lattice units (GRID-09). */
export function setColumnWrap(gd: GedeDoc, tableId: Id, colId: Id, wrap: boolean): void {
  transact(gd, () => {
    requireColumn(requireTable(gd, tableId), tableId, colId).set('wrap', wrap);
  });
}

/** Whole, finite, at least one lattice unit (GRID-01, GRID-08). */
function snapWidthUnits(units: number): number {
  if (!Number.isFinite(units)) {
    throw new RangeError(`width must be a finite number of units, got ${String(units)}`);
  }
  return Math.max(1, Math.round(units));
}

/** Column width in whole lattice units, never below one — the keyboard route to resize (GRID-08). */
export function setColumnWidth(gd: GedeDoc, tableId: Id, colId: Id, units: number): number {
  const width = snapWidthUnits(units);
  transact(gd, () => {
    const column = requireColumn(requireTable(gd, tableId), tableId, colId);
    if (column.get('width') !== width) column.set('width', width);
  });
  return width;
}

/** Column width from pixels, snapped to whole units and never below one (GRID-01, GRID-08). */
export function resizeColumn(gd: GedeDoc, tableId: Id, colId: Id, widthPx: number): number {
  return setColumnWidth(gd, tableId, colId, snapSizeToUnits(widthPx, 'col'));
}

/**
 * Share `total` whole units across `sizes` in proportion: every share at least
 * one unit, the sum exactly `max(total, sizes.length)`, remainders to the
 * largest fractions first. The corner handle uses it so scaling a table keeps
 * every column on the lattice (GRID-08).
 */
export function distributeUnits(sizes: readonly number[], total: number): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const target = Math.max(n, Math.round(total));
  const current = sizes.reduce((a, b) => a + b, 0);
  const exact = sizes.map((w) => (current > 0 ? (w / current) * target : target / n));
  const shares = exact.map((x) => Math.max(1, Math.floor(x)));
  let remaining = target - shares.reduce((a, b) => a + b, 0);
  // Floors of one can overshoot: take from the widest until the sum fits.
  while (remaining < 0) {
    const widest = shares.indexOf(Math.max(...shares));
    if ((shares[widest] ?? 1) <= 1) break;
    shares[widest] = (shares[widest] ?? 1) - 1;
    remaining += 1;
  }
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remaining > 0; k += 1, remaining -= 1) {
    const slot = order[k % n];
    if (slot === undefined) break;
    shares[slot.i] = (shares[slot.i] ?? 1) + 1;
  }
  return shares;
}

export interface ScaleTableOptions {
  /** New total width of the visible columns in units, shared out proportionally. */
  widthUnits?: number | undefined;
  /** Every row wrapped (two units) or compact (one) — the only heights the lattice allows (GRID-09). */
  wrapped?: boolean | undefined;
}

/**
 * The corner handle (GRID-08): scale the whole table on the lattice. Width is
 * distributed across the visible columns, each a whole unit and at least one;
 * height snaps to the two row heights the lattice allows. One undo step.
 * Returns the visible columns' widths after the call, in column order.
 */
export function scaleTable(gd: GedeDoc, tableId: Id, options: ScaleTableOptions): number[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const visible = columnsArray(table)
      .toArray()
      .filter((c) => c.get('hidden') !== true);
    let widths = visible.map((c) => Math.max(1, Math.round(readNumber(c, 'width', 1))));
    if (options.widthUnits !== undefined) {
      widths = distributeUnits(widths, snapWidthUnits(options.widthUnits));
      visible.forEach((column, i) => {
        const width = widths[i] ?? 1;
        if (column.get('width') !== width) column.set('width', width);
      });
    }
    if (options.wrapped !== undefined) {
      const height = options.wrapped ? WRAPPED_ROW_HEIGHT : DEFAULT_ROW_HEIGHT;
      for (const rowId of rowsArray(table).toArray()) setRowHeight(table, rowId, height);
    }
    return widths;
  });
}

/** Leading frozen columns, clamped to the table (GRID-10). Returns the count stored. */
export function setFrozenColumns(gd: GedeDoc, tableId: Id, count: number): number {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const max = columnsArray(table).length;
    const frozen = Math.min(max, Math.max(0, Math.round(Number.isFinite(count) ? count : 0)));
    if (tableRecord(table).frozenColumns !== frozen) table.set('frozenColumns', frozen);
    return frozen;
  });
}

/** Show or hide the column-header row (GRID-11). Data addresses move with it. */
export function setHeaderRows(gd: GedeDoc, tableId: Id, count: StripCount): void {
  transact(gd, () => {
    requireTable(gd, tableId).set('headerRows', count);
  });
}

/** Show or hide the footer count strip beneath the last row (GRID-11). */
export function setFooterRows(gd: GedeDoc, tableId: Id, count: StripCount): void {
  transact(gd, () => {
    requireTable(gd, tableId).set('footerRows', count);
  });
}

/**
 * Store a row height, writing nothing when it already reads that way — a row
 * with no meta is one unit, so setting one unit there is not a write and not
 * an undo step.
 */
function setRowHeight(table: TableMap, rowId: Id, height: number): void {
  const existing = rowMetaMap(table).get(rowId);
  if (existing === undefined) {
    if (height === DEFAULT_ROW_HEIGHT) return;
    metaFor(table, rowId).set('height', height);
    return;
  }
  if (existing.get('height') !== height) existing.set('height', height);
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
    setRowHeight(
      requireTable(gd, tableId),
      rowId,
      wrapped ? WRAPPED_ROW_HEIGHT : DEFAULT_ROW_HEIGHT,
    );
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
