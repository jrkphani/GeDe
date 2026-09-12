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
import { cellFragment, cellRich, setCellRich } from './mutations.js';
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

  test('setCellText on a marked cell with the same text keeps the marks (Wave 1 guard)', () => {
    const { gd, tableId, rowId, colId } = fixture();
    setCellRich(gd, tableId, rowId, colId, docNode([paragraphNode([textNode('kept', [bold])])]));
    setCellText(gd, tableId, rowId, colId, 'kept');
    expect(cellRich(tableMap(gd, tableId)!, rowId, colId).content[0]?.content?.[0]?.marks).toEqual([
      bold,
    ]);
  });
});
