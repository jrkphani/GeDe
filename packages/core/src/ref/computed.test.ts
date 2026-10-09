import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellReadOnlyReason,
  cellText,
  createSheet,
  createTable,
  openDocument,
  rowMeta,
  setCellText,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { FormulaEngine } from '../engine/engine.js';
import { observeWorkbook } from '../engine/snapshot.js';
import type { CellResult } from '../engine/types.js';
import { isId, type Id } from '../ids.js';
import {
  computedItemsOf,
  computedOperandsLabel,
  computedRowId,
  reconcileComputed,
  setComputedColumn,
} from './computed.js';

function harness() {
  const doc = new Y.Doc();
  const gd = openDocument(doc);
  const engine = new FormulaEngine();
  const results = new Map<string, CellResult>();
  observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  });
  const sheetId = createSheet(gd);
  return { doc, gd, results, sheetId };
}

/** A table whose first column is computed from `formula`; the second column takes notes. */
function computedTable(gd: GedeDoc, sheetId: Id, formula: string) {
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
  const record = tableById(gd, tableId);
  const [range, notes] = record?.columns ?? [];
  if (range === undefined || notes === undefined) throw new Error('shape');
  expect(setComputedColumn(gd, tableId, range.id, { formula, shape: 'column' })).toBe(true);
  return { tableId, range: range.id, notes: notes.id };
}

function rowsOf(gd: GedeDoc, tableId: Id): readonly Id[] {
  return tableById(gd, tableId)?.rows ?? [];
}

function textAt(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): string {
  const table = tableMap(gd, tableId);
  return table === null ? '' : cellText(table, rowId, colId);
}

/** Both replicas' pending diffs crosswise until neither changes; returns the rounds. */
function exchange(a: Y.Doc, b: Y.Doc): number {
  let changed = 0;
  const bump = (): void => {
    changed += 1;
  };
  a.on('update', bump);
  b.on('update', bump);
  let rounds = 0;
  try {
    for (; rounds < 30; rounds += 1) {
      const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      changed = 0;
      Y.applyUpdate(b, ua);
      Y.applyUpdate(a, ub);
      if (changed === 0) break;
    }
  } finally {
    a.off('update', bump);
    b.off('update', bump);
  }
  return rounds;
}

