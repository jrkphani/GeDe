/**
 * Owner rulings of 2026-10-10 on computed tables (ADR-056, SPEC §2): one formula per table,
 * spread columns re-fit to it, computed rows cannot be deleted, and merge-time repairs.
 * Every concurrent case runs in both client-id orders.
 */
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  deleteRow,
  openDocument,
  rowMeta,
  rowMetaMap,
  rowsArray,
  setCellText,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { FormulaEngine } from '../engine/engine.js';
import { observeWorkbook } from '../engine/snapshot.js';
import type { CellResult } from '../engine/types.js';
import type { Id } from '../ids.js';
import {
  computedItemsOf,
  computedRowId,
  reconcileComputed,
  setComputedColumn,
  setTableFormula,
} from './computed.js';

function replica(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const gd = openDocument(doc);
  const results = new Map<string, CellResult>();
  const engine = new FormulaEngine();
  observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  });
  return { doc, gd, results };
}
type Replica = ReturnType<typeof replica>;

function handOff(r: Replica): number {
  let w = 0;
  for (const h of computedItemsOf(r.gd, (id) => r.results.get(id))) {
    w += reconcileComputed(r.gd, h.tableId, h.items, h.members);
  }
  return w;
}

function send(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function settle(a: Replica, b: Replica, rounds = 4): void {
  for (let i = 0; i < rounds; i += 1) {
    handOff(a);
    handOff(b);
    send(a.doc, b.doc);
    send(b.doc, a.doc);
  }
}

const rowsOf = (gd: GedeDoc, tableId: Id): readonly Id[] => tableById(gd, tableId)?.rows ?? [];
const sourcesOf = (gd: GedeDoc, tableId: Id) =>
  tableById(gd, tableId)?.columns.map((c) => c.source) ?? [];

function textAt(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): string {
  const table = tableMap(gd, tableId);
  return table === null ? '' : cellText(table, rowId, colId);
}

function setUp(a: Replica, columns = 2, formula = '=Union("a", "b")') {
  const sheetId = createSheet(a.gd);
  const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns, rows: 0 });
  const ids = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
  expect(setTableFormula(a.gd, tableId, formula)).toBe(true);
  expect(setComputedColumn(a.gd, tableId, ids[0] ?? '', { shape: 'column' })).toBe(true);
  handOff(a);
  return { tableId, range: ids[0] ?? '', notes: ids[1] ?? '' };
}

/** What `deleteRow` did before ruling (c), as an older client still may: the row and its meta go. */
function olderClientDelete(gd: GedeDoc, tableId: Id, rowId: Id): void {
  const table = tableMap(gd, tableId);
  if (table === null) throw new Error('no table');
  gd.doc.transact(() => {
    const rows = rowsArray(table);
    rows.delete(rows.toArray().indexOf(rowId), 1);
    rowMetaMap(table).delete(rowId);
  }, gd.origin);
}

const ORDERS = [
  [1, 2],
  [2, 1],
] as const;

