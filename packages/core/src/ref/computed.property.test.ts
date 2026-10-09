/**
 * Computed tables under concurrency (SET-08, SET-09, SET-10, SET-11, SET-12): edge results,
 * spread refusal after a merge, and a two-replica property run with and without the grid orphan sweep.
 */
import fc from 'fast-check';
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
  setCellText,
  sweepOrphanCells,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { FormulaEngine } from '../engine/engine.js';
import { observeWorkbook } from '../engine/snapshot.js';
import type { CellResult } from '../engine/types.js';
import { type Id } from '../ids.js';
import {
  computedItemsOf,
  computedRowId,
  reconcileComputed,
  setComputedColumn,
  setComputedColumns,
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

/**
 * What `use-grid.ts` does on every replica with a grid mounted: a structural delete
 * (rows or columns array) observed on `gd.tables`, local or remote, sweeps orphan cells.
 */
function installGridSweep(gd: GedeDoc): void {
  gd.tables.observeDeep((events) => {
    for (const event of events) {
      if (!(event instanceof Y.YArrayEvent) || event.changes.deleted.size === 0) continue;
      const parent = event.target.parent;
      if (!(parent instanceof Y.Map)) continue;
      if (parent.get('rows') !== event.target && parent.get('columns') !== event.target) continue;
      const tableId: unknown = parent.get('id');
      if (typeof tableId === 'string') sweepOrphanCells(gd, tableId);
    }
  });
}

function setUp(a: Replica, formula = '=Union("a", "b")') {
  const sheetId = createSheet(a.gd);
  const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
  const [range = '', notes = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
  expect(setTableFormula(a.gd, tableId, formula)).toBe(true);
  expect(setComputedColumn(a.gd, tableId, range, { shape: 'column' })).toBe(true);
  handOff(a);
  return { sheetId, tableId, range, notes };
}

function settle(a: Replica, b: Replica, rounds = 4): void {
  for (let i = 0; i < rounds; i += 1) {
    handOff(a);
    handOff(b);
    send(a.doc, b.doc);
    send(b.doc, a.doc);
  }
}

function textAt(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): string {
  const table = tableMap(gd, tableId);
  return table === null ? '' : cellText(table, rowId, colId);
}

function rowsOf(gd: GedeDoc, tableId: Id): readonly Id[] {
  return tableById(gd, tableId)?.rows ?? [];
}

describe('SET-12 notes on removed rows and the grid orphan sweep', () => {
  for (const [ca, cb] of [
    [1, 2],
    [2, 1],
  ] as const) {
    test(`SET-12 a note typed offline on a row whose key then leaves survives the grid's orphan sweep (clients ${String(ca)},${String(cb)})`, () => {
      const a = replica(ca);
      const { tableId, notes } = setUp(a);
      const b = replica(cb);
      send(a.doc, b.doc);
      // Both replicas have the grid mounted, as in the app.
      installGridSweep(a.gd);
      installGridSweep(b.gd);
      const rowB = computedRowId(tableId, 'b');
      // B is offline and types a note on b's row.
      setCellText(b.gd, tableId, rowB, notes, 'offline note');
      // A drops b from the result; the row has no note A can see, so it leaves.
      setTableFormula(a.gd, tableId, '=Union("a", "")');
      handOff(a);
      expect(rowsOf(a.gd, tableId)).not.toContain(rowB);
      // B reconnects.
      for (let i = 0; i < 4; i += 1) {
        send(a.doc, b.doc);
        send(b.doc, a.doc);
        handOff(a);
        handOff(b);
      }
      for (const gd of [a.gd, b.gd]) {
        expect(rowsOf(gd, tableId)).toContain(rowB);
        expect(textAt(gd, tableId, rowB, notes)).toBe('offline note');
      }
    });
  }
});

describe('SET-08 edge results', () => {
  test('SET-08 an element spelled in NFD and in NFC is one row whose key is NFC', () => {
    const a = replica(1);
    const nfd = 'é';
    const { tableId, range } = setUp(a, `=Union("${nfd}", "é", "க்ஷ", "कि")`);
    const table = tableMap(a.gd, tableId);
    if (table === null) throw new Error('no table');
    const rows = rowsOf(a.gd, tableId);
    expect(rows.map((r) => textAt(a.gd, tableId, r, range))).toEqual(['é', 'க்ஷ', 'कि']);
    for (const r of rows) {
      const key = rowMeta(table, r).computedKey ?? '';
      expect(key).toBe(key.normalize('NFC'));
    }
  });

  test('SET-08 duplicates handed to the reconciler fill one row each, and the empty set clears untyped rows only', () => {
    const a = replica(1);
    const { tableId, notes } = setUp(a);
    expect(reconcileComputed(a.gd, tableId, ['a', 'a', 'b', 'b'])).toBe(0);
    expect(rowsOf(a.gd, tableId)).toHaveLength(2);
    setCellText(a.gd, tableId, computedRowId(tableId, 'a'), notes, 'keep');
    reconcileComputed(a.gd, tableId, []);
    expect(rowsOf(a.gd, tableId)).toEqual([computedRowId(tableId, 'a')]);
    const table = tableMap(a.gd, tableId);
    expect(table && rowMeta(table, computedRowId(tableId, 'a')).lostFrom).not.toBeNull();
  });

  test('SET-09 a key holding separators inside parentheses and braces is one row', () => {
    const a = replica(1);
    const { tableId, range } = setUp(a, '=Union("(x, y)", "{p; q}", "a")');
    expect(rowsOf(a.gd, tableId).map((r) => textAt(a.gd, tableId, r, range))).toEqual([
      '(x, y)',
      '{p; q}',
      'a',
    ]);
  });

  test('FX-10 SET-09 a Power past the cap (14 elements) keeps the table as it was', () => {
    const a = replica(1);
    const { tableId } = setUp(a);
    const before = [...rowsOf(a.gd, tableId)];
    const elems = Array.from({ length: 14 }, (_, i) => `"e${String(i)}"`).join(', ');
    setTableFormula(a.gd, tableId, `=Power(Union(${elems}))`);
    handOff(a);
    expect(rowsOf(a.gd, tableId)).toEqual(before);
  });

  test('SET-10 SET-12 undo and redo of Fill column: noted rows survive as plain rows and come back computed', () => {
    const a = replica(1);
    const sheetId = createSheet(a.gd);
    const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
    const [range = '', notes = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
    setTableFormula(a.gd, tableId, '=Union("a", "b", "c")');
    const undo = createUndoManager(a.gd, { captureTimeout: 0 });
    setComputedColumn(a.gd, tableId, range, { shape: 'column' });
    handOff(a);
    undo.stopCapturing();
    setCellText(a.gd, tableId, computedRowId(tableId, 'b'), notes, 'n');
    undo.stopCapturing();
    // Undo only the Fill column step (the note stays).
    const fill = undo.undoStack[0];
    expect(fill).toBeDefined();
    undo.undo(); // note
    undo.undo(); // fill
    handOff(a);
    expect(rowsOf(a.gd, tableId)).toEqual([]);
    undo.redo(); // fill
    handOff(a);
    undo.redo(); // note
    handOff(a);
    expect(rowsOf(a.gd, tableId).map((r) => textAt(a.gd, tableId, r, range))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(textAt(a.gd, tableId, computedRowId(tableId, 'b'), notes)).toBe('n');
    for (let i = 0; i < 3; i += 1) handOff(a);
    expect(handOff(a)).toBe(0);
  });

  test('SET-12 a person deleting a lost row removes it for good', () => {
    const a = replica(1);
    const { tableId, notes } = setUp(a);
    const rowB = computedRowId(tableId, 'b');
    setCellText(a.gd, tableId, rowB, notes, 'n');
    setTableFormula(a.gd, tableId, '=Union("a", "")');
    handOff(a);
    expect(rowsOf(a.gd, tableId)).toContain(rowB);
    deleteRow(a.gd, tableId, rowB);
    for (let i = 0; i < 3; i += 1) handOff(a);
    expect(rowsOf(a.gd, tableId)).not.toContain(rowB);
  });
});

const POOL = ['a', 'b', 'c', 'க', 'कि', '(x, y)', '{p, q}', 'é'] as const;

type Op =
  | { kind: 'formula'; who: 0 | 1; members: boolean[] }
  | { kind: 'note'; who: 0 | 1; key: number; text: string }
  | { kind: 'handoff'; who: 0 | 1 }
  | { kind: 'send'; who: 0 | 1 };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('formula' as const),
    who: fc.constantFrom(0 as const, 1 as const),
    members: fc.array(fc.boolean(), { minLength: POOL.length, maxLength: POOL.length }),
  }),
  fc.record({
    kind: fc.constant('note' as const),
    who: fc.constantFrom(0 as const, 1 as const),
    key: fc.nat(POOL.length - 1),
    text: fc.constantFrom('n1', 'நோட்', 'नोट'),
  }),
  fc.record({
    kind: fc.constant('handoff' as const),
    who: fc.constantFrom(0 as const, 1 as const),
  }),
  fc.record({ kind: fc.constant('send' as const), who: fc.constantFrom(0 as const, 1 as const) }),
);

function snapshot(gd: GedeDoc, tableId: Id, cols: readonly Id[]): unknown {
  const rows = rowsOf(gd, tableId);
  return rows.map((r) => [r, ...cols.map((c) => textAt(gd, tableId, r, c))]);
}

function runProperty(withSweep: boolean): void {
  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 25 }), (ops) => {
      const a = replica(1);
      const { tableId, range, notes } = setUp(a, `=Union(${POOL.map((p) => `"${p}"`).join(', ')})`);
      const b = replica(2);
      send(a.doc, b.doc);
      const reps = [a, b] as const;
      if (withSweep) for (const r of reps) installGridSweep(r.gd);
      /** Rows a note landed on (it was in `rows` when typed). */
      const noted = new Set<Id>();
      for (const op of ops) {
        const r = reps[op.who];
        if (op.kind === 'formula') {
          const picked = POOL.filter((_, i) => op.members[i]);
          const args = picked.length === 0 ? '""' : picked.map((p) => `"${p}"`).join(', ');
          setTableFormula(r.gd, tableId, `=Union(${args})`);
        } else if (op.kind === 'note') {
          const key = POOL[op.key] ?? 'a';
          const row = computedRowId(tableId, key.normalize('NFC'));
          if (setCellText(r.gd, tableId, row, notes, op.text)) noted.add(row);
        } else if (op.kind === 'handoff') {
          handOff(r);
        } else {
          send(r.doc, reps[1 - op.who]?.doc ?? r.doc);
        }
      }
      for (let i = 0; i < 6; i += 1) {
        handOff(a);
        handOff(b);
        send(a.doc, b.doc);
        send(b.doc, a.doc);
      }
      // Quiescent and converged.
      expect(handOff(a)).toBe(0);
      expect(handOff(b)).toBe(0);
      expect(snapshot(a.gd, tableId, [range, notes])).toEqual(
        snapshot(b.gd, tableId, [range, notes]),
      );
      // No note is lost: every row a note landed on is present and holds a note.
      for (const row of noted) {
        expect(rowsOf(a.gd, tableId)).toContain(row);
        expect(textAt(a.gd, tableId, row, notes)).not.toBe('');
      }
      // No row appears twice.
      const rows = rowsOf(a.gd, tableId);
      expect(new Set(rows).size).toBe(rows.length);
    }),
    { numRuns: 300 },
  );
}

