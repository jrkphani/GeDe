import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  openDocument,
  setCellText,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { commitCellText } from '../engine/commit.js';
import { cellFragment, cellRich, replaceInCell, setCellRich } from './mutations.js';
import { docNode, EMPTY_DOC, paragraphNode, richFromText, textNode } from './types.js';

function fixture(): { gd: GedeDoc; tableId: string; rowId: string; colId: string } {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
  const record = tableById(gd, tableId)!;
  return { gd, tableId, rowId: record.rows[0]!, colId: record.columns[0]!.id };
}

const bold = { type: 'bold' } as const;

describe('rich cell reads and writes', () => {
  test('setCellRich stores marks; cellRich reads them; cellText still projects plain text', () => {
    const { gd, tableId, rowId, colId } = fixture();
    const doc = docNode([paragraphNode([textNode('bold ', [bold]), textNode('plain')])]);
    setCellRich(gd, tableId, rowId, colId, doc);
    const table = tableMap(gd, tableId)!;
    expect(cellRich(table, rowId, colId)).toEqual(doc);
    expect(cellText(table, rowId, colId)).toBe('bold plain');
    expect(cellFragment(table, rowId, colId)).toBeInstanceOf(Y.XmlFragment);
  });

  test('an empty document clears the cell; a formula is stored as its source', () => {
    const { gd, tableId, rowId, colId } = fixture();
    setCellRich(gd, tableId, rowId, colId, richFromText('=Sum(A1:A2)'));
    const table = tableMap(gd, tableId)!;
    expect(cellText(table, rowId, colId)).toBe('=Sum(A1:A2)');
    expect(cellFragment(table, rowId, colId)).toBeNull();
    expect(cellRich(table, rowId, colId)).toEqual(richFromText('=Sum(A1:A2)'));
    setCellRich(gd, tableId, rowId, colId, EMPTY_DOC);
    expect(cellText(table, rowId, colId)).toBe('');
    expect(cellRich(table, rowId, colId)).toEqual(EMPTY_DOC);
  });

  test('an existing fragment is rewritten in place (same Y type, one transaction); unchanged is a no-op', () => {
    const { gd, tableId, rowId, colId } = fixture();
    setCellText(gd, tableId, rowId, colId, 'first');
    const table = tableMap(gd, tableId)!;
    const before = cellFragment(table, rowId, colId);
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    setCellRich(gd, tableId, rowId, colId, docNode([paragraphNode([textNode('second', [bold])])]));
    expect(cellFragment(table, rowId, colId)).toBe(before);
    expect(undo.undoStack.length).toBe(1);
    setCellRich(gd, tableId, rowId, colId, docNode([paragraphNode([textNode('second', [bold])])]));
    expect(undo.undoStack.length).toBe(1);
    undo.undo();
    expect(cellText(table, rowId, colId)).toBe('first');
  });

  test('FIND-08 replaceInCell rewrites one span in place and keeps the marks around it', () => {
    const { gd, tableId, rowId, colId } = fixture();
    setCellRich(
      gd,
      tableId,
      rowId,
      colId,
      docNode([paragraphNode([textNode('Singapore'), textNode(' office', [bold])])]),
    );
    const table = tableMap(gd, tableId)!;
    const before = cellFragment(table, rowId, colId);
    expect(replaceInCell(gd, tableId, rowId, colId, { from: 0, to: 9 }, 'Mumbai')).toBe(true);
    expect(cellRich(table, rowId, colId)).toEqual(
      docNode([paragraphNode([textNode('Mumbai'), textNode(' office', [bold])])]),
    );
    expect(cellFragment(table, rowId, colId)).toBe(before);
    // A span past the text, or an empty one, rewrites nothing.
    expect(replaceInCell(gd, tableId, rowId, colId, { from: 5, to: 40 }, 'x')).toBe(false);
    expect(replaceInCell(gd, tableId, rowId, colId, { from: 3, to: 3 }, 'x')).toBe(false);
    expect(cellText(table, rowId, colId)).toBe('Mumbai office');
    // A formula cell is edited as its source.
    setCellText(gd, tableId, rowId, colId, '=Concat(@Trek.Singapore)');
    expect(replaceInCell(gd, tableId, rowId, colId, { from: 14, to: 23 }, 'Mumbai')).toBe(true);
    expect(cellText(table, rowId, colId)).toBe('=Concat(@Trek.Mumbai)');
  });

  test('FIND-08 replaceInCell on a committed formula edits the expression the person reads and re-binds it', () => {
    const { gd, tableId, rowId, colId } = fixture();
    // A second table gives the formula something to bind to: its first cell is C1.
    const sheetId = tableById(gd, tableId)!.sheetId;
    const other = createTable(gd, { sheetId, at: { col: 2, row: 0 }, columns: 2, rows: 3 });
    setCellText(
      gd,
      other,
      tableById(gd, other)!.rows[0]!,
      tableById(gd, other)!.columns[0]!.id,
      '5',
    );
    commitCellText(gd, tableId, rowId, colId, '=Sum(C4:C6)');
    const table = tableMap(gd, tableId)!;
    const stored = cellText(table, rowId, colId);
    expect(stored).toMatch(/^=Sum\(\{r:/);
    // The span is in the projected text (`=Sum(C4:C6)`), as Find indexed it: replace `C4:C6` with `D4`.
    expect(replaceInCell(gd, tableId, rowId, colId, { from: 5, to: 10 }, 'D4')).toBe(true);
    const next = cellText(table, rowId, colId);
    expect(next).toMatch(/^=Sum\(\{c:/);
    expect(next).not.toBe(stored);
    // Spans are measured on the projected text, not the token string.
    expect(replaceInCell(gd, tableId, rowId, colId, { from: 5, to: 60 }, 'x')).toBe(false);
  });

  test('setCellRich returns false when the row went while the editor was open (GRID-02)', () => {
    const { gd, tableId, colId } = fixture();
    expect(setCellRich(gd, tableId, 'gone-row', colId, richFromText('x'))).toBe(false);
    expect(replaceInCell(gd, tableId, 'gone-row', colId, { from: 0, to: 1 }, 'y')).toBe(false);
  });

  test('setCellText on a marked cell with the same text keeps the marks (Wave 1 guard)', () => {
    const { gd, tableId, rowId, colId } = fixture();
    setCellRich(gd, tableId, rowId, colId, docNode([paragraphNode([textNode('kept', [bold])])]));
    setCellText(gd, tableId, rowId, colId, 'kept');
    expect(cellRich(tableMap(gd, tableId)!, rowId, colId).content[0]?.content?.[0]?.marks).toEqual([
      bold,
    ]);
  });
});
