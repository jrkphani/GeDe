/**
 * Mutation helpers. Every write runs inside `doc.transact(fn, gd.origin)` so
 * one user gesture is one undo step and one sync message, and every position
 * or size snaps to the lattice before it is stored (GRID-01).
 */
import * as Y from 'yjs';

import { effectiveDepths, hasDescendants } from '../hier/outline.js';
import { rowHidden } from './geometry.js';
import { cellKey, newId, splitCellKey, type Id } from '../ids.js';
import { snapPoint, snapSizeToUnits, type LatticeUnits, type Pixels } from '../lattice.js';
import {
  cellsMap,
  columnsArray,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  fragmentText,
  isFormula,
  LEGACY_WRAPPED_ROW_HEIGHT,
  listSheets,
  objectCount,
  readNumber,
  readString,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableMap,
  tableRecord,
  tablesOnSheet,
  textFragment,
  type ColumnMap,
  type GedeDoc,
  type RowMetaMap,
  type SheetMap,
  type StripCount,
  type TableMap,
} from './schema.js';
import { firstSheetMap, SEED_ORIGIN } from './seed.js';

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

/**
 * The default name for a new sheet: `Sheet N` for the first N, counting from
 * one past the sheet count, that no sheet already carries. After a delete the
 * count alone would repeat a name that is still in the strip (ADR-048).
 */
function nextSheetLabel(gd: GedeDoc): string {
  const taken = new Set(listSheets(gd).map((s) => s.label));
  for (let n = gd.sheets.length + 1; ; n += 1) {
    const label = `Sheet ${String(n)}`;
    if (!taken.has(label)) return label;
  }
}

/** A sheet appended at the end of the strip (DOC-03). */
export function createSheet(
  gd: GedeDoc,
  options: { label?: string | undefined; parentContext?: string | null | undefined } = {},
): Id {
  return transact(gd, () => {
    const id = newId();
    const map: SheetMap = new Y.Map<unknown>();
    map.set('id', id);
    map.set('label', options.label ?? nextSheetLabel(gd));
    map.set('parentContext', options.parentContext ?? null);
    gd.sheets.push([map]);
    return id;
  });
}

/**
 * Rename a sheet (ADR-048). The label is trimmed; an empty name is refused
 * and an unchanged one writes nothing, so neither is an undo step. Returns
 * whether the label was written.
 */
export function renameSheet(gd: GedeDoc, sheetId: Id, label: string): boolean {
  const trimmed = label.trim();
  if (trimmed === '') return false;
  return transact(gd, () => {
    const map = gd.sheets.toArray().find((s) => readString(s, 'id') === sheetId);
    if (map === undefined || readString(map, 'label') === trimmed) return false;
    map.set('label', trimmed);
    return true;
  });
}

/** True when nobody has ever written to this document: no client in the struct store. */
export function isDocEmpty(doc: Y.Doc): boolean {
  return doc.store.clients.size === 0;
}

/**
 * A document must always have a sheet. Since Wave 2 the server seeds every
 * new document (`seedNewDocument` in `seed.ts`, written as snapshot seq 1 by
 * `POST /api/documents`), so a synced replica is never empty and this is a
 * no-op. It remains for documents created before that change and for a
 * replica that synced against an empty room: the sheet is the same shape
 * the server writes, tagged `seeded` so `dedupeSeededSheets` can collapse
 * the duplicates two offline first-openers produce. Returns the first
 * sheet's id. Seeding is not an undo step.
 */