describe('SET-09 SET-10 spread shape refusal', () => {
  test('SET-10 a note typed concurrently into one spread column refuses the whole Fill, not half of it', () => {
    const a = replica(1);
    const sheetId = createSheet(a.gd);
    const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 1 });
    const [c0 = '', c1 = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
    const hand = rowsOf(a.gd, tableId)[0] ?? '';
    const b = replica(2);
    send(a.doc, b.doc);
    // B, concurrently, types into the second column of the hand-added row.
    setCellText(b.gd, tableId, hand, c1, 'typed');
    setTableFormula(a.gd, tableId, '=Cross(Union("x", "y"), Union("1", "2"))');
    expect(
      setComputedColumns(a.gd, tableId, [
        { colId: c0, spec: { shape: 'spread', spreadIndex: 0 } },
        { colId: c1, spec: { shape: 'spread', spreadIndex: 1 } },
      ]),
    ).toBe(true);
    handOff(a);
    for (let i = 0; i < 4; i += 1) {
      send(a.doc, b.doc);
      send(b.doc, a.doc);
      handOff(a);
      handOff(b);
    }
    const sources = tableById(a.gd, tableId)?.columns.map((c) => c.source);
    expect(textAt(a.gd, tableId, hand, c1)).toBe('typed');
    // Either both spread columns stay computed or both go back to entered; never one of a pair.
    expect([
      ['computed', 'computed', 'entered'],
      ['entered', 'entered', 'entered'],
    ]).toContainEqual(sources);
  });
});

