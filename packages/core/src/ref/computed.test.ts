import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellReadOnlyReason,
  cellText,
  columnsArray,
  createSheet,
  createUndoManager,
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
import { cross } from '../formula/sets.js';
import { isId, type Id } from '../ids.js';
import {
  computedItemsOf,
  computedOperandsLabel,
  computedRowId,
  reconcileComputed,
  setComputedColumn,
  setTableFormula,
  tupleMembers,
} from './computed.js';
import { addMappingColumn, setMappingValue } from './mapping.js';

function harness(doc = new Y.Doc()) {
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
  expect(setTableFormula(gd, tableId, formula)).toBe(true);
  expect(setComputedColumn(gd, tableId, range.id, { shape: 'column' })).toBe(true);
  return { tableId, range: range.id, notes: notes.id };
}

/** Every computed table's current result, handed to the reconciler; returns the writes. */
function handOff(gd: GedeDoc, results: ReadonlyMap<string, CellResult>): number {
  let writes = 0;
  for (const h of computedItemsOf(gd, (id) => results.get(id))) {
    writes += reconcileComputed(gd, h.tableId, h.items, h.members);
  }
  return writes;
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
    expect(setComputedColumn(gd, tableId, colId, { shape: 'column' })).toBe(false);
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
    setTableFormula(gd, tableId, '=Cross("a, b", "(1, 2), z", "x")');
    cols.forEach((colId, spreadIndex) => {
      expect(setComputedColumn(gd, tableId, colId, { shape: 'spread', spreadIndex })).toBe(true);
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
    expect(handOff).toMatchObject([
      { tableId, columnId: range, items: ['(a, x)', '(a, y)', '(b, x)', '(b, y)'] },
    ]);
    expect(handOff[0]?.members.get('(b, y)')).toEqual(['b', 'y']);
    for (const h of handOff) reconcileComputed(gd, h.tableId, h.items, h.members);
    expect(rowsOf(gd, tableId)).toHaveLength(4);
    // Writing the rows does not change the formula's result: the hand-off is stable.
    expect(computedItemsOf(gd, (id) => results.get(id))).toEqual(handOff);
  });

  test('SET-09 a capped result reconciles nothing: the table keeps its rows', () => {
    const { gd, sheetId, results } = harness();
    const { tableId } = computedTable(gd, sheetId, '=Union("a", "b")');
    for (const h of computedItemsOf(gd, (id) => results.get(id))) {
      reconcileComputed(gd, h.tableId, h.items);
    }
    const before = rowsOf(gd, tableId);
    expect(before).toHaveLength(2);
    const many = Array.from({ length: 101 }, (_v, i) => `e${String(i)}`).join(', ');
    // A computed table's own cells are not typed values: its formula can be replaced.
    expect(setTableFormula(gd, tableId, `=Cross("${many}", "${many}")`)).toBe(true);
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

describe('SET-08 red-team regressions', () => {
  test('SET-08 a formula reading its own computed column reports circular and settles', () => {
    const { gd, sheetId, results } = harness();
    const { tableId, range } = computedTable(gd, sheetId, '=Union("a")');
    reconcileComputed(gd, tableId, ['a', 'b']);
    // The table sits at lattice column B; B:B is the computed column itself.
    expect(setTableFormula(gd, tableId, '=Cross(B:B, "x")')).toBe(true);
    expect(handOff(gd, results)).toBe(0);
    expect(rowsOf(gd, tableId)).toHaveLength(2);
    const error = results.get(`${tableId}/00000000000000000000000000:${range}`)?.error;
    expect(error).toMatchObject({ kind: 'circular' });
  });

  test('SET-08 a formula that grows its own column stops at the first pass that reads itself', () => {
    const { gd, sheetId, results } = harness();
    const { tableId } = computedTable(gd, sheetId, '=Union(B:B, "x")');
    let passes = 0;
    while (passes < 6 && handOff(gd, results) > 0) passes += 1;
    expect(passes).toBeLessThan(6);
    expect(rowsOf(gd, tableId)).toHaveLength(1);
  });

  test('SET-08 a source edit recomputes the rows', () => {
    const { gd, sheetId, results } = harness();
    const source = createTable(gd, { sheetId, at: { col: 5, row: 1 }, columns: 1, rows: 2 });
    const src = tableById(gd, source);
    const [s1 = '', s2 = ''] = src?.rows ?? [];
    const srcCol = src?.columns[0]?.id ?? '';
    setCellText(gd, source, s1, srcCol, 'a');
    setCellText(gd, source, s2, srcCol, 'b');
    const { tableId, range } = computedTable(gd, sheetId, '=Union(F:F, "")');
    handOff(gd, results);
    expect(rowsOf(gd, tableId).map((r) => textAt(gd, tableId, r, range))).toEqual(['a', 'b']);
    setCellText(gd, source, s2, srcCol, 'c');
    handOff(gd, results);
    expect(rowsOf(gd, tableId).map((r) => textAt(gd, tableId, r, range))).toEqual(['a', 'c']);
    expect(handOff(gd, results)).toBe(0);
  });

  test('SET-12 a note typed on one replica while the other drops its key survives the merge', () => {
    const a = harness();
    const { tableId, notes } = computedTable(a.gd, a.sheetId, '=Union("a, b")');
    reconcileComputed(a.gd, tableId, ['a', 'b']);
    const b = openDocument(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const idB = computedRowId(tableId, 'b');
    setCellText(a.gd, tableId, idB, notes, 'keep me');
    reconcileComputed(b, tableId, ['a']);
    exchange(a.doc, b.doc);
    for (let i = 0; i < 3; i += 1) {
      reconcileComputed(a.gd, tableId, ['a']);
      reconcileComputed(b, tableId, ['a']);
      exchange(a.doc, b.doc);
    }
    expect(rowsOf(a.gd, tableId)).toEqual(rowsOf(b, tableId));
    expect(rowsOf(a.gd, tableId)).toContain(idB);
    expect(textAt(b, tableId, idB, notes)).toBe('keep me');
    const table = tableMap(b, tableId);
    if (table === null) throw new Error('no table');
    expect(rowMeta(table, idB).computedKey).toBe('b');
    expect(rowMeta(table, idB).lostFrom).not.toBeNull();
    expect(reconcileComputed(a.gd, tableId, ['a'])).toBe(0);
  });

  test('SET-12 undo then redo of a note on a lost row brings the note back on a visible row', () => {
    const { gd, sheetId } = harness();
    const { tableId, range, notes } = computedTable(gd, sheetId, '=Union("a, b")');
    reconcileComputed(gd, tableId, ['a', 'b']);
    const um = createUndoManager(gd, { captureTimeout: 0 });
    const idB = computedRowId(tableId, 'b');
    setCellText(gd, tableId, idB, notes, 'note');
    reconcileComputed(gd, tableId, ['a']);
    um.undo();
    reconcileComputed(gd, tableId, ['a']);
    expect(rowsOf(gd, tableId)).not.toContain(idB);
    um.redo();
    reconcileComputed(gd, tableId, ['a']);
    expect(textAt(gd, tableId, idB, notes)).toBe('note');
    expect(rowsOf(gd, tableId)).toContain(idB);
    // The restored row shows its key again, as any lost row does.
    expect(textAt(gd, tableId, idB, range)).toBe('b');
  });

  test('SET-12 a pulled value alone does not hold a lost row', () => {
    const { gd, sheetId } = harness();
    const { tableId, notes } = computedTable(gd, sheetId, '=Union("a, b")');
    reconcileComputed(gd, tableId, ['a', 'b']);
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('no table');
    gd.doc.transact(() => columnsArray(table).get(1).set('source', 'pulled'));
    setCellText(gd, tableId, computedRowId(tableId, 'b'), notes, 'pulled text');
    reconcileComputed(gd, tableId, ['a']);
    expect(rowsOf(gd, tableId)).toEqual([computedRowId(tableId, 'a')]);
  });

  test('SET-09 10,000 rows (the cap) fill and fully reverse within 2 s each', () => {
    const { gd, sheetId } = harness();
    const { tableId } = computedTable(gd, sheetId, '=Union("a")');
    const keys = Array.from({ length: 10_000 }, (_v, i) => `k${String(i)}`);
    let t0 = performance.now();
    reconcileComputed(gd, tableId, keys);
    const fill = performance.now() - t0;
    t0 = performance.now();
    reconcileComputed(gd, tableId, [...keys].reverse());
    const reverse = performance.now() - t0;
    expect(rowsOf(gd, tableId)).toEqual([...keys].reverse().map((k) => computedRowId(tableId, k)));
    expect(reconcileComputed(gd, tableId, [...keys].reverse())).toBe(0);
    expect({ fill: fill < 2000, reverse: reverse < 2000 }).toEqual({ fill: true, reverse: true });
  }, 60_000);

  test('SET-09 a reorder moves only the rows out of order', () => {
    const { gd, sheetId } = harness();
    const { tableId } = computedTable(gd, sheetId, '=Union("a")');
    reconcileComputed(gd, tableId, ['a', 'b', 'c', 'd', 'e']);
    const hand = addRow(gd, tableId, computedRowId(tableId, 'c'));
    // One row moves (a delete and an insert); the hand-added row keeps its place after c.
    expect(reconcileComputed(gd, tableId, ['a', 'c', 'd', 'b', 'e'])).toBe(2);
    expect(rowsOf(gd, tableId)).toEqual([
      ...['a', 'c'].map((k) => computedRowId(tableId, k)),
      hand,
      ...['d', 'b', 'e'].map((k) => computedRowId(tableId, k)),
    ]);
  });

  test('SET-09 spread shape splits a tuple whose member holds an unbalanced paren', () => {
    const { gd, sheetId, results } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
    const cols = tableById(gd, tableId)?.columns.map((c) => c.id) ?? [];
    setTableFormula(gd, tableId, '=Cross("sad :(", "x")');
    cols.forEach((colId, spreadIndex) => {
      setComputedColumn(gd, tableId, colId, { shape: 'spread', spreadIndex });
    });
    handOff(gd, results);
    const [row = ''] = rowsOf(gd, tableId);
    expect(cols.map((c) => textAt(gd, tableId, row, c))).toEqual(['sad :(', 'x']);
    // The rendering alone cannot be split back; that is why Cross carries its members.
    const [tuple = ''] = cross([['sad :('], ['x']]);
    expect(tupleMembers(tuple)).toEqual(['sad :(, x']);
  });
});

describe('SET-08 red-team round 3 regressions', () => {
  test('SET-08 two column-shape computed columns sharing a formula that reads the second settle', () => {
    const { gd, sheetId, results } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
    const [b = '', c = ''] = tableById(gd, tableId)?.columns.map((x) => x.id) ?? [];
    setTableFormula(gd, tableId, '=Cross(Union(C:C, "a"), "x")');
    expect(setComputedColumn(gd, tableId, b, { shape: 'column' })).toBe(true);
    expect(setComputedColumn(gd, tableId, c, { shape: 'column' })).toBe(true);
    let passes = 0;
    while (passes < 6 && handOff(gd, results) > 0) passes += 1;
    expect(passes).toBeLessThan(6);
  });

  test('SET-12 a lost spread row keeps its member values', () => {
    const { gd, sheetId, results } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 0 });
    const [c0 = '', c1 = '', notes = ''] = tableById(gd, tableId)?.columns.map((x) => x.id) ?? [];
    const source = createTable(gd, { sheetId, at: { col: 5, row: 1 }, columns: 1, rows: 2 });
    const src = tableById(gd, source);
    const [s1 = '', s2 = ''] = src?.rows ?? [];
    const srcCol = src?.columns[0]?.id ?? '';
    setCellText(gd, source, s1, srcCol, 'ok');
    setCellText(gd, source, s2, srcCol, 'sad :(');
    setTableFormula(gd, tableId, '=Cross(F:F, "x")');
    setComputedColumn(gd, tableId, c0, { shape: 'spread', spreadIndex: 0 });
    setComputedColumn(gd, tableId, c1, { shape: 'spread', spreadIndex: 1 });
    handOff(gd, results);
    const sad = rowsOf(gd, tableId).find((r) => textAt(gd, tableId, r, c0) === 'sad :(') ?? '';
    expect(textAt(gd, tableId, sad, c1)).toBe('x');
    setCellText(gd, tableId, sad, notes, 'keep me');
    setCellText(gd, source, s2, srcCol, 'fine');
    handOff(gd, results);
    expect(rowsOf(gd, tableId)).toContain(sad);
    expect([textAt(gd, tableId, sad, c0), textAt(gd, tableId, sad, c1)]).toEqual(['sad :(', 'x']);
  });

  test('SET-08 a two-column table changed in one step ends on one formula with every computed column filled', () => {
    const { gd, sheetId, results } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 0 });
    const [c0 = '', c1 = '', c2 = ''] = tableById(gd, tableId)?.columns.map((x) => x.id) ?? [];
    setTableFormula(gd, tableId, '=Cross("a", "x")');
    setComputedColumn(gd, tableId, c0, { shape: 'spread', spreadIndex: 0 });
    setComputedColumn(gd, tableId, c1, { shape: 'spread', spreadIndex: 1 });
    handOff(gd, results);
    const um = createUndoManager(gd, { captureTimeout: 0 });
    expect(setTableFormula(gd, tableId, '=Cross("b", "y")')).toBe(true);
    // One undo step: the change is one table-level mutation, never column by column.
    expect(um.undoStack).toHaveLength(1);
    expect(tableById(gd, tableId)?.computedFormula).toBe('=Cross("b", "y")');
    handOff(gd, results);
    const [row = ''] = rowsOf(gd, tableId);
    expect(rowsOf(gd, tableId)).toEqual([computedRowId(tableId, '(b, y)')]);
    expect([textAt(gd, tableId, row, c0), textAt(gd, tableId, row, c1)]).toEqual(['b', 'y']);
    // A column made computed later takes the table's one formula, not one of its own.
    expect(setComputedColumn(gd, tableId, c2, { shape: 'column' })).toBe(true);
    handOff(gd, results);
    expect(textAt(gd, tableId, row, c2)).toBe('(b, y)');
    expect(handOff(gd, results)).toBe(0);
  });

  test('SET-08 two replicas changing the formula concurrently converge on one formula with every column filled', () => {
    const a = harness();
    const tableId = createTable(a.gd, {
      sheetId: a.sheetId,
      at: { col: 1, row: 1 },
      columns: 2,
      rows: 0,
    });
    const [c0 = '', c1 = ''] = tableById(a.gd, tableId)?.columns.map((x) => x.id) ?? [];
    setTableFormula(a.gd, tableId, '=Cross("a", "x")');
    setComputedColumn(a.gd, tableId, c0, { shape: 'spread', spreadIndex: 0 });
    setComputedColumn(a.gd, tableId, c1, { shape: 'spread', spreadIndex: 1 });
    handOff(a.gd, a.results);
    const bDoc = new Y.Doc();
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(a.doc));
    const b = harness(bDoc);
    setTableFormula(a.gd, tableId, '=Cross("b", "y")');
    setTableFormula(b.gd, tableId, '=Cross("c", "z")');
    handOff(a.gd, a.results);
    handOff(b.gd, b.results);
    for (let i = 0; i < 4; i += 1) {
      exchange(a.doc, b.doc);
      handOff(a.gd, a.results);
      handOff(b.gd, b.results);
    }
    exchange(a.doc, b.doc);
    const formula = tableById(a.gd, tableId)?.computedFormula;
    expect(['=Cross("b", "y")', '=Cross("c", "z")']).toContain(formula);
    expect(tableById(b.gd, tableId)?.computedFormula).toBe(formula);
    const want = formula === '=Cross("b", "y")' ? ['b', 'y'] : ['c', 'z'];
    for (const gd of [a.gd, b.gd]) {
      const rows = rowsOf(gd, tableId);
      expect(rows).toEqual([computedRowId(tableId, `(${want.join(', ')})`)]);
      const [row = ''] = rows;
      expect([textAt(gd, tableId, row, c0), textAt(gd, tableId, row, c1)]).toEqual(want);
    }
    expect(handOff(a.gd, a.results)).toBe(0);
    expect(handOff(b.gd, b.results)).toBe(0);
  });

  test('SET-12 a row restored after a concurrent removal goes back to its place', () => {
    const a = harness();
    const { tableId, notes } = computedTable(a.gd, a.sheetId, '=Union("a, b, c")');
    reconcileComputed(a.gd, tableId, ['a', 'b', 'c']);
    const b = openDocument(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const idB = computedRowId(tableId, 'b');
    setCellText(a.gd, tableId, idB, notes, 'keep me');
    reconcileComputed(b, tableId, ['a', 'c']);
    exchange(a.doc, b.doc);
    for (let i = 0; i < 3; i += 1) {
      reconcileComputed(a.gd, tableId, ['a', 'c']);
      reconcileComputed(b, tableId, ['a', 'c']);
      exchange(a.doc, b.doc);
    }
    const order = ['a', 'b', 'c'].map((k) => computedRowId(tableId, k));
    expect(rowsOf(a.gd, tableId)).toEqual(order);
    expect(rowsOf(b, tableId)).toEqual(order);
  });
});

