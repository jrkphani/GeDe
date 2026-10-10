/**
 * Add table's kinds and Fill column against a real Yjs document and the real engine (no
 * Worker: `FormulaEngine` inline, as `engine.ts` runs it where `Worker` does not exist).
 */
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  addColumn,
  addDerivedColumn,
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
  changeTableKind,
  fillColumnReason,
  fillColumnWith,
  pickDisplay,
  pickName,
  kindChoices,
  setsOnSheet,
  tableKindReason,
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

/** A column's shown values, row by row. */
function colText(tableId: Id, index = 0): string[] {
  const record = tableById(gd, tableId)!;
  const table = tableMap(gd, tableId)!;
  const colId = record.columns[index]!.id;
  return record.rows.map((rowId) => cellText(table, rowId, colId));
}

describe('Phase 3 red-team regressions: Fill column', () => {
  test('SET-10 the empty note column of a computed table offers no second formula, so E ∪ C keeps showing E ∪ C', () => {
    const e = set('E', 1, ['a', 'b']);
    const c = set('C', 4, ['b', 'c']);
    const u = addTableOfKind(gd, {
      sheetId,
      at: { col: 1, row: 10 },
      kind: 'computed',
      pick: { op: 'Union', sets: [e, c], shape: 'column' },
    })!;
    fillRows();
    expect(colText(u)).toEqual(['a', 'b', 'c']);
    const note = tableById(gd, u)!.columns[1]!.id;
    expect(fillColumnReason(gd, u, note)).toBe('the table already has a formula');
    expect(fillColumnWith(gd, u, note, { op: 'Inter', sets: [e, c], shape: 'column' })).toBe(false);
    fillRows();
    expect(tableById(gd, u)!.title).toBe('E ∪ C');
    expect(colText(u)).toEqual(['a', 'b', 'c']);
  });

  test('SET-10 a plain table filled once offers no second Fill on another empty column', () => {
    const e = set('E', 1, ['a', 'b']);
    const c = set('C', 4, ['b', 'c']);
    const plain = createTable(gd, { sheetId, at: { col: 1, row: 10 }, columns: 2, rows: 0 });
    const [a, b] = tableById(gd, plain)!.columns;
    expect(fillColumnWith(gd, plain, a!.id, { op: 'Union', sets: [e, c], shape: 'column' })).toBe(
      true,
    );
    fillRows();
    expect(fillColumnReason(gd, plain, b!.id)).toBe('the table already has a formula');
    expect(fillColumnWith(gd, plain, b!.id, { op: 'Diff', sets: [e, c], shape: 'column' })).toBe(
      false,
    );
    fillRows();
    expect(colText(plain)).toEqual(['a', 'b', 'c']);
  });

  test('SET-09 SET-10 the note and any added column of a One-column-per-set product offer no Fill, so no member column goes blank', () => {
    const e = set('E', 1, ['a', 'b']);
    const c = set('C', 4, ['x', 'y']);
    const p = addTableOfKind(gd, {
      sheetId,
      at: { col: 1, row: 10 },
      kind: 'product',
      pick: { op: 'Cross', sets: [e, c], shape: 'spread' },
    })!;
    fillRows();
    const note = tableById(gd, p)!.columns[2]!.id;
    const extra = addColumn(gd, p, { label: 'extra' });
    for (const colId of [note, extra]) {
      expect(fillColumnReason(gd, p, colId)).toBe('the table already has a formula');
      expect(fillColumnWith(gd, p, colId, { op: 'Union', sets: [e, c], shape: 'column' })).toBe(
        false,
      );
    }
    fillRows();
    const rec = tableById(gd, p)!;
    expect(rec.computedFormula).toMatch(/^=Cross\(/);
    expect(colText(p, 0)).toEqual(['a', 'a', 'b', 'b']);
    expect(colText(p, 1)).toEqual(['x', 'y', 'x', 'y']);
  });

  test('SET-10 MENU-03 a derived column is not empty: Fill is disabled with the reason and its derivation stays', () => {
    const e = set('E', 1, ['a']);
    const plain = createTable(gd, { sheetId, at: { col: 1, row: 10 }, columns: 1, rows: 1 });
    const source = tableById(gd, plain)!.columns[0]!;
    setCellText(gd, plain, tableById(gd, plain)!.rows[0]!, source.id, 'word');
    const derived = addDerivedColumn(gd, plain, {
      sourceColId: source.id,
      method: 'Concat',
      args: [' ✓'],
    })!;
    expect(fillColumnReason(gd, plain, derived)).toBe('the column is derived');
    expect(fillColumnWith(gd, plain, derived, { op: 'Power', sets: [e], shape: 'column' })).toBe(
      false,
    );
    const column = tableById(gd, plain)!.columns.find((x) => x.id === derived)!;
    expect(column.source).toBe('derived');
    expect(column.derive).not.toBeNull();
  });

  test('SET-10 SET-02 a set’s own range column cannot be filled from itself', () => {
    const f = addTableOfKind(gd, { sheetId, at: { col: 1, row: 1 }, kind: 'simple' })!;
    setTableTitle(gd, f, 'F');
    const e = set('E', 4, ['a', 'b']);
    const range = tableById(gd, f)!.columns[0]!.id;
    expect(fillColumnReason(gd, f, range)).toBeUndefined();
    expect(fillColumnWith(gd, f, range, { op: 'Union', sets: [f, e], shape: 'column' })).toBe(
      false,
    );
    expect(tableById(gd, f)!.columns[0]!.source).toBe('entered');
    // From the other sets it fills.
    expect(fillColumnWith(gd, f, range, { op: 'Power', sets: [e], shape: 'column' })).toBe(true);
  });
});

describe('Phase 3 red-team regressions: SET-01 the kind changes', () => {
  test('SET-01 a table with no typed value changes kind; a typed value stops it with the reason', () => {
    const id = addTableOfKind(gd, { sheetId, at: { col: 1, row: 1 }, kind: 'plain' })!;
    expect(tableKindReason(gd, id)).toBeUndefined();
    expect(kindChoices(gd, id)).toEqual([
      { kind: 'plain', reason: undefined },
      { kind: 'simple', reason: undefined },
      { kind: 'family', reason: undefined },
      { kind: 'computed', reason: 'Fill a column with a formula first' },
      { kind: 'product', reason: 'Fill a column with a formula first' },
    ]);
    expect(changeTableKind(gd, id, 'simple')).toBe(true);
    expect(tableById(gd, id)!.kind).toBe('simple');
    expect(setsOnSheet(gd, sheetId).map((s) => s.tableId)).toEqual([id]);
    const record = tableById(gd, id)!;
    setCellText(gd, id, record.rows[0]!, record.columns[0]!.id, 'a');
    expect(tableKindReason(gd, id)).toBe('the table holds typed values');
    expect(changeTableKind(gd, id, 'plain')).toBe(false);
    expect(tableById(gd, id)!.kind).toBe('simple');
  });
});