describe('SET-08 SET-11 SET-12 two-replica property', () => {
  test('SET-08 SET-11 SET-12 random formula changes, notes and partial syncs converge, settle and lose no note', () => {
    runProperty(false);
  });

  test('SET-12 the same property with the grid orphan sweep installed on both replicas', () => {
    runProperty(true);
  });
});

describe('SET-08 SET-10 SET-12 a table with no result to fill from is still kept sound', () => {
  const capped = `=Power(Union(${Array.from({ length: 14 }, (_, i) => `"e${String(i)}"`).join(', ')}))`;

  for (const [ca, cb] of [
    [2, 1],
    [1, 2],
  ] as const) {
    test(`SET-08 FX-10 a row filled on two replicas at once is not left twice when the formula is then refused (clients ${String(ca)},${String(cb)})`, () => {
      const a = replica(ca);
      const { tableId } = setUp(a);
      const b = replica(cb);
      send(a.doc, b.doc);
      for (const r of [a, b]) installGridSweep(r.gd);
      setTableFormula(a.gd, tableId, '=Union("a", "b", "z")');
      handOff(a);
      setTableFormula(b.gd, tableId, '=Union("a", "b", "z")');
      handOff(b);
      setTableFormula(a.gd, tableId, capped);
      handOff(a);
      settle(a, b, 8);
      for (const r of [a, b]) {
        const rows = rowsOf(r.gd, tableId);
        expect(new Set(rows).size).toBe(rows.length);
        expect(rows).toHaveLength(3);
      }
      expect(handOff(a)).toBe(0);
      expect(handOff(b)).toBe(0);
    });
  }

  test('SET-08 a deleted computed row, undone while another replica re-fills it, is not left twice under an erroring formula', () => {
    const a = replica(1);
    const { tableId } = setUp(a);
    const b = replica(2);
    send(a.doc, b.doc);
    const rowA = computedRowId(tableId, 'a');
    const undo = createUndoManager(a.gd, { captureTimeout: 0 });
    deleteRow(a.gd, tableId, rowA);
    send(a.doc, b.doc);
    handOff(b); // B re-fills row a
    undo.undo(); // A brings row a back
    setTableFormula(a.gd, tableId, '=Union("")'); // arity error
    send(b.doc, a.doc);
    settle(a, b, 8);
    for (const r of [a, b]) {
      const rows = rowsOf(r.gd, tableId);
      expect(new Set(rows).size).toBe(rows.length);
    }
  });

  test('SET-08 a once-filled table whose formula is gone still dedupes its rows', () => {
    const a = replica(1);
    const { tableId } = setUp(a);
    const table = tableMap(a.gd, tableId);
    if (table === null) throw new Error('no table');
    const rows = table.get('rows');
    if (!(rows instanceof Y.Array)) throw new Error('no rows');
    a.doc.transact(() => {
      table.delete('computedFormula');
      rows.push([computedRowId(tableId, 'a')]);
    });
    handOff(a);
    expect(rowsOf(a.gd, tableId)).toEqual([
      computedRowId(tableId, 'a'),
      computedRowId(tableId, 'b'),
    ]);
    expect(handOff(a)).toBe(0);
  });

  for (const formula of ['=Union("x")', capped]) {
    test(`SET-10 a value typed concurrently with Fill column is refused even while the formula errors or is capped (${formula.slice(0, 12)})`, () => {
      const a = replica(1);
      const sheetId = createSheet(a.gd);
      const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 1 });
      const [c0 = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
      const hand = rowsOf(a.gd, tableId)[0] ?? '';
      const b = replica(2);
      send(a.doc, b.doc);
      setCellText(b.gd, tableId, hand, c0, 'typed');
      setTableFormula(a.gd, tableId, formula);
      expect(setComputedColumn(a.gd, tableId, c0, { shape: 'column' })).toBe(true);
      handOff(a);
      settle(a, b);
      for (const r of [a, b]) {
        expect(tableById(r.gd, tableId)?.columns[0]?.source).toBe('entered');
        expect(textAt(r.gd, tableId, hand, c0)).toBe('typed');
      }
    });
  }

  test('SET-10 refusing a later spread column does not unfill an earlier, settled spread Fill', () => {
    const a = replica(1);
    const sheetId = createSheet(a.gd);
    const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 4, rows: 1 });
    const [c0 = '', c1 = '', c2 = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
    const hand = rowsOf(a.gd, tableId)[0] ?? '';
    setTableFormula(a.gd, tableId, '=Cross(Union("x", "y"), Union("1", "2"))');
    setComputedColumns(a.gd, tableId, [
      { colId: c0, spec: { shape: 'spread', spreadIndex: 0 } },
      { colId: c1, spec: { shape: 'spread', spreadIndex: 1 } },
    ]);
    handOff(a);
    const b = replica(2);
    send(a.doc, b.doc);
    setCellText(b.gd, tableId, hand, c2, 'typed');
    setTableFormula(a.gd, tableId, '=Cross(Union("x", "y"), Union("1", "2"), Union("p", "q"))');
    setComputedColumn(a.gd, tableId, c2, { shape: 'spread', spreadIndex: 2 });
    handOff(a);
    settle(a, b);
    expect(tableById(a.gd, tableId)?.columns.map((c) => c.source)).toEqual([
      'computed',
      'computed',
      'entered',
      'entered',
    ]);
    // The settled Fill keeps its eight tuple rows, plus the hand-added row.
    expect(rowsOf(a.gd, tableId)).toHaveLength(9);
    expect(textAt(a.gd, tableId, hand, c2)).toBe('typed');
  });

  test('SET-12 a noted row another replica removed comes back while the formula is refused', () => {
    const a = replica(1);
    const { tableId, notes } = setUp(a, `=Union(${POOL.map((p) => `"${p}"`).join(', ')})`);
    const b = replica(2);
    send(a.doc, b.doc);
    installGridSweep(a.gd);
    installGridSweep(b.gd);
    setTableFormula(a.gd, tableId, '=Union("க", "é")');
    send(a.doc, b.doc); // B sees the new formula, not the note
    const rowA = computedRowId(tableId, 'a');
    setCellText(a.gd, tableId, rowA, notes, 'n1');
    setTableFormula(a.gd, tableId, '=Union("")'); // refused (arity)
    settle(a, b);
    for (const r of [a, b]) {
      expect(rowsOf(r.gd, tableId)).toContain(rowA);
      expect(textAt(r.gd, tableId, rowA, notes)).toBe('n1');
    }
  });
});