describe('SET-08 computed column reconciler', () => {
  test('SET-08 one row per result element, in result order, with deterministic ids and read-only computed cells', () => {
    const { gd, sheetId } = harness();
    const { tableId, range, notes } = computedTable(gd, sheetId, '=Union("a, b", "c")');
    expect(reconcileComputed(gd, tableId, ['a', 'b', 'c'])).toBeGreaterThan(0);
    const rows = rowsOf(gd, tableId);
    expect(rows).toEqual(['a', 'b', 'c'].map((k) => computedRowId(tableId, k)));
    expect(rows.every(isId)).toBe(true);
    expect(computedRowId(tableId, 'a')).not.toBe(computedRowId('other', 'a'));
    expect(rows.map((r) => textAt(gd, tableId, r, range))).toEqual(['a', 'b', 'c']);
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('no table');
    const [first = ''] = rows;
    expect(rowMeta(table, first)).toMatchObject({ computedKey: 'a', lostFrom: null });
    expect(cellReadOnlyReason(table, first, range)).toBe('computed');
    expect(cellReadOnlyReason(table, first, notes)).toBeNull();
    // Idempotent: a second pass over the same result writes nothing.
    expect(reconcileComputed(gd, tableId, ['a', 'b', 'c'])).toBe(0);
  });

  test('SET-08 a table written before ADR-056 reads as plain with no computed provenance', () => {
    const { gd, sheetId } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 1 });
    const record = tableById(gd, tableId);
    const table = tableMap(gd, tableId);
    if (record === null || table === null) throw new Error('no table');
    expect(record.kind).toBe('plain');
    expect(record.columns[0]?.computed).toBeNull();
    expect(rowMeta(table, record.rows[0] ?? '')).toMatchObject({
      computedKey: null,
      lostFrom: null,
    });
  });

  test('SET-10 a column holding a typed value is not made computed', () => {
    const { gd, sheetId } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 1 });
    const record = tableById(gd, tableId);
    const colId = record?.columns[0]?.id ?? '';
    setCellText(gd, tableId, record?.rows[0] ?? '', colId, 'typed');
    expect(setComputedColumn(gd, tableId, colId, { formula: '=Union("a")', shape: 'column' })).toBe(
      false,
    );
    expect(tableById(gd, tableId)?.columns[0]?.source).toBe('entered');
  });

  test('SET-08 two replicas reconciling concurrently converge and then write nothing', () => {
    const a = harness();
    const { tableId, range, notes } = computedTable(a.gd, a.sheetId, '=Cross("a, b", "x, y")');
    const b = openDocument(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const result = ['(a, x)', '(a, y)', '(b, x)', '(b, y)'];
    // Each replica reconciles before it sees the other's writes.
    reconcileComputed(a.gd, tableId, result);
    reconcileComputed(b, tableId, result);
    // A person on B types a note on a hand-added row meanwhile.
    const hand = addRow(b, tableId);
    setCellText(b, tableId, hand, notes, 'by hand');
    expect(exchange(a.doc, b.doc)).toBeLessThan(30);
    expect(rowsOf(a.gd, tableId)).toEqual(rowsOf(b, tableId));
    // Both inserted the same ids, so the merge holds each twice; the next pass on each
    // replica deletes the same later copies, and after that nobody writes again.
    reconcileComputed(a.gd, tableId, result);
    reconcileComputed(b, tableId, result);
    expect(exchange(a.doc, b.doc)).toBeLessThan(30);
    const rowsA = rowsOf(a.gd, tableId);
    expect(rowsA).toEqual(rowsOf(b, tableId));
    expect(new Set(rowsA).size).toBe(rowsA.length);
    expect(rowsA.filter((r) => r !== hand)).toEqual(result.map((k) => computedRowId(tableId, k)));
    expect(reconcileComputed(a.gd, tableId, result)).toBe(0);
    expect(reconcileComputed(b, tableId, result)).toBe(0);
    expect(textAt(b, tableId, computedRowId(tableId, '(b, y)'), range)).toBe('(b, y)');
    expect(textAt(a.gd, tableId, hand, notes)).toBe('by hand');
  });

  test('SET-11 a reorder of the result keeps neighbouring values on their keys', () => {
    const { gd, sheetId } = harness();
    const { tableId, notes } = computedTable(gd, sheetId, '=Union("a, b, c")');
    reconcileComputed(gd, tableId, ['a', 'b', 'c']);
    const idOf = (k: string): Id => computedRowId(tableId, k);
    setCellText(gd, tableId, idOf('a'), notes, 'note on a');
    setCellText(gd, tableId, idOf('c'), notes, 'note on c');
    expect(reconcileComputed(gd, tableId, ['c', 'a', 'b'])).toBeGreaterThan(0);
    expect(rowsOf(gd, tableId)).toEqual(['c', 'a', 'b'].map(idOf));
    expect(textAt(gd, tableId, idOf('a'), notes)).toBe('note on a');
    expect(textAt(gd, tableId, idOf('c'), notes)).toBe('note on c');
    expect(textAt(gd, tableId, idOf('b'), notes)).toBe('');
    expect(reconcileComputed(gd, tableId, ['c', 'a', 'b'])).toBe(0);
  });

  test('SET-12 a lost key with a typed value stays in place, marked lost; without one it leaves; a returning key reclaims its row', () => {
    const { gd, sheetId } = harness();
    const { tableId, range, notes } = computedTable(gd, sheetId, '=Union("a, b, c")');
    reconcileComputed(gd, tableId, ['a', 'b', 'c']);
    const idOf = (k: string): Id => computedRowId(tableId, k);
    setCellText(gd, tableId, idOf('b'), notes, 'keep me');
    reconcileComputed(gd, tableId, ['a']);
    // b holds a note: it stays where it was, dimmed by `lostFrom`; c had nothing typed and left.
    expect(rowsOf(gd, tableId)).toEqual([idOf('a'), idOf('b')]);
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('no table');
    expect(rowMeta(table, idOf('b'))).toMatchObject({ computedKey: 'b', lostFrom: range });
    expect(rowMeta(table, idOf('a')).lostFrom).toBeNull();
    expect(reconcileComputed(gd, tableId, ['a'])).toBe(0);
    // b and c come back: b reclaims its row and its note; c is a fresh row.
    reconcileComputed(gd, tableId, ['a', 'b', 'c']);
    expect(rowsOf(gd, tableId)).toEqual(['a', 'b', 'c'].map(idOf));
    expect(rowMeta(table, idOf('b')).lostFrom).toBeNull();
    expect(textAt(gd, tableId, idOf('b'), notes)).toBe('keep me');
    expect(textAt(gd, tableId, idOf('c'), range)).toBe('c');
  });

  test('SET-09 spread shape writes each tuple member into the column at its index', () => {
    const { gd, sheetId } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 0 });
    const cols = tableById(gd, tableId)?.columns.map((c) => c.id) ?? [];
    const formula = '=Cross("a, b", "(1, 2), z", "x")';
    cols.forEach((colId, spreadIndex) => {
      expect(setComputedColumn(gd, tableId, colId, { formula, shape: 'spread', spreadIndex })).toBe(
        true,
      );
    });
    reconcileComputed(gd, tableId, ['(a, (1, 2), x)', '(b, z, x)']);
    const [r0 = '', r1 = ''] = rowsOf(gd, tableId);
    expect(cols.map((c) => textAt(gd, tableId, r0, c))).toEqual(['a', '(1, 2)', 'x']);
    expect(cols.map((c) => textAt(gd, tableId, r1, c))).toEqual(['b', 'z', 'x']);
  });
});

