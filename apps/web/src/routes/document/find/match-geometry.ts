/**
 * Where a match sits on the canvas (FIND-06, FIND-07). Cells and graphs are
 * projected from the document's lattice geometry, never from the DOM, so the
 * highlight overlay and the viewport reveal agree with the table exactly and
 * work for a table that is not rendered yet (another sheet, off screen).
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
} from '@gede/core';

/** Pixel bounds at zoom 1 of a cell or graph match on its sheet; null for a document or a vanished target. */
export function matchBounds(gd: GedeDoc, match: SearchMatch): PixelBounds | null {
  const { target } = match;
  if (target.kind === 'cell') {
    const table = tableMap(gd, target.tableId);
    if (table === null) return null;
    const record = tableRecord(table);
    const rowIndex = record.rows.indexOf(target.rowId);
    const colIndex = record.columns.findIndex((c) => c.id === target.colId);
    if (rowIndex < 0 || colIndex < 0) return null;
    const geometry = dataGeometry(table, record);
    let col = geometry.origin.col;
    for (let i = 0; i < colIndex; i += 1) col += geometry.columnWidths[i] ?? 1;
    let row = geometry.origin.row;
    for (let i = 0; i < rowIndex; i += 1) row += geometry.rowHeights[i] ?? 1;
    return {
      x: col * LATTICE.col,
      y: row * LATTICE.row,
      width: (geometry.columnWidths[colIndex] ?? 1) * LATTICE.col,
      height: (geometry.rowHeights[rowIndex] ?? 1) * LATTICE.row,
    };
  }
  if (target.kind === 'header') {
    const table = tableMap(gd, target.tableId);
    if (table === null) return null;
    const record = tableRecord(table);
    const colIndex = record.columns.findIndex((c) => c.id === target.colId);
    if (colIndex < 0) return null;
    const geometry = dataGeometry(table, record);
    let col = geometry.origin.col;
    for (let i = 0; i < colIndex; i += 1) col += geometry.columnWidths[i] ?? 1;
    return {
      x: col * LATTICE.col,
      y: headerRow(record) * LATTICE.row,
      width: (geometry.columnWidths[colIndex] ?? 1) * LATTICE.col,
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

/** "B5 in Table 1", "Coverage graph" or "Everest trek (workscape)" — for the counter and the live region. */
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
    if (record === null || colIndex < 0) return `${target.colLabel} header in ${target.tableTitle}`;
    let col = record.gridCol;
    for (let i = 0; i < colIndex; i += 1) col += record.columns[i]?.width ?? 1;
    return `${columnLetter(col)}${String(headerRow(record) + 1)} header in ${target.tableTitle}`;
  }
  if (target.kind === 'graph') return `${target.title === '' ? 'Graph' : target.title} graph`;
  return `${target.title} (workscape)`;
}
