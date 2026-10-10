/**
 * Add table's kinds and Fill column against a real Yjs document and the real engine (no
 * Worker: `FormulaEngine` inline, as `engine.ts` runs it where `Worker` does not exist).
 */
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  cellText,
  computedItemsOf,
  createSheet,
  createTable,
  createUndoManager,
  FormulaEngine,
  observeWorkbook,
  openDocument,
  reconcileComputed,
  setCellText,
  setTableTitle,
  tableById,
  tableMap,
  type CellResult,
  type GedeDoc,
  type Id,
} from '@gede/core';

import {
  addTableOfKind,
  fillColumnReason,
  fillColumnWith,
  pickDisplay,
  pickName,
  setsOnSheet,
  type SetPick,
} from './set-tables.js';

let gd: GedeDoc;
let sheetId: Id;
let results: Map<string, CellResult>;

/** What `use-reconcile.ts` does after a settled batch: fill every computed table. */
function fillRows(): void {
  for (const h of computedItemsOf(gd, (id) => results.get(id))) {
    reconcileComputed(gd, h.tableId, h.items, h.members);
  }
}

/** A simple set titled `title` holding `elements`, at lattice column `col`. */
function set(title: string, col: number, elements: readonly string[]): Id {
  const id = addTableOfKind(gd, { sheetId, at: { col, row: 1 }, kind: 'simple' })!;
  setTableTitle(gd, id, title);
  const range = tableById(gd, id)!.columns[0]!.id;
  for (let i = 1; i < elements.length; i += 1) addRow(gd, id);
  tableById(gd, id)!.rows.forEach((rowId, i) => {
    setCellText(gd, id, rowId, range, elements[i] ?? '');
  });
  return id;
}

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  sheetId = createSheet(gd);
  results = new Map();
  const engine = new FormulaEngine();
  observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  });
});

describe('SET-01 Add table kinds', () => {
  test('SET-01 Plain table is today’s table; a Simple set starts with its range, a description and one element row', () => {
    const plain = addTableOfKind(gd, { sheetId, at: { col: 1, row: 1 }, kind: 'plain' })!;
    expect(tableById(gd, plain)).toMatchObject({ kind: 'plain' });
    expect(tableById(gd, plain)!.columns).toHaveLength(3);
    expect(tableById(gd, plain)!.rows).toHaveLength(5);
    const simple = addTableOfKind(gd, { sheetId, at: { col: 6, row: 1 }, kind: 'simple' })!;
    const record = tableById(gd, simple)!;
    expect(record.kind).toBe('simple');
    expect(record.columns.map((c) => c.label)).toEqual(['range', 'description']);
    expect(record.rows).toHaveLength(1);
    const family = addTableOfKind(gd, { sheetId, at: { col: 10, row: 1 }, kind: 'family' })!;
    expect(tableById(gd, family)!.kind).toBe('family');
  });

  test('SET-01 SET-02 the picker offers the set tables on the sheet with their elements, not plain tables', () => {
    createTable(gd, { sheetId, at: { col: 20, row: 1 } });
    const e = set('E', 1, ['a', 'b', 'c']);
    const sets = setsOnSheet(gd, sheetId);
    expect(sets.map((s) => s.title)).toEqual(['E']);
    expect(sets[0]).toMatchObject({ tableId: e, elements: ['a', 'b', 'c'], more: false });
  });

  for (const shape of ['spread', 'column'] as const) {
    test(`SET-09 SET-08 a Cartesian product E × C × B in ${shape} shape fills 18 rows, titled by its sets, in one undo step`, () => {
      const e = set('E', 1, ['a', 'b', 'c']);
      const c = set('C', 4, ['b', 'c', 'x']);
      const b = set('B', 7, ['x', 'y']);
      const undo = createUndoManager(gd, { captureTimeout: 0 });
      const pick: SetPick = { op: 'Cross', sets: [e, c, b], shape };
      expect(pickDisplay(gd, pick)).toBe('= Cross(E, C, B)');
      const id = addTableOfKind(gd, {
        sheetId,
        at: { col: 1, row: 10 },
        kind: 'product',
        pick,
      })!;
      fillRows();
      const record = tableById(gd, id)!;
      expect(record.kind).toBe('product');
      expect(record.title).toBe(pickName(gd, pick));
      expect(record.title).toBe('E × C × B');
      expect(record.rows).toHaveLength(18);
      const table = tableMap(gd, id)!;
      if (shape === 'spread') {
        expect(record.columns.map((col) => col.label)).toEqual([
          'x1 ∈ E',
          'x2 ∈ C',
          'x3 ∈ B',
          'note',
        ]);
        const [x1, x2, x3] = record.columns;
        const first = record.rows[0]!;
        expect([x1, x2, x3].map((col) => cellText(table, first, col!.id))).toEqual(['a', 'b', 'x']);
      } else {
        expect(record.columns.map((col) => col.label)).toEqual(['range', 'note']);
        expect(cellText(table, record.rows[0]!, record.columns[0]!.id)).toBe('(a, b, x)');
      }
      undo.undo();
      expect(tableById(gd, id)).toBeNull();
    });
  }
});

describe('SET-10 Fill column with formula…', () => {
  test('SET-10 disabled with the reason while the column holds a typed value, or is computed already', () => {
    const e = set('E', 1, ['a']);
    const plain = createTable(gd, { sheetId, at: { col: 1, row: 10 }, columns: 2, rows: 2 });
    const [first, second] = tableById(gd, plain)!.columns;
    expect(fillColumnReason(gd, plain, first!.id)).toBeUndefined();
    setCellText(gd, plain, tableById(gd, plain)!.rows[1]!, second!.id, 'typed');
    expect(fillColumnReason(gd, plain, second!.id)).toBe('the column is not empty');
    expect(fillColumnWith(gd, plain, second!.id, { op: 'Power', sets: [e], shape: 'column' })).toBe(
      false,
    );
    expect(tableById(gd, plain)!.columns[1]!.source).toBe('entered');
    expect(fillColumnWith(gd, plain, first!.id, { op: 'Power', sets: [e], shape: 'column' })).toBe(
      true,
    );
    expect(fillColumnReason(gd, plain, first!.id)).toBe('the column is computed');
  });

  test('SET-09 SET-10 filling one column with a Cross per set heads it x1 ∈ E and adds the other members beside it', () => {
    const e = set('E', 1, ['a', 'b']);
    const c = set('C', 4, ['x']);
    const plain = createTable(gd, { sheetId, at: { col: 1, row: 10 }, columns: 2, rows: 0 });
    const [first, note] = tableById(gd, plain)!.columns;
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    expect(
      fillColumnWith(gd, plain, first!.id, { op: 'Cross', sets: [e, c], shape: 'spread' }),
    ).toBe(true);
    fillRows();
    const record = tableById(gd, plain)!;
    expect(record.columns.map((col) => col.label)).toEqual(['x1 ∈ E', 'x2 ∈ C', note!.label]);
    expect(record.columns[0]!.id).toBe(first!.id);
    expect(record.rows).toHaveLength(2);
    // One undo step: the column is entered again under its old name, and the rows go.
    undo.undo();
    fillRows();
    const after = tableById(gd, plain)!;
    expect(after.columns.map((col) => col.label)).toEqual([first!.label, note!.label]);
    expect(after.columns.map((col) => col.source)).toEqual(['entered', 'entered']);
    expect(after.rows).toEqual([]);
  });
});
