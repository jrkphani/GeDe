/**
 * Address → cell resolution for one sheet (PRD §20: "address→id resolution is
 * a separate index rebuilt on structural edits").
 *
 * Built from table structures alone, so the main thread can build one for
 * live outline drawing while the Worker keeps its own for evaluation. A
 * position maps to the cell whose top-left lattice unit it is; a two-unit
 * column is addressed by its first letter (`cellRefInTable`).
 */
import { offsetsFromSizes, type CellRange, type CellRef } from '../address.js';
import { TABLE_HEADER_ROWS, TABLE_TITLE_ROWS } from '../doc/schema.js';
import { cellKey, type Id } from '../ids.js';
import { workbookCellId, type IndexedCell, type TableStructure } from './types.js';

export interface SheetIndex {
  readonly sheetId: Id;
  /** `${col},${row}` → the cell whose top-left unit that is. */
  readonly byPosition: ReadonlyMap<string, IndexedCell>;
  /** Lattice column → its cells, sorted by row. */
  readonly byColumn: ReadonlyMap<number, readonly IndexedCell[]>;
  readonly byCellId: ReadonlyMap<string, IndexedCell>;
}

export function positionKey(ref: CellRef): string {
  return `${String(ref.col)},${String(ref.row)}`;
}

/** Row of the first data cell: the table origin plus its title bar and header. */
export function dataOriginRow(table: TableStructure): number {
  return table.gridRow + TABLE_TITLE_ROWS + TABLE_HEADER_ROWS;
}

/** Every data cell of a table with its lattice position and extent. */
export function indexTable(table: TableStructure): IndexedCell[] {
  const colOffsets = offsetsFromSizes(table.columns.map((c) => c.width));
  const rowOffsets = offsetsFromSizes(table.rowHeights);
  const originRow = dataOriginRow(table);
  const out: IndexedCell[] = [];
  table.rows.forEach((rowId, r) => {
    table.columns.forEach((column, c) => {
      if (column.width === 0) return; // hidden: no address, no outline (GRID-02)
      const key = cellKey(rowId, column.id);
      out.push({
        cellId: workbookCellId(table.id, key),
        tableId: table.id,
        key,
        ref: {
          col: table.gridCol + (colOffsets[c] ?? 0),
          row: originRow + (rowOffsets[r] ?? 0),
        },
        cols: column.width,
        rows: table.rowHeights[r] ?? 1,
      });
    });
  });
  return out;
}

export function buildSheetIndex(sheetId: Id, tables: Iterable<TableStructure>): SheetIndex {
  const byPosition = new Map<string, IndexedCell>();
  const byColumn = new Map<number, IndexedCell[]>();
  const byCellId = new Map<string, IndexedCell>();
  for (const table of tables) {
    if (table.sheetId !== sheetId) continue;
    for (const cell of indexTable(table)) {
      byPosition.set(positionKey(cell.ref), cell);
      byCellId.set(cell.cellId, cell);
      const column = byColumn.get(cell.ref.col);
      if (column === undefined) byColumn.set(cell.ref.col, [cell]);
      else column.push(cell);
    }
  }
  for (const column of byColumn.values()) column.sort((a, b) => a.ref.row - b.ref.row);
  return { sheetId, byPosition, byColumn, byCellId };
}

export function cellAtPosition(index: SheetIndex, ref: CellRef): IndexedCell | undefined {
  return index.byPosition.get(positionKey(ref));
}

/** Cells inside a range, row-major. Positions with no table cell are skipped. */
export function cellsInRangeOn(index: SheetIndex, range: CellRange): IndexedCell[] {
  const out: IndexedCell[] = [];
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      const cell = index.byPosition.get(positionKey({ col, row }));
      if (cell !== undefined) out.push(cell);
    }
  }
  return out;
}

export function cellsInColumnOn(index: SheetIndex, col: number): readonly IndexedCell[] {
  return index.byColumn.get(col) ?? [];
}

/** Case-insensitive lookup key for an `@` path. */
export function entityKey(path: readonly string[]): string {
  return path.map((s) => s.trim().toLowerCase()).join('\0');
}
