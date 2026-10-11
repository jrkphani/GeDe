import {
  addRow,
  createSheet,
  openDocument,
  setCellText,
  setRangeColumn,
  tableById,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { previewPick } from './preview.js';
import { addTableOfKind } from './set-tables.js';

let gd: GedeDoc;
let sheetId: Id;

function set(col: number, cells: readonly string[]): Id {
  const id = addTableOfKind(gd, { sheetId, at: { col, row: 1 }, kind: 'simple' })!;
  const record = tableById(gd, id)!;
  const colId = setRangeColumn(record)!;
  for (const text of cells) setCellText(gd, id, addRow(gd, id), colId, text);
  return id;
}

const union = (a: Id, b: Id) =>
  previewPick(gd, { op: 'Union', sets: [a, b], shape: 'column' }, 'r');

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  sheetId = createSheet(gd);
});

describe('SET-01 the result preview reads sets as the formulas do', () => {
  it('SET-01 a cell of "a, b" is two elements, not one', () => {
    const inter = previewPick(
      gd,
      { op: 'Inter', sets: [set(0, ['a, b']), set(4, ['a'])], shape: 'column' },
      'r',
    );
    expect(inter?.rows.flat()).toEqual(['a']);
  });

  it('SET-01 canonically equal Tamil spellings are one element', () => {
    // U+0B95 U+0BCA against U+0B95 U+0BC6 U+0BBE.
    const preview = union(set(0, ['கொ']), set(4, ['கொ']));
    expect(preview?.total).toBe(1);
  });

  it('SET-01 Power of a set holding an element the evaluator refuses has no preview', () => {
    const preview = previewPick(
      gd,
      { op: 'Power', sets: [set(0, ['x(', 'y'])], shape: 'column' },
      'r',
    );
    expect(preview).toBeNull();
  });
});
