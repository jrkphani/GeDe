/**
 * Sheets for the PRD §20 budget benchmark and its regression test. Not part
 * of the published package (excluded from tsconfig.src.json).
 */
import { formatAddress } from '../../address.js';
import { TABLE_HEADER_ROWS, TABLE_TITLE_ROWS } from '../../doc/schema.js';
import { cellKey } from '../../ids.js';
import type { CellSnapshot, TableSnapshot } from '../types.js';

export function sheetOf(rows: number, cols: number, fill: (r: number, c: number) => string) {
  const rowIds = Array.from({ length: rows }, (_, i) => `r${String(i).padStart(5, '0')}`);
  const columns = Array.from({ length: cols }, (_, i) => ({
    id: `c${String(i)}`,
    label: `Col ${String(i + 1)}`,
    width: 1,
  }));
  const cells: Record<string, CellSnapshot> = {};
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const text = fill(r, c);
      if (text === '') continue;
      cells[cellKey(rowIds[r] ?? '', columns[c]?.id ?? '')] = text.startsWith('=')
        ? { kind: 'formula', source: text }
        : { kind: 'text', text };
    }
  }
  const table: TableSnapshot = {
    id: 'T1',
    sheetId: 'S1',
    title: 'Bench',
    gridCol: 1,
    gridRow: 1,
    columns,
    rows: rowIds,
    rowHeights: rowIds.map(() => 1),
    rowDepths: rowIds.map(() => 0),
    cells,
  };
  return { table, rowIds, columns };
}

/** Address of data cell (r, c) for a table at (1, 1). */
export function addr(r: number, c: number): string {
  return formatAddress({ col: 1 + c, row: 1 + TABLE_TITLE_ROWS + TABLE_HEADER_ROWS + r });
}

/** 1,000 cells: 250 rows × 4 columns; column D sums A:C per row, its first cell totals the rest of D. */
export function thousandCellSheet() {
  return sheetOf(250, 4, (r, c) => {
    if (c < 3) return String(r + c);
    return r === 0 ? `=Sum(${addr(1, 3)}:${addr(249, 3)})` : `=Sum(${addr(r, 0)}:${addr(r, 2)})`;
  });
}

/** 500 rows: A1 is a number, every row below sums the row above. */
export function chainSheet() {
  return sheetOf(500, 1, (r) => (r === 0 ? '1' : `=Sum(${addr(r - 1, 0)})`));
}