describe('SET-08 engine hand-off', () => {
  test('SET-08 the engine evaluates the column formula once and hands its items to the reconciler', () => {
    const { gd, sheetId, results } = harness();
    const { tableId, range } = computedTable(gd, sheetId, '=Cross("a, b", "x, y")');
    const handOff = computedItemsOf(gd, (id) => results.get(id));
    expect(handOff).toEqual([
      { tableId, columnId: range, items: ['(a, x)', '(a, y)', '(b, x)', '(b, y)'] },
    ]);
    for (const h of handOff) reconcileComputed(gd, h.tableId, h.items);
    expect(rowsOf(gd, tableId)).toHaveLength(4);
    // Writing the rows does not change the formula's result: the hand-off is stable.
    expect(computedItemsOf(gd, (id) => results.get(id))).toEqual(handOff);
  });

  test('SET-09 a capped result reconciles nothing: the table keeps its rows', () => {
    const { gd, sheetId, results } = harness();
    const { tableId, range } = computedTable(gd, sheetId, '=Union("a", "b")');
    for (const h of computedItemsOf(gd, (id) => results.get(id))) {
      reconcileComputed(gd, h.tableId, h.items);
    }
    const before = rowsOf(gd, tableId);
    expect(before).toHaveLength(2);
    const many = Array.from({ length: 101 }, (_v, i) => `e${String(i)}`).join(', ');
    // A computed column's own cells are not typed values: its formula can be replaced.
    expect(
      setComputedColumn(gd, tableId, range, {
        formula: `=Cross("${many}", "${many}")`,
        shape: 'column',
      }),
    ).toBe(true);
    expect(computedItemsOf(gd, (id) => results.get(id))).toEqual([]);
    expect(rowsOf(gd, tableId)).toEqual(before);
  });
});

describe('SET-12 lost label', () => {
  test('SET-12 the label names the operands of the column formula', () => {
    expect(computedOperandsLabel('=Cross(@E, @C, @B)')).toBe('E × C × B');
    expect(computedOperandsLabel('=Union(A1:A3, @C)')).toBe('A1:A3 ∪ C');
    expect(computedOperandsLabel('=Inter(@E, @C)')).toBe('E ∩ C');
    expect(computedOperandsLabel('=Diff(@E, @C)')).toBe('E ∖ C');
    expect(computedOperandsLabel('=Comp(@E, @U)')).toBe('U ∖ E');
    expect(computedOperandsLabel('=Power(@E)')).toBe('𝒫(E)');
    expect(computedOperandsLabel('=Sum(A1')).toBe('Sum(A1');
  });
});
