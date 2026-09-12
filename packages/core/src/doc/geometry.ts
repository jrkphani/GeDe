/**
 * Geometry projections over the document (GRID-01, GRID-02, GRID-09, DOC-07).
 *
 * A table's lattice footprint is its title bar, its header row and its rows,
 * each a whole number of units. Cell addresses fall out of that footprint via
 * `address.ts`; nothing here is stored.
 */
import { addressGrid, cellRefInTable, formatAddress, type TableGeometry } from '../address.js';
import type { Id } from '../ids.js';
import { LATTICE, pointToPx, type Pixels } from '../lattice.js';
import {
  DEFAULT_ROW_HEIGHT,
  graphsOnSheet,
  rowMeta,
  TABLE_TITLE_ROWS,
  tableMap,
  tableRecord,
  tablesOnSheet,
  WRAPPED_ROW_HEIGHT,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from './schema.js';

/** A rectangle in lattice units; `end` is exclusive. */
export interface UnitBounds {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

/** A rectangle in CSS pixels at zoom 1. */
export interface PixelBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** True when any visible column wraps: every row of the table is then two units (GRID-09). */
export function tableWraps(record: TableRecord): boolean {
  return record.columns.some((c) => c.wrap && !c.hidden);
}

/**
 * Heights of each data row in units, in row order (GRID-09): two when the row
 * itself is wrapped or any visible column wraps, else one. Never anything else,
 * so the row after a wrapped row is exactly two addresses down.
 */
export function rowHeights(table: TableMap, record: TableRecord = tableRecord(table)): number[] {
  const wrapAll = tableWraps(record);
  return record.rows.map((rowId) =>
    wrapAll || rowMeta(table, rowId).height >= WRAPPED_ROW_HEIGHT
      ? WRAPPED_ROW_HEIGHT
      : DEFAULT_ROW_HEIGHT,
  );
}

/** Widths of each column in units, in column order; a hidden column is 0 (GRID-02). */
export function columnWidths(record: TableRecord): number[] {
  return record.columns.map((c) => (c.hidden ? 0 : c.width));
}

/**
 * Geometry of the *data* cells: origin is the first data cell (below title and
 * header), widths per column, heights per row. Feed this to `address.ts`.
 */
export function dataGeometry(
  table: TableMap,
  record: TableRecord = tableRecord(table),
): TableGeometry {
  return {
    origin: {
      col: record.gridCol,
      row: record.gridRow + TABLE_TITLE_ROWS + record.headerRows,
    },
    columnWidths: columnWidths(record),
    rowHeights: rowHeights(table, record),
  };
}

/** Lattice row of the column-header row (its cells carry addresses too, DOC-06); null when hidden (GRID-11). */
export function headerRow(record: TableRecord): number | null {
  return record.headerRows === 0 ? null : record.gridRow + TABLE_TITLE_ROWS;
}

/**
 * The A1 address of the data cell at (rowId, colId), or null when either id is
 * unknown or the column is hidden (a hidden column has no lattice presence).
 */
export function cellAddress(table: TableMap, rowId: Id, colId: Id): string | null {
  const record = tableRecord(table);
  const rowOrdinal = record.rows.indexOf(rowId);
  const colOrdinal = record.columns.findIndex((c) => c.id === colId);
  if (rowOrdinal < 0 || colOrdinal < 0) return null;
  if (record.columns[colOrdinal]?.hidden === true) return null;
  return formatAddress(cellRefInTable(dataGeometry(table, record), colOrdinal, rowOrdinal));
}

/** Every data-cell address, `[rowOrdinal][columnOrdinal]` (GRID-02). */
export function tableAddresses(table: TableMap): string[][] {
  return addressGrid(dataGeometry(table));
}

/** Sum of the visible column widths in units; never below one so a table always has a footprint. */
export function tableWidthUnits(record: TableRecord): number {
  return Math.max(
    1,
    columnWidths(record).reduce((acc, w) => acc + w, 0),
  );
}

/** Lattice footprint of the whole table: title bar + header + rows + footer strip. */
export function tableUnitBounds(
  table: TableMap,
  record: TableRecord = tableRecord(table),
): UnitBounds {
  const rows =
    TABLE_TITLE_ROWS +
    record.headerRows +
    rowHeights(table, record).reduce((a, b) => a + b, 0) +
    record.footerRows;
  return { col: record.gridCol, row: record.gridRow, cols: tableWidthUnits(record), rows };
}

export function unitBoundsToPx(b: UnitBounds): PixelBounds {
  return {
    x: b.col * LATTICE.col,
    y: b.row * LATTICE.row,
    width: b.cols * LATTICE.col,
    height: b.rows * LATTICE.row,
  };
}

/** Union of rectangles; null when there is nothing on the sheet. */
export function unionBounds(list: readonly UnitBounds[]): UnitBounds | null {
  if (list.length === 0) return null;
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const b of list) {
    minCol = Math.min(minCol, b.col);
    minRow = Math.min(minRow, b.row);
    maxCol = Math.max(maxCol, b.col + b.cols);
    maxRow = Math.max(maxRow, b.row + b.rows);
  }
  return { col: minCol, row: minRow, cols: maxCol - minCol, rows: maxRow - minRow };
}

/** DOC-07: bounds of all tables and graphs on a sheet, framed together. */
export function sheetBounds(gd: GedeDoc, sheetId: Id): UnitBounds | null {
  const tables = tablesOnSheet(gd, sheetId).map((record) => {
    const map = tableMap(gd, record.id);
    if (map === null) throw new RangeError(`table ${record.id} vanished mid-read`);
    return tableUnitBounds(map, record);
  });
  const graphs = graphsOnSheet(gd, sheetId).map((g) => ({
    col: g.gridCol,
    row: g.gridRow,
    cols: g.widthUnits,
    rows: g.heightUnits,
  }));
  return unionBounds([...tables, ...graphs]);
}

/** Top-left of a table in pixels at zoom 1. */
export function tableOriginPx(record: TableRecord): Pixels {
  return pointToPx({ col: record.gridCol, row: record.gridRow });
}