describe('SET-08 ruling (c): a computed row cannot be deleted', () => {
  test('SET-08 deleteRow refuses a computed row and a lost one; a row no longer computed can go', () => {
    const a = replica(1);
    const { tableId, notes } = setUp(a);
    const rowA = computedRowId(tableId, 'a');
    const rowB = computedRowId(tableId, 'b');
    expect(deleteRow(a.gd, tableId, rowA)).toBe(false);
    setCellText(a.gd, tableId, rowB, notes, 'kept');
    setTableFormula(a.gd, tableId, '=Union("a", "")');
    handOff(a);
    expect(rowMeta(tableMap(a.gd, tableId)!, rowB).lostFrom).not.toBeNull();
    expect(deleteRow(a.gd, tableId, rowB)).toBe(false);
    expect(rowsOf(a.gd, tableId)).toEqual([rowA, rowB]);
    // A hand-added row is not computed: it deletes as any row does.
    const table = tableMap(a.gd, tableId)!;
    a.gd.doc.transact(() => {
      rowsArray(table).push(['hand']);
    });
    expect(deleteRow(a.gd, tableId, 'hand')).toBe(true);
  });

  test('SET-12 a lost row leaves once its typed value is cleared', () => {
    const a = replica(1);
    const { tableId, notes } = setUp(a);
    const rowB = computedRowId(tableId, 'b');
    setCellText(a.gd, tableId, rowB, notes, 'kept');
    setTableFormula(a.gd, tableId, '=Union("a", "")');
    handOff(a);
    expect(rowsOf(a.gd, tableId)).toContain(rowB);
    setCellText(a.gd, tableId, rowB, notes, '');
    handOff(a);
    expect(rowsOf(a.gd, tableId)).not.toContain(rowB);
  });

  for (const [ca, cb] of ORDERS) {
    const order = `(clients ${String(ca)},${String(cb)})`;

    test(`SET-08 a keyless row left by an older client's delete and a concurrent re-insert heals ${order}`, () => {
      const a = replica(ca);
      const { tableId } = setUp(a);
      const b = replica(cb);
      send(a.doc, b.doc);
      const rowA = computedRowId(tableId, 'a');
      // A (an older client) deletes row a; B, concurrently, drops a's key and brings it back.
      olderClientDelete(a.gd, tableId, rowA);
      setTableFormula(b.gd, tableId, '=Union("b", "")');
      handOff(b);
      setTableFormula(b.gd, tableId, '=Union("a", "b")');
      handOff(b);
      send(a.doc, b.doc);
      send(b.doc, a.doc);
      // Row a is back with no key on both replicas; before anyone reconciles, a's key leaves.
      for (const r of [a, b]) {
        expect(rowsOf(r.gd, tableId)).toContain(rowA);
        expect(rowMeta(tableMap(r.gd, tableId)!, rowA).computedKey).toBeNull();
      }
      setTableFormula(a.gd, tableId, '=Union("b", "")');
      send(a.doc, b.doc);
      settle(a, b);
      for (const r of [a, b]) {
        expect(rowsOf(r.gd, tableId)).toEqual([computedRowId(tableId, 'b')]);
        expect(handOff(r)).toBe(0);
      }
    });

    test(`SET-12 a keyless row holding a note is kept and labelled lost ${order}`, () => {
      const a = replica(ca);
      const { tableId, notes } = setUp(a);
      const b = replica(cb);
      send(a.doc, b.doc);
      const rowA = computedRowId(tableId, 'a');
      olderClientDelete(a.gd, tableId, rowA);
      setTableFormula(b.gd, tableId, '=Union("b", "")');
      handOff(b);
      setTableFormula(b.gd, tableId, '=Union("a", "b")');
      handOff(b);
      setCellText(b.gd, tableId, rowA, notes, 'n');
      send(a.doc, b.doc);
      send(b.doc, a.doc);
      setTableFormula(a.gd, tableId, '=Union("b", "")');
      send(a.doc, b.doc);
      settle(a, b);
      for (const r of [a, b]) {
        const table = tableMap(r.gd, tableId)!;
        expect(rowsOf(r.gd, tableId)).toContain(rowA);
        expect(rowMeta(table, rowA).computedKey).toBe('a');
        expect(rowMeta(table, rowA).lostFrom).not.toBeNull();
        expect(handOff(r)).toBe(0);
      }
    });

    test(`SET-12 a noted row restored while the formula is refused carries the lost label ${order}`, () => {
      const a = replica(ca);
      const { tableId, range, notes } = setUp(a, 2, '=Union("a", "b", "c")');
      const b = replica(cb);
      send(a.doc, b.doc);
      setTableFormula(a.gd, tableId, '=Union("b", "c")');
      handOff(a); // a leaves on A
      const rowA = computedRowId(tableId, 'a');
      setCellText(b.gd, tableId, rowA, notes, 'n'); // B notes a, unaware
      setTableFormula(a.gd, tableId, '=Union("")'); // refused (arity)
      settle(a, b);
      for (const r of [a, b]) {
        expect(rowsOf(r.gd, tableId)).toContain(rowA);
        expect(rowMeta(tableMap(r.gd, tableId)!, rowA).lostFrom).toBe(range);
      }
    });
  }
});

