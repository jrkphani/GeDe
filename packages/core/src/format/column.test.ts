import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellFormatOverride,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  openDocument,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { columnById, countOverrides, effectiveCellFormat } from './column.js';
import { commitFormattedText, setCellFormat, setColumnFormat } from './mutations.js';
import { AUTO_FORMAT } from './types.js';
import { renderText } from './value.js';

function fixture(): { gd: GedeDoc; tableId: string; colId: string; rows: readonly string[] } {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 2, rows: 3 });
  const record = tableById(gd, tableId)!;
  return { gd, tableId, colId: record.columns[0]!.id, rows: record.rows };
}

describe('column formats in the document (FMT-01, FMT-06)', () => {
  test('FMT-01 a column created before formats existed reads as Automatic with no options', () => {
    const { gd, tableId, colId } = fixture();
    const column = columnById(tableMap(gd, tableId)!, colId)!;
    expect(column.format).toBe('auto');
    expect(column.formatOpts).toEqual({});
    expect(effectiveCellFormat(tableMap(gd, tableId)!, 'any-row', colId)).toEqual(AUTO_FORMAT);
  });

  test('FMT-01 the column format is inherited by every cell; a cell may override it', () => {
    const { gd, tableId, colId, rows } = fixture();
    setColumnFormat(gd, tableId, colId, 'currency', { currency: 'INR', decimals: 0 });
    const table = tableMap(gd, tableId)!;
    for (const rowId of rows) {
      expect(effectiveCellFormat(table, rowId, colId)).toEqual({
        kind: 'currency',
        opts: { currency: 'INR', decimals: 0 },
      });
    }
    setCellFormat(gd, tableId, rows[1]!, colId, 'text');
    expect(effectiveCellFormat(table, rows[1]!, colId)).toEqual({ kind: 'text', opts: {} });
    expect(cellFormatOverride(table, rows[0]!, colId)).toBeNull();
    expect(countOverrides(table, colId)).toBe(1);
    setCellFormat(gd, tableId, rows[1]!, colId, null);
    expect(effectiveCellFormat(table, rows[1]!, colId).kind).toBe('currency');
    expect(countOverrides(table, colId)).toBe(0);
  });

  test('FMT-06 a row appended after the column was formatted inherits the format', () => {
    const { gd, tableId, colId } = fixture();
    setColumnFormat(gd, tableId, colId, 'date', { datePattern: 'DD/MM/YYYY' });
    const newRow = addRow(gd, tableId);
    expect(effectiveCellFormat(tableMap(gd, tableId)!, newRow, colId)).toEqual({
      kind: 'date',
      opts: { datePattern: 'DD/MM/YYYY' },
    });
    const stored = commitFormattedText(gd, tableId, newRow, colId, '12/9/2026');
    expect(stored).toBe('2026-09-12');
    expect(
      renderText(
        cellText(tableMap(gd, tableId)!, newRow, colId),
        effectiveCellFormat(tableMap(gd, tableId)!, newRow, colId),
        'en-GB',
      ).text,
    ).toBe('12/09/2026');
  });

  test('FMT-02 commitFormattedText stores the parsed number under Number; Automatic keeps the text', () => {
    const { gd, tableId, colId, rows } = fixture();
    const table = tableMap(gd, tableId)!;
    commitFormattedText(gd, tableId, rows[0]!, colId, '1,234.50');
    expect(cellText(table, rows[0]!, colId)).toBe('1,234.50');
    setColumnFormat(gd, tableId, colId, 'number', { decimals: 2 });
    commitFormattedText(gd, tableId, rows[1]!, colId, '1,234.50');
    expect(cellText(table, rows[1]!, colId)).toBe('1234.5');
    // Changing the format re-renders without re-typing (FMT-02).
    setColumnFormat(gd, tableId, colId, 'number', { decimals: 0 });
    expect(
      renderText(
        cellText(table, rows[1]!, colId),
        effectiveCellFormat(table, rows[1]!, colId),
        'en-US',
      ).text,
    ).toBe('1,235');
  });

  test('FMT-05 invalid text under an explicit format is stored as typed, never as zero', () => {
    const { gd, tableId, colId, rows } = fixture();
    setColumnFormat(gd, tableId, colId, 'number');
    commitFormattedText(gd, tableId, rows[0]!, colId, 'n/a');
    const table = tableMap(gd, tableId)!;
    expect(cellText(table, rows[0]!, colId)).toBe('n/a');
    expect(renderText('n/a', effectiveCellFormat(table, rows[0]!, colId)).invalid).toBe(true);
  });

  test('a formula commit and an empty commit behave as setCellText does', () => {
    const { gd, tableId, colId, rows } = fixture();
    setColumnFormat(gd, tableId, colId, 'number');
    expect(commitFormattedText(gd, tableId, rows[0]!, colId, '=Sum(B2:B3)')).toBe('=Sum(B2:B3)');
    expect(cellText(tableMap(gd, tableId)!, rows[0]!, colId)).toBe('=Sum(B2:B3)');
    expect(commitFormattedText(gd, tableId, rows[0]!, colId, '')).toBe('');
    expect(cellText(tableMap(gd, tableId)!, rows[0]!, colId)).toBe('');
  });

  test('KEYS-03 format changes are one undo step each, on the local origin', () => {
    const { gd, tableId, colId, rows } = fixture();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    setColumnFormat(gd, tableId, colId, 'currency', { currency: 'USD' });
    setCellFormat(gd, tableId, rows[0]!, colId, 'text');
    expect(undo.undoStack.length).toBe(2);
    undo.undo();
    expect(effectiveCellFormat(tableMap(gd, tableId)!, rows[0]!, colId).kind).toBe('currency');
    undo.undo();
    expect(effectiveCellFormat(tableMap(gd, tableId)!, rows[0]!, colId).kind).toBe('auto');
  });

  test('setColumnFormat on an unknown column or table throws a RangeError', () => {
    const { gd, tableId } = fixture();
    expect(() => {
      setColumnFormat(gd, tableId, 'nope', 'text');
    }).toThrow(RangeError);
    expect(() => {
      setColumnFormat(gd, 'nope', 'nope', 'text');
    }).toThrow(RangeError);
  });
});