export function ensureFirstSheet(gd: GedeDoc): Id {
  const existing = listSheets(gd)[0];
  if (existing !== undefined) return existing.id;
  const sheet = firstSheetMap();
  gd.doc.transact(() => {
    gd.sheets.push([sheet.map]);
  }, SEED_ORIGIN);
  return sheet.id;
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
export function newColumn(label: string): { id: Id; map: ColumnMap } {
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
    const rowIds = Array.from({ length: rowCount }, () => newId());
    const rows = new Y.Array<Id>();
    rows.push(rowIds);
    map.set('rows', rows);
    map.set('cells', new Y.Map<unknown>());
    const metas = new Y.Map<RowMetaMap>();
    for (const rowId of rowIds) metas.set(rowId, newRowMeta());
    map.set('rowMeta', metas);
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

/**
 * A row's meta map with the defaults every reader assumes. Created with the row
 * (`createTable`, `addRow`, `insertRowBefore`) rather than on first write: two
 * replicas that first write different keys of the same row while apart (one
 * nests it, the other wraps it) would each create their own nested map, and
 * Yjs keeps one of them — the other replica's write would be lost. A map that
 * exists from the row's birth takes both writes.
 */
function newRowMeta(): RowMetaMap {
  const meta: RowMetaMap = new Y.Map<unknown>();
  meta.set('depth', 0);
  meta.set('collapsed', false);
  meta.set('height', DEFAULT_ROW_HEIGHT);
  return meta;
}

/**
 * HIER-06: `collapsed` means something only on a row with descendants. Call it
 * inside the transaction of any structural change that can leave a row
 * childless — a delete, a promote, a row inserted directly under a collapsed
 * parent — so the flag does not linger to hide the next subtree that forms
 * there. Reads effective depths (HIER-02); writes only where the flag is set.
 */
export function settleCollapsed(table: TableMap): void {
  const rows = rowsArray(table).toArray();
  const metas = rowMetaMap(table);
  const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
  rows.forEach((id, i) => {
    const meta = metas.get(id);
    if (meta?.get('collapsed') === true && !hasDescendants(depths, i)) meta.set('collapsed', false);
  });
}

/** Append a row (or insert after `afterRowId`). Returns the new row id (GRID-07). */
export function addRow(gd: GedeDoc, tableId: Id, afterRowId?: Id): Id {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table);
    const id = newId();
    const after = afterRowId === undefined ? -1 : rows.toArray().indexOf(afterRowId);
    rows.insert(after < 0 ? rows.length : after + 1, [id]);
    rowMetaMap(table).set(id, newRowMeta());
    settleCollapsed(table);
    return id;
  });
}

/** Insert a row above `beforeRowId` (PRD §17 "Add row above"). Returns the new row id. */
export function insertRowBefore(gd: GedeDoc, tableId: Id, beforeRowId: Id): Id {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table);
    const id = newId();
    const before = rows.toArray().indexOf(beforeRowId);
    rows.insert(before < 0 ? 0 : before, [id]);
    rowMetaMap(table).set(id, newRowMeta());
    settleCollapsed(table);
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
    settleCollapsed(table);
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

/**
 * Column-scope wrap (GRID-09, ADR-049): `true` wraps every cell of the column,
 * `false` clips them, `null` lets them follow the table. No height is written
 * here — the editing replica measures the rows and stores what they need.
 */