describe('SET-09 ruling (b): spread columns re-fit to the formula', () => {
  test('SET-09 a change in the number of sets adds or removes member columns; typed neighbours stay', () => {
    const a = replica(1);
    const sheetId = createSheet(a.gd);
    const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 0 });
    const [c0 = '', c1 = '', note = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
    setTableFormula(a.gd, tableId, '=Cross(Union("x", "y"), Union("1", "2"))');
    setComputedColumn(a.gd, tableId, c0, { shape: 'spread', spreadIndex: 0 });
    setComputedColumn(a.gd, tableId, c1, { shape: 'spread', spreadIndex: 1 });
    handOff(a);
    const first = rowsOf(a.gd, tableId)[0] ?? '';
    setCellText(a.gd, tableId, first, note, 'n');
    const undo = createUndoManager(a.gd, { captureTimeout: 0 });

    expect(setTableFormula(a.gd, tableId, '=Cross(Union("x", "y"), Union("1", "2"), "p")')).toBe(
      true,
    );
    handOff(a);
    const grown = tableById(a.gd, tableId)?.columns ?? [];
    expect(grown.map((c) => c.computed?.spreadIndex ?? null)).toEqual([0, 1, 2, null]);
    expect(grown[2]?.label).toBe('x3');
    expect(grown[3]?.id).toBe(note);
    const tuple = computedRowId(tableId, '(x, 1, p)');
    expect(textAt(a.gd, tableId, tuple, grown[2]?.id ?? '')).toBe('p');
    expect(textAt(a.gd, tableId, first, note)).toBe('n');

    setTableFormula(a.gd, tableId, '=Cross("x, y", "1")');
    handOff(a);
    expect(tableById(a.gd, tableId)?.columns.map((c) => c.id)).toEqual([c0, c1, note]);
    expect(textAt(a.gd, tableId, first, note)).toBe('n');

    // Each formula change is one undo step, its columns with it.
    undo.undo();
    handOff(a);
    expect(tableById(a.gd, tableId)?.columns).toHaveLength(4);
    undo.undo();
    handOff(a);
    expect(tableById(a.gd, tableId)?.columns.map((c) => c.id)).toEqual([c0, c1, note]);
    expect(tableById(a.gd, tableId)?.computedFormula).toBe(
      '=Cross(Union("x", "y"), Union("1", "2"))',
    );
  });

  for (const [ca, cb] of ORDERS) {
    const order = `(clients ${String(ca)},${String(cb)})`;

    test(`SET-09 two replicas growing the spread at once converge on one member column per set ${order}`, () => {
      const a = replica(ca);
      const sheetId = createSheet(a.gd);
      const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
      const [c0 = '', c1 = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
      setTableFormula(a.gd, tableId, '=Cross("x", "1")');
      setComputedColumn(a.gd, tableId, c0, { shape: 'spread', spreadIndex: 0 });
      setComputedColumn(a.gd, tableId, c1, { shape: 'spread', spreadIndex: 1 });
      handOff(a);
      const b = replica(cb);
      send(a.doc, b.doc);
      setTableFormula(a.gd, tableId, '=Cross("x", "1", "p")');
      setTableFormula(b.gd, tableId, '=Cross("x", "1", "q")');
      settle(a, b);
      for (const r of [a, b]) {
        expect(tableById(r.gd, tableId)?.columns.map((c) => c.computed?.spreadIndex)).toEqual([
          0, 1, 2,
        ]);
        expect(handOff(r)).toBe(0);
      }
      expect(tableById(a.gd, tableId)?.columns.map((c) => c.id)).toEqual(
        tableById(b.gd, tableId)?.columns.map((c) => c.id),
      );
    });

    test(`SET-10 a spread Fill made one column at a time is refused whole ${order}`, () => {
      const a = replica(ca);
      const sheetId = createSheet(a.gd);
      const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 1 });
      const [c0 = '', c1 = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
      const hand = rowsOf(a.gd, tableId)[0] ?? '';
      const b = replica(cb);
      send(a.doc, b.doc);
      setCellText(b.gd, tableId, hand, c1, 'typed');
      setTableFormula(a.gd, tableId, '=Cross(Union("x", "y"), Union("1", "2"))');
      expect(setComputedColumn(a.gd, tableId, c0, { shape: 'spread', spreadIndex: 0 })).toBe(true);
      expect(setComputedColumn(a.gd, tableId, c1, { shape: 'spread', spreadIndex: 1 })).toBe(true);
      handOff(a);
      settle(a, b);
      for (const r of [a, b]) {
        expect(sourcesOf(r.gd, tableId)).toEqual(['entered', 'entered', 'entered']);
        expect(textAt(r.gd, tableId, hand, c1)).toBe('typed');
      }
    });
  }
});

/** A table whose first `members` columns spread `formula`, plus `notes` typed columns. */
function spreadTable(a: Replica, formula = '=Cross("x", "1")', members = 2, notes = 0) {
  const sheetId = createSheet(a.gd);
  const tableId = createTable(a.gd, {
    sheetId,
    at: { col: 1, row: 1 },
    columns: members + notes,
    rows: 0,
  });
  const ids = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
  expect(setTableFormula(a.gd, tableId, formula)).toBe(true);
  ids.slice(0, members).forEach((id, spreadIndex) => {
    expect(setComputedColumn(a.gd, tableId, id, { shape: 'spread', spreadIndex })).toBe(true);
  });
  handOff(a);
  return { tableId, ids };
}

