import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  hideColumn,
  openDocument,
  setCellText,
  setFrozenColumns,
  setHeaderRows,
  tableById,
  type SearchMatch,
} from '@gede/core';

import { describeMatch, matchBounds } from './match-geometry.js';

function fixture() {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  // Four columns at (2, 1): data rows start at lattice row 4, column C.
  const tableId = createTable(gd, { sheetId, at: { col: 2, row: 1 }, columns: 4, rows: 2 });
  const record = tableById(gd, tableId)!;
  record.columns.forEach((c, i) => {
    setCellText(gd, tableId, record.rows[0]!, c.id, `v${String(i)}`);
  });
  const cell = (colIndex: number): SearchMatch => {
    const col = record.columns[colIndex]!;
    return {
      id: 'm',
      entryId: 'e',
      field: 'value',
      text: `v${String(colIndex)}`,
      distance: 0,
      start: 0,
      end: 2,
      readOnly: false,
      target: {
        kind: 'cell',
        sheetId,
        sheetOrdinal: 1,
        tableId,
        tableTitle: 'Table 1',
        rowId: record.rows[0]!,
        colId: col.id,
        rowIndex: 0,
        colIndex,
        colLabel: col.label,
        format: 'text',
      },
    };
  };
  const header = (colIndex: number): SearchMatch => {
    const col = record.columns[colIndex]!;
    return {
      id: 'h',
      entryId: 'e',
      field: 'header',
      text: col.label,
      distance: 0,
      start: 0,
      end: 1,
      readOnly: true,
      target: {
        kind: 'header',
        sheetId,
        sheetOrdinal: 1,
        tableId,
        tableTitle: 'Table 1',
        colId: col.id,
        colIndex,
        colLabel: col.label,
      },
    };
  };
  return { gd, tableId, record, cell, header };
}

describe('matchBounds', () => {
  it('FIND-06 (partial: not in inspector) FIND-07 projects cells and headers from lattice geometry', () => {
    const { gd, cell, header } = fixture();
    expect(matchBounds(gd, cell(2))).toEqual({ x: 4 * 160, y: 4 * 22, width: 160, height: 22 });
    expect(matchBounds(gd, header(2))).toEqual({ x: 4 * 160, y: 3 * 22, width: 160, height: 22 });
    expect(describeMatch(gd, cell(2))).toBe('E5 in Table 1');
    expect(describeMatch(gd, header(2))).toBe('E4 header in Table 1');
  });

  it('GRID-02 a hidden column has no bounds and what follows it moves left', () => {
    const { gd, tableId, record, cell, header } = fixture();
    hideColumn(gd, tableId, record.columns[1]!.id);
    expect(matchBounds(gd, cell(1))).toBeNull();
    expect(matchBounds(gd, header(1))).toBeNull();
    expect(matchBounds(gd, cell(2))).toEqual({ x: 3 * 160, y: 4 * 22, width: 160, height: 22 });
    expect(describeMatch(gd, cell(2))).toBe('D5 in Table 1');
    expect(describeMatch(gd, header(2))).toBe('D4 header in Table 1');
  });

  it('GRID-11 a table without a header row has no header bounds and its data rows move up', () => {
    const { gd, tableId, cell, header } = fixture();
    setHeaderRows(gd, tableId, 0);
    expect(matchBounds(gd, header(0))).toBeNull();
    expect(describeMatch(gd, header(0))).toBe('Column 1 header in Table 1');
    expect(matchBounds(gd, cell(0))).toEqual({ x: 2 * 160, y: 3 * 22, width: 160, height: 22 });
  });

  it('GRID-10 cells of frozen columns follow the pinned panel once the table scrolls under the viewport edge', () => {
    const { gd, tableId, cell, header } = fixture();
    setFrozenColumns(gd, tableId, 2);
    const tableLeft = 2 * 160;
    // Viewport still left of the table: no panel, lattice positions.
    expect(matchBounds(gd, cell(0), 100)?.x).toBe(tableLeft);
    // Scrolled 200 px past the table's left edge: frozen columns 0 and 1 ride along at that offset.
    expect(matchBounds(gd, cell(0), tableLeft + 200)?.x).toBe(tableLeft + 200);
    expect(matchBounds(gd, cell(1), tableLeft + 200)?.x).toBe(tableLeft + 200 + 160);
    expect(matchBounds(gd, header(1), tableLeft + 200)?.x).toBe(tableLeft + 200 + 160);
    // An unfrozen column stays where the lattice puts it.
    expect(matchBounds(gd, cell(2), tableLeft + 200)?.x).toBe(tableLeft + 2 * 160);
    // Without a viewport (the reveal path) frozen columns keep their lattice position.
    expect(matchBounds(gd, cell(0))?.x).toBe(tableLeft);
  });
});