export function setColumnWrap(gd: GedeDoc, tableId: Id, colId: Id, wrap: boolean | null): void {
  transact(gd, () => {
    const column = requireColumn(requireTable(gd, tableId), tableId, colId);
    if (wrap === null) column.delete('wrap');
    else if (column.get('wrap') !== wrap) column.set('wrap', wrap);
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

/**
 * Several columns' widths in one transaction (GRID-08, ADR-049): a drag on one
 * divider of a selected band resizes every member, and the fit of a whole
 * table lands as one undo step. Returns what was stored, in the given order.
 */
export function setColumnWidths(
  gd: GedeDoc,
  tableId: Id,
  widths: readonly { readonly colId: Id; readonly units: number }[],
): number[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    return widths.map(({ colId, units }) => {
      const width = snapWidthUnits(units);
      const column = requireColumn(table, tableId, colId);
      if (column.get('width') !== width) column.set('width', width);
      return width;
    });
  });
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
  /**
   * New total height of the visible rows in units, shared out proportionally
   * (ADR-049: Numbers' table handle scales every row); each row lands on a
   * whole unit, at least one, and reads as set by hand.
   */
  heightUnits?: number | undefined;
}

/**
 * The corner handle (GRID-08): scale the whole table on the lattice. Width is
 * distributed across the visible columns and height across the visible rows,
 * each a whole unit and at least one. One undo step. Returns the visible
 * columns' widths after the call, in column order.
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
    if (options.heightUnits !== undefined) {
      const record = tableRecord(table);
      const hidden = rowHidden(table, record);
      const shown = record.rows.filter((_id, i) => hidden[i] !== true);
      const heights = distributeUnits(
        shown.map((rowId) => rowMeta(table, rowId).height),
        snapWidthUnits(options.heightUnits),
      );
      shown.forEach((rowId, i) => {
        writeRowHeight(table, rowId, heights[i] ?? 1, 'manual');
      });
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
 * How a height came to be (ADR-049, R-B): `manual` is a person's — a drag,
 * the Height field, the corner — and turns `fit` off, so the row keeps it;
 * `auto` is the editing replica's measurement, written only while the row
 * follows its content; `fit` is Fit to content, which turns `fit` back on
 * and stores the measured height.
 */
export type RowHeightMode = 'manual' | 'auto' | 'fit';

/**
 * Store a row height inside the caller's transaction, writing nothing that
 * already reads that way — a row with no meta is one unit and follows its
 * content, so writing exactly that is not a write and not an undo step. An
 * `auto` write on a row that does not follow its content is refused (the
 * height stays). `fit` is written beside any height past one so a reader can
 * tell an ADR-049 row from a legacy two-unit wrapped one. Returns the height
 * the row now has.
 */
export function writeRowHeight(
  table: TableMap,
  rowId: Id,
  units: number,
  mode: RowHeightMode,
): number {
  const existing = rowMetaMap(table).get(rowId);
  const current = existing === undefined ? null : rowMeta(table, rowId);
  if (mode === 'auto' && current !== null && !current.fit) return current.height;
  const height = snapWidthUnits(units);
  const fit = mode !== 'manual';
  if (existing === undefined) {
    if (height === DEFAULT_ROW_HEIGHT && fit) return height;
    const meta = rowMetaFor(table, rowId);
    meta.set('height', height);
    meta.set('fit', fit);
    return height;
  }
  if (existing.get('height') !== height) existing.set('height', height);
  const stored = existing.get('fit');
  // A meta with neither `fit` nor `wrap` and a height past one reads as a legacy wrapped
  // row (`rowMeta`); a measured or fitted height landing there writes `fit` so the row
  // does not start reading as wrapped at row scope.
  const legacyMarker =
    stored === undefined &&
    existing.get('wrap') === undefined &&
    height >= LEGACY_WRAPPED_ROW_HEIGHT;
  if ((stored ?? true) !== fit || legacyMarker) existing.set('fit', fit);
  return height;
}

/**
 * Distribute evenly (ADR-049, Numbers' Table › Distribute Rows / Columns
 * Evenly): the selected rows or columns — or every visible one — share
 * their current total in whole units, the remainder to the first ones. Rows
 * then read as set by hand (`fit` off), as after a drag. One undo step.
 * Returns the sizes stored, in table order.
 */
export function distributeEvenly(
  gd: GedeDoc,
  tableId: Id,
  axis: 'row' | 'column',
  only?: readonly Id[],
): number[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const record = tableRecord(table);
    if (axis === 'column') {
      const columns = columnsArray(table)
        .toArray()
        .filter((c) => c.get('hidden') !== true)
        .filter((c) => only === undefined || only.includes(readString(c, 'id')));
      const widths = columns.map((c) => Math.max(1, Math.round(readNumber(c, 'width', 1))));
      const even = evenShares(widths);
      columns.forEach((column, i) => {
        if (column.get('width') !== even[i]) column.set('width', even[i]);
      });
      return even;
    }
    const hidden = rowHidden(table, record);
    const rows = record.rows
      .filter((_id, i) => hidden[i] !== true)
      .filter((id) => only === undefined || only.includes(id));
    const even = evenShares(rows.map((rowId) => rowMeta(table, rowId).height));
    rows.forEach((rowId, i) => {
      writeRowHeight(table, rowId, even[i] ?? 1, 'manual');
    });
    return even;
  });
}

/** `sizes.length` whole shares of the sizes' total, the remainder to the first ones. */
export function evenShares(sizes: readonly number[]): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const total = sizes.reduce((a, b) => a + b, 0);
  const base = Math.max(1, Math.floor(total / n));
  const remainder = Math.max(0, total - base * n);
  return sizes.map((_s, i) => base + (i < remainder ? 1 : 0));
}

/**
 * One row's height in whole units (GRID-09, ADR-049): the keyboard route on a
 * focused row divider, and every other single-row write. One undo step.
 */
export function setRowHeight(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  units: number,
  mode: RowHeightMode = 'manual',
): number {
  return transact(gd, () => writeRowHeight(requireTable(gd, tableId), rowId, units, mode));
}

/**
 * Several rows' heights in one transaction: a drag on one divider of a
 * selected band, a fit of the whole table, the editing replica's auto-fit of
 * the rows an edit touched. Returns the heights stored, in the given order.
 */
export function setRowHeights(
  gd: GedeDoc,
  tableId: Id,
  heights: readonly { readonly rowId: Id; readonly units: number }[],
  mode: RowHeightMode = 'manual',
): number[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    return heights.map(({ rowId, units }) => writeRowHeight(table, rowId, units, mode));
  });
}

/**
 * The row's meta map. Rows created since Wave 3 carry one from birth (see
 * `newRowMeta`); for older rows it is created here, inside the caller's
 * transaction, on first write. A row with no meta reads as depth 0, expanded,
 * one unit (`rowMeta` in `schema.ts`), so creating one is never itself a change.
 */
export function rowMetaFor(table: TableMap, rowId: Id): RowMetaMap {
  const metas = rowMetaMap(table);
  let meta = metas.get(rowId);
  if (meta === undefined) {
    meta = newRowMeta();
    metas.set(rowId, meta);
  }
  return meta;
}