const spreadIdx = (gd: GedeDoc, tableId: Id) =>
  (tableById(gd, tableId)?.columns ?? [])
    .filter((c) => c.computed?.shape === 'spread')
    .map((c) => c.computed?.spreadIndex);

describe('SET-09 a Cross of the wrong arity reconciles nothing', () => {
  test('SET-09 an intermediate =Cross() keeps the spread columns and the rows', () => {
    const a = replica(1);
    const { tableId, ids } = spreadTable(a);
    const before = rowsOf(a.gd, tableId);
    expect(before).toHaveLength(1);
    for (const f of ['=Cross()', '=Cross("x")']) {
      expect(setTableFormula(a.gd, tableId, f)).toBe(true);
      handOff(a);
      expect(spreadIdx(a.gd, tableId)).toEqual([0, 1]);
      expect(tableById(a.gd, tableId)?.columns.map((c) => c.id)).toEqual(ids);
      expect(rowsOf(a.gd, tableId)).toEqual(before);
    }
    expect(setTableFormula(a.gd, tableId, '=Cross("x", "1")')).toBe(true);
    handOff(a);
    expect(spreadIdx(a.gd, tableId)).toEqual([0, 1]);
    expect(rowsOf(a.gd, tableId)).toEqual(before);
  });

  test('SET-11 a note beside a tuple keeps its key through a transient =Cross()', () => {
    const a = replica(1);
    const { tableId, ids } = spreadTable(a, '=Cross("x, y", "1")', 2, 1);
    const tuple = computedRowId(tableId, '(y, 1)');
    setCellText(a.gd, tableId, tuple, ids[2] ?? '', 'n');
    setTableFormula(a.gd, tableId, '=Cross()');
    handOff(a);
    setTableFormula(a.gd, tableId, '=Cross("x, y", "1")');
    handOff(a);
    expect(rowMeta(tableMap(a.gd, tableId)!, tuple).computedKey).toBe('(y, 1)');
    expect(textAt(a.gd, tableId, tuple, ids[2] ?? '')).toBe('n');
  });
});

describe('SET-12 a lost row leaves once its typed value is cleared, with no result to hand', () => {
  test('SET-12 a soundness pass (no items) removes an untyped lost row', () => {
    const a = replica(1);
    const { tableId, notes } = setUp(a);
    const rowB = computedRowId(tableId, 'b');
    setCellText(a.gd, tableId, rowB, notes, 'kept');
    setTableFormula(a.gd, tableId, '=Union("a", "")');
    handOff(a);
    expect(rowMeta(tableMap(a.gd, tableId)!, rowB).lostFrom).not.toBeNull();
    setCellText(a.gd, tableId, rowB, notes, '');
    reconcileComputed(a.gd, tableId, null);
    expect(rowsOf(a.gd, tableId)).toEqual([computedRowId(tableId, 'a')]);
  });
});

describe('SET-09 concurrent widen and narrow of a spread', () => {
  for (const [ca, cb] of ORDERS) {
    const order = `(clients ${String(ca)},${String(cb)})`;
    test(`SET-09 a 3-set spread narrowed to 2 on one replica and widened to 4 on the other converges whole ${order}`, () => {
      const a = replica(ca);
      const { tableId } = spreadTable(a, '=Cross("x", "1", "p")', 3);
      const b = replica(cb);
      send(a.doc, b.doc);
      setTableFormula(a.gd, tableId, '=Cross("x", "1", "p", "z")');
      setTableFormula(b.gd, tableId, '=Cross("x", "1")');
      settle(a, b);
      const f = tableById(a.gd, tableId)?.computedFormula ?? '';
      const width = f === '=Cross("x", "1")' ? 2 : 4;
      for (const r of [a, b]) {
        expect(tableById(r.gd, tableId)?.computedFormula).toBe(f);
        expect(spreadIdx(r.gd, tableId)).toEqual(Array.from({ length: width }, (_, i) => i));
        expect(handOff(r)).toBe(0);
      }
      expect(tableById(a.gd, tableId)?.columns.map((c) => c.id)).toEqual(
        tableById(b.gd, tableId)?.columns.map((c) => c.id),
      );
    });
  }
});
