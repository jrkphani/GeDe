/**
 * Where a match sits on the canvas (FIND-06, FIND-07). Cells, headers and
 * graphs are projected from the document's lattice geometry, never from the
 * DOM, so the highlight overlay and the viewport reveal agree with the table
 * exactly and work for a table that is not rendered yet (another sheet, off
 * screen). A hidden column has no lattice presence (GRID-02) and a table may
 * have no header row (GRID-11): both yield null. Frozen columns (GRID-10)
 * ride along the viewport edge in the pinned panel once the table has
 * scrolled under it; `viewportLeftPx` lets the highlight follow them.
 */
import {
  cellAddress,
  columnLetter,
  dataGeometry,
  graphRecord,
  headerRow,
  LATTICE,
  tableMap,
  tableRecord,
  type GedeDoc,
  type PixelBounds,
  type SearchMatch,
  type TableRecord,
} from '@gede/core';

import { frozenColumns, pinnedPanelOffset } from '../grid/pinned.js';

/** Lattice x of a column: the table's origin plus the visible widths before it; null when hidden. */
function columnX(record: TableRecord, colIndex: number, viewportLeftPx: number | undefined) {
  const column = record.columns[colIndex];
  if (column === undefined || column.hidden) return null;
  const tableLeft = record.gridCol * LATTICE.col;
  // GRID-10: while the pinned panel is due, a frozen column is drawn in the panel.
  const offset = viewportLeftPx === undefined ? null : pinnedPanelOffset(record, viewportLeftPx);
  if (offset !== null && colIndex < record.frozenColumns) {
    const before = frozenColumns(record).filter((c) => record.columns.indexOf(c) < colIndex);
    return tableLeft + offset + before.reduce((acc, c) => acc + c.width, 0) * LATTICE.col;
  }
  let units = 0;
  for (let i = 0; i < colIndex; i += 1) {
    const c = record.columns[i];
    if (c !== undefined && !c.hidden) units += c.width;
  }
  return tableLeft + units * LATTICE.col;
}

/**
 * Pixel bounds at zoom 1 of a cell, header or graph match on its sheet; null
 * for a document, a vanished target, a hidden column or a hidden header row.
 * Pass `viewportLeftPx` (viewport x at zoom 1) to place cells of frozen
 * columns where the pinned panel draws them.
 */
export function matchBounds(
  gd: GedeDoc,
  match: SearchMatch,
  viewportLeftPx?: number,
): PixelBounds | null {
  const { target } = match;
  if (target.kind === 'cell') {
    const table = tableMap(gd, target.tableId);
    if (table === null) return null;
    const record = tableRecord(table);
    const rowIndex = record.rows.indexOf(target.rowId);
    const colIndex = record.columns.findIndex((c) => c.id === target.colId);
    if (rowIndex < 0 || colIndex < 0) return null;
    const x = columnX(record, colIndex, viewportLeftPx);
    if (x === null) return null;
    const geometry = dataGeometry(table, record);
    let row = geometry.origin.row;
    for (let i = 0; i < rowIndex; i += 1) row += geometry.rowHeights[i] ?? 1;
    return {
      x,
      y: row * LATTICE.row,
      width: (record.columns[colIndex]?.width ?? 1) * LATTICE.col,
      height: (geometry.rowHeights[rowIndex] ?? 1) * LATTICE.row,
    };
  }
  if (target.kind === 'header') {
    const table = tableMap(gd, target.tableId);
    if (table === null) return null;
    const record = tableRecord(table);
    const colIndex = record.columns.findIndex((c) => c.id === target.colId);
    const row = headerRow(record);
    if (colIndex < 0 || row === null) return null;
    const x = columnX(record, colIndex, viewportLeftPx);
    if (x === null) return null;
    return {
      x,
      y: row * LATTICE.row,
      width: (record.columns[colIndex]?.width ?? 1) * LATTICE.col,
      height: LATTICE.row,
    };
  }
  if (target.kind === 'graph') {
    const map = gd.graphs.get(target.graphId);
    if (map === undefined) return null;
    const graph = graphRecord(map);
    return {
      x: graph.gridCol * LATTICE.col,
      y: graph.gridRow * LATTICE.row,
      width: graph.widthUnits * LATTICE.col,
      height: graph.heightUnits * LATTICE.row,
    };
  }
  return null;
}

/** "B5 in Table 1", "B4 header in Table 1", "Coverage graph" or "Everest trek (workscape)". */
export function describeMatch(gd: GedeDoc, match: SearchMatch): string {
  const { target } = match;
  if (target.kind === 'cell') {
    const table = tableMap(gd, target.tableId);
    const address = table === null ? null : cellAddress(table, target.rowId, target.colId);
    return address === null ? target.tableTitle : `${address} in ${target.tableTitle}`;
  }
  if (target.kind === 'header') {
    const table = tableMap(gd, target.tableId);
    const record = table === null ? null : tableRecord(table);
    const colIndex = record?.columns.findIndex((c) => c.id === target.colId) ?? -1;
    const row = record === null ? null : headerRow(record);
    const x = record === null ? null : columnX(record, colIndex, undefined);
    if (record === null || row === null || x === null) {
      return `${target.colLabel} header in ${target.tableTitle}`;
    }
    return `${columnLetter(x / LATTICE.col)}${String(row + 1)} header in ${target.tableTitle}`;
  }
  if (target.kind === 'graph') return `${target.title === '' ? 'Graph' : target.title} graph`;
  return `${target.title} (workscape)`;
}
