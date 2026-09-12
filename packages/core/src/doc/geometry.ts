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
  graphsOnSheet,
  rowMeta,
  TABLE_HEADER_ROWS,
  TABLE_TITLE_ROWS,
  tableMap,
  tableRecord,
  tablesOnSheet,
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

/** Heights of each data row in units, in row order (2 for a wrapped row, GRID-09). */
export function rowHeights(table: TableMap, record: TableRecord = tableRecord(table)): number[] {
  return record.rows.map((rowId) => rowMeta(table, rowId).height);
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
      row: record.gridRow + TABLE_TITLE_ROWS + TABLE_HEADER_ROWS,
    },
    columnWidths: record.columns.map((c) => c.width),
    rowHeights: rowHeights(table, record),
  };
}

/** Lattice row of the column-header row (its cells carry addresses too, DOC-06). */
export function headerRow(record: TableRecord): number {
  return record.gridRow + TABLE_TITLE_ROWS;
}

/** The A1 address of the data cell at (rowId, colId), or null when either id is unknown. */
export function cellAddress(table: TableMap, rowId: Id, colId: Id): string | null {
  const record = tableRecord(table);
  const rowOrdinal = record.rows.indexOf(rowId);
  const colOrdinal = record.columns.findIndex((c) => c.id === colId);
  if (rowOrdinal < 0 || colOrdinal < 0) return null;
  return formatAddress(cellRefInTable(dataGeometry(table, record), colOrdinal, rowOrdinal));
}

/** Every data-cell address, `[rowOrdinal][columnOrdinal]` (GRID-02). */
export function tableAddresses(table: TableMap): string[][] {
  return addressGrid(dataGeometry(table));
}

/** Lattice footprint of the whole table: title bar + header + rows. */
export function tableUnitBounds(
  table: TableMap,
  record: TableRecord = tableRecord(table),
): UnitBounds {
  const cols = record.columns.reduce((acc, c) => acc + c.width, 0);
  const rows =
    TABLE_TITLE_ROWS + TABLE_HEADER_ROWS + rowHeights(table, record).reduce((a, b) => a + b, 0);
  return { col: record.gridCol, row: record.gridRow, cols, rows };
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