describe('SET-08 red-team round 4 regressions', () => {
  test('SET-10 SET-11 a note typed concurrently into a column another replica fills is not overwritten', () => {
    const a = harness();
    const { tableId, range, notes } = computedTable(a.gd, a.sheetId, '=Union("a", "b")');
    handOff(a.gd, a.results);
    const b = openDocument(new Y.Doc());
    exchange(a.doc, b.doc);
    const rowA = computedRowId(tableId, 'a');
    setCellText(b, tableId, rowA, notes, 'important');
    expect(setComputedColumn(a.gd, tableId, notes, { shape: 'column' })).toBe(true);
    exchange(a.doc, b.doc);
    handOff(a.gd, a.results);
    exchange(a.doc, b.doc);
    expect(textAt(a.gd, tableId, rowA, range)).toBe('a');
    for (const gd of [a.gd, b]) {
      expect(textAt(gd, tableId, rowA, notes)).toBe('important');
      // The column holds a typed value, so it is refused as it would have been locally.
      expect(tableById(gd, tableId)?.columns[1]?.source).toBe('entered');
      expect(textAt(gd, tableId, computedRowId(tableId, 'b'), notes)).toBe('');
    }
    expect(handOff(a.gd, a.results)).toBe(0);
  });

  test('SET-11 SET-12 a mapping pick on a row whose key leaves keeps the row', () => {
    const { gd, sheetId } = harness();
    const src = createTable(gd, { sheetId, at: { col: 10, row: 1 }, columns: 1, rows: 1 });
    const srcCol = tableById(gd, src)?.columns[0]?.id ?? '';
    setCellText(gd, src, tableById(gd, src)?.rows[0] ?? '', srcCol, 'Owner Ana');
    const { tableId } = computedTable(gd, sheetId, '=Union("a", "b")');
    reconcileComputed(gd, tableId, ['a', 'b']);
    const pick = addMappingColumn(gd, tableId, { tableId: src, colId: srcCol });
    if (pick === null) throw new Error('no mapping');
    const rowB = computedRowId(tableId, 'b');
    expect(setMappingValue(gd, tableId, rowB, pick, 'Owner Ana')).toBe(true);
    reconcileComputed(gd, tableId, ['a']);
    expect(rowsOf(gd, tableId)).toContain(rowB);
    expect(textAt(gd, tableId, rowB, pick)).toBe('Owner Ana');
  });

  test('SET-10 undo of Fill column leaves an empty column that can be filled again', () => {
    const { gd, sheetId, results } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
    const [range = ''] = tableById(gd, tableId)?.columns.map((c) => c.id) ?? [];
    const um = createUndoManager(gd, { captureTimeout: 0 });
    setTableFormula(gd, tableId, '=Union("a", "b")');
    setComputedColumn(gd, tableId, range, { shape: 'column' });
    handOff(gd, results);
    expect(rowsOf(gd, tableId)).toHaveLength(2);
    um.undo();
    um.undo();
    // The hand-off runs after every engine batch; it clears what the reconciler wrote.
    handOff(gd, results);
    expect(tableById(gd, tableId)?.columns[0]?.source).toBe('entered');
    expect(rowsOf(gd, tableId)).toEqual([]);
    expect(handOff(gd, results)).toBe(0);
    expect(setComputedColumn(gd, tableId, range, { shape: 'column' })).toBe(true);
  });

  test('SET-12 a row holding a note stays as a plain row once its table has no computed column', () => {
    const { gd, sheetId, results } = harness();
    const { tableId, range, notes } = computedTable(gd, sheetId, '=Union("a", "b")');
    handOff(gd, results);
    const rowB = computedRowId(tableId, 'b');
    setCellText(gd, tableId, rowB, notes, 'keep me');
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('no table');
    // As an undo of Fill column does: the column goes back to entered.
    gd.doc.transact(() => {
      const column = columnsArray(table).get(0);
      column.set('source', 'entered');
      column.delete('computed');
    });
    handOff(gd, results);
    expect(rowsOf(gd, tableId)).toEqual([rowB]);
    expect(textAt(gd, tableId, rowB, range)).toBe('');
    expect(textAt(gd, tableId, rowB, notes)).toBe('keep me');
    expect(rowMeta(table, rowB)).toMatchObject({ computedKey: null, lostFrom: null });
    expect(handOff(gd, results)).toBe(0);
  });

  test('SET-08 a formula that yields no set (plain text, a number) is refused', () => {
    const { gd, sheetId } = harness();
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 0 });
    expect(setTableFormula(gd, tableId, 'not a formula')).toBe(false);
    expect(setTableFormula(gd, tableId, '=1+1')).toBe(false);
    expect(setTableFormula(gd, tableId, '=Concat("a", "b")')).toBe(false);
    expect(tableById(gd, tableId)?.computedFormula).toBeNull();
    expect(setTableFormula(gd, tableId, '=union("a", "b")')).toBe(true);
  });
});