/**
 * Row-scope wrap (GRID-09, ADR-049): `true` wraps every cell of the row,
 * `false` clips them, `null` lets them follow their columns. Writes no height;
 * the editing replica measures and stores what the row then needs.
 */
export function setRowWrap(gd: GedeDoc, tableId: Id, rowId: Id, wrap: boolean | null): void {
  transact(gd, () => {
    const table = requireTable(gd, tableId);
    if (rowMetaMap(table).get(rowId) === undefined && wrap === null) return;
    const meta = rowMetaFor(table, rowId);
    if (wrap === null) {
      if (meta.get('wrap') !== undefined) meta.delete('wrap');
      return;
    }
    // A legacy two-unit row reads wrapped from its height alone; writing `fit` beside
    // `wrap` makes the state explicit, so the reader's legacy rule no longer applies.
    if (meta.get('fit') === undefined) meta.set('fit', true);
    if (meta.get('wrap') !== wrap) meta.set('wrap', wrap);
  });
}

/**
 * Raw depth write, unvalidated: what the projection and fixtures use. The
 * user path is `nestRow` / `promoteRow` in `hier/mutations.ts`, which enforce
 * HIER-02 and move the subtree with the row.
 */
export function setRowDepth(gd: GedeDoc, tableId: Id, rowId: Id, depth: number): void {
  transact(gd, () => {
    rowMetaFor(requireTable(gd, tableId), rowId).set('depth', Math.max(0, Math.round(depth)));
  });
}

/**
 * Write a cell. Text starting with `=` is stored as a formula string; anything
 * else becomes a paragraph fragment; an empty string clears the cell. The
 * fragment is replaced whole — character-level merging is the ProseMirror
 * binding's job in Wave 2.
 */
export function setCellText(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id, text: string): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    // The row or column may have gone since the editor opened (a collaborator deleted it,
    // GRID-02); writing then would leave a cell keyed to nothing. Checked in the same
    // transaction as the write so nothing can slip between.
    if (!rowsArray(table).toArray().includes(rowId)) return false;
    if (columnIndexOf(columnsArray(table), colId) < 0) return false;
    const cells = cellsMap(table);
    const key = cellKey(rowId, colId);
    if (text === '') {
      cells.delete(key);
      return true;
    }
    const current = cells.get(key);
    if (text.startsWith('=')) {
      if (current !== text) cells.set(key, text);
      return true;
    }
    // An unchanged commit must not churn the CRDT (or drop marks the text already carries).
    if (current !== undefined && !isFormula(current) && fragmentText(current) === text) return true;
    cells.set(key, textFragment(text));
    return true;
  });
}

export function clearCell(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): boolean {
  return setCellText(gd, tableId, rowId, colId, '');
}

/** Transaction origin for garbage collection; never tracked by undo — nothing a person did. */
export const SWEEP_ORIGIN = 'sweep';

/**
 * Cell keys whose row or column is no longer in the table. They arise only from a
 * merge: one replica deleted a row while another, offline, wrote into it
 * (`deleteRow` removes the cells it can see; the write merges in afterwards).
 * Addresses never see them (they are computed from `rows` and `columns`), but
 * the document would carry them forever.
 */
export function orphanCellKeys(table: TableMap): string[] {
  const rows = new Set(rowsArray(table).toArray());
  const columns = new Set(
    columnsArray(table)
      .toArray()
      .map((c) => readString(c, 'id')),
  );
  const orphans: string[] = [];
  cellsMap(table).forEach((_value, key) => {
    const { rowId, colId } = splitCellKey(key);
    if (!rows.has(rowId) || !columns.has(colId)) orphans.push(key);
  });
  return orphans;
}

/**
 * Remove orphan cells. Call it when a row or column deletion is observed
 * arriving from another replica (that is the only moment orphans can appear);
 * it runs under `SWEEP_ORIGIN`, so it is not an undo step, and two replicas
 * sweeping the same keys converge. Returns the number removed.
 */
export function sweepOrphanCells(gd: GedeDoc, tableId: Id): number {
  const table = tableMap(gd, tableId);
  if (table === null) return 0;
  const orphans = orphanCellKeys(table);
  if (orphans.length === 0) return 0;
  gd.doc.transact(() => {
    const cells = cellsMap(table);
    for (const key of orphans) cells.delete(key);
  }, SWEEP_ORIGIN);
  return orphans.length;
}

export function deleteTable(gd: GedeDoc, tableId: Id): void {
  transact(gd, () => {
    gd.tables.delete(tableId);
  });
}
