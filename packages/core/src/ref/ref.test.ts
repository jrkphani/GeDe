import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellReadOnlyReason,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  deleteRow,
  openDocument,
  rowMeta,
  rowReadOnlyReason,
  setCellText,
  setColumnWidth,
  setRowDepth,
  setTablePosition,
  setTableTitle,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { commitCellText } from '../engine/commit.js';
import { derivedCellSource, FormulaEngine } from '../engine/engine.js';
import { observeWorkbook } from '../engine/snapshot.js';
import { workbookCellId, type CellResult } from '../engine/types.js';
import { cellKey, isId, type Id } from '../ids.js';
import { effectiveDepths } from '../hier/outline.js';
import { tableEntries } from '../search/snapshot.js';
import {
  addDerivedColumn,
  addMappingColumn,
  clearPull,
  derivedColumnsOf,
  deriveSignature,
  distinctValues,
  isGraphDimensionCandidate,
  isReferenceSource,
  lineageOf,
  observePulls,
  pullPlan,
  reconcilePull,
  REF_ORIGIN,
  reconcileSplitChildren,
  referenceSource,
  referenceTargetOf,
  setDerivedColumn,
  setMappingValue,
  setPull,
  setReferenceCell,
  splitChildId,
  splitPiecesOf,
} from './index.js';

/** A document, an engine fed by `observeWorkbook`, and the results it produced. */
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
  return { doc, gd, engine, results, sheetId };
}

/**
 * A truly concurrent exchange: both replicas' pending diffs are captured first,
 * then applied crosswise, so each sees the other's transactions (and reacts to
 * them) only after making its own. Repeats until neither has anything new,
 * bounded at 30 rounds. Returns the rounds it took.
 */
function exchange(a: Y.Doc, b: Y.Doc): number {
  // Yjs diffs always carry the whole delete set, so "nothing new" is judged by whether
  // applying the round changed either replica (Yjs emits `update` only when it did).
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

function grid(gd: GedeDoc, sheetId: Id, title: string, rows: string[][]): Id {
  const tableId = createTable(gd, {
    sheetId,
    at: { col: 1, row: 1 },
    columns: rows[0]?.length ?? 2,
    rows: rows.length,
    title,
  });
  const record = tableById(gd, tableId);
  if (record === null) throw new Error('no table');
  rows.forEach((cells, r) => {
    cells.forEach((text, c) => {
      const rowId = record.rows[r];
      const colId = record.columns[c]?.id;
      if (rowId === undefined || colId === undefined) throw new Error('shape');
      if (text !== '') commitCellText(gd, tableId, rowId, colId, text);
    });
  });
  return tableId;
}

function cellAt(gd: GedeDoc, tableId: Id, r: number, c: number): { rowId: Id; colId: Id } {
  const record = tableById(gd, tableId);
  const rowId = record?.rows[r];
  const colId = record?.columns[c]?.id;
  if (rowId === undefined || colId === undefined) throw new Error('no such cell');
  return { rowId, colId };
}

function valueText(results: Map<string, CellResult>, tableId: Id, rowId: Id, colId: Id): string {
  const r = results.get(workbookCellId(tableId, cellKey(rowId, colId)));
  if (r === undefined) return '<pending>';
  if (r.error !== null) return `<${r.error.kind}>`;
  const v = r.value;
  if (v === null) return '';
  if (v.kind === 'text') return v.text;
  if (v.kind === 'number') return String(v.value);
  if (v.kind === 'list') return v.items.map((i) => (i.kind === 'text' ? i.text : '?')).join('|');
  return v.kind;
}

describe('REF-01 reference cells', () => {
  test('REF-01 a reference cell is one entity-bound token and evaluates live', () => {
    const { gd, sheetId, results } = harness();
    const peaks = grid(gd, sheetId, 'Peaks', [['Lukla', '2860']]);
    const notes = grid(gd, sheetId, 'Notes', [['', '']]);
    const target = { tableId: peaks, ...cellAt(gd, peaks, 0, 1) };
    const at = cellAt(gd, notes, 0, 0);
    expect(setReferenceCell(gd, notes, at.rowId, at.colId, target)).toBe(true);
    const stored = cellText(tableMap(gd, notes) ?? new Y.Map(), at.rowId, at.colId);
    expect(stored).toMatch(/^=\{e:[0-9A-Z]{26}:[0-9A-Z]{26}:[0-9A-Z]{26}\}$/u);
    expect(isReferenceSource(stored)).toBe(true);
    expect(referenceTargetOf(stored)).toEqual(target);
    expect(valueText(results, notes, at.rowId, at.colId)).toBe('2860');
    // Live: the source changes, the reference follows.
    setCellText(gd, peaks, target.rowId, target.colId, '2900');
    expect(valueText(results, notes, at.rowId, at.colId)).toBe('2900');
  });

  test('REF-01 a typed =@Table.Row binds to the same shape; a list of two does not count', () => {
    const { gd, sheetId } = harness();
    const peaks = grid(gd, sheetId, 'Peaks', [['Lukla', '2860']]);
    const notes = grid(gd, sheetId, 'Notes', [['', '']]);
    const a = cellAt(gd, notes, 0, 0);
    commitCellText(gd, notes, a.rowId, a.colId, '=@Peaks.Lukla');
    const table = tableMap(gd, notes);
    if (table === null) throw new Error('no table');
    expect(referenceTargetOf(cellText(table, a.rowId, a.colId))).toEqual({
      tableId: peaks,
      ...cellAt(gd, peaks, 0, 0),
    });
    const b = cellAt(gd, notes, 0, 1);
    commitCellText(gd, notes, b.rowId, b.colId, '=@Peaks.Lukla, @Peaks.Lukla');
    expect(isReferenceSource(cellText(table, b.rowId, b.colId))).toBe(false);
    expect(isReferenceSource('=Sum(@Peaks.Lukla)')).toBe(false);
    expect(referenceSource({ tableId: 'T', rowId: 'R', colId: 'C' })).toBe('={e:T:R:C}');
  });
});

describe('REF-04 derived columns', () => {
  test('REF-04 a derived column evaluates @Source.Method(args) per row and recomputes upstream', () => {
    const { gd, sheetId, results } = harness();
    const t = grid(gd, sheetId, 'Sites', [
      ['Lukla (2860 m)', ''],
      ['Namche (3440 m)', ''],
    ]);
    const source = cellAt(gd, t, 0, 0).colId;
    const colId = addDerivedColumn(gd, t, {
      sourceColId: source,
      method: 'Extract',
      args: ['/\\(([^)]*)\\)/'],
    });
    expect(colId).not.toBeNull();
    if (colId === null) return;
    const record = tableById(gd, t);
    if (record === null) throw new Error('no table');
    // Placed after its source, labelled with its signature, read-only.
    expect(record.columns.map((c) => c.id)).toEqual([source, colId, record.columns[2]?.id]);
    // The label is the parseable signature: a backslash in an argument is escaped.
    expect(record.columns[1]?.label).toBe('@"Column 1".Extract("/\\\\(([^)]*)\\\\)/")');
    expect(record.columns[1]?.source).toBe('derived');
    expect(cellReadOnlyReason(tableMap(gd, t) ?? new Y.Map(), record.rows[0] ?? '', colId)).toBe(
      'derived',
    );
    expect(isGraphDimensionCandidate(record.columns[1] ?? { source: 'entered' })).toBe(false);
    expect(isGraphDimensionCandidate(record.columns[0] ?? { source: 'derived' })).toBe(true);
    // Evaluated in the engine from a synthesised bound formula.
    const r0 = record.rows[0] ?? '';
    const r1 = record.rows[1] ?? '';
    expect(valueText(results, t, r0, colId)).toBe('2860 m');
    expect(valueText(results, t, r1, colId)).toBe('3440 m');
    const result = results.get(workbookCellId(t, cellKey(r0, colId)));
    expect(result?.source).toBe(
      derivedCellSource(t, r0, {
        sourceColId: source,
        method: 'Extract',
        args: ['/\\(([^)]*)\\)/'],
      }),
    );
    expect(result?.operands).toHaveLength(1);
    // Upstream change recomputes.
    setCellText(gd, t, r0, source, 'Lukla (2900 m)');
    expect(valueText(results, t, r0, colId)).toBe('2900 m');
    // A new row gets a cell; an edited spec re-evaluates every row and re-labels.
    expect(
      setDerivedColumn(gd, t, colId, { sourceColId: source, method: 'Concat', args: [' ✓'] }),
    ).toBe(true);
    expect(valueText(results, t, r0, colId)).toBe('Lukla (2900 m) ✓');
    expect(tableById(gd, t)?.columns[1]?.label).toBe('@"Column 1".Concat(" ✓")');
    expect(derivedColumnsOf(tableById(gd, t) ?? record).map((d) => d.signature)).toEqual([
      '@"Column 1".Concat(" ✓")',
    ]);
  });

  test('REF-04 a formula elsewhere can read a derived cell, and the lineage header spans source and pipeline', () => {
    const { gd, sheetId, results } = harness();
    const t = grid(gd, sheetId, 'Sites', [['everest base camp', '']]);
    const source = cellAt(gd, t, 0, 0).colId;
    const colId = addDerivedColumn(gd, t, {
      sourceColId: source,
      method: 'Format',
      args: ['Title Case'],
    });
    if (colId === null) throw new Error('no column');
    const record = tableById(gd, t);
    if (record === null) throw new Error('no table');
    const other = cellAt(gd, t, 0, 2);
    // The table sits at column B: B5 is the source, C5 the derived cell; read it by address.
    commitCellText(gd, t, other.rowId, other.colId, '=Concat(C5, "!")');
    expect(valueText(results, t, other.rowId, other.colId)).toBe('Everest Base Camp!');
    expect(lineageOf(record)).toEqual([
      { kind: 'source', units: 1, label: 'source · Sites' },
      { kind: 'derived', units: 1, label: 'derived pipeline ▸ 1 step' },
      { kind: 'source', units: 1, label: 'source · Sites' },
    ]);
    expect(
      deriveSignature(record, { sourceColId: 'missing', method: 'Format', args: ['Trimmed'] }),
    ).toBe('@#REF.Format("Trimmed")');
  });

  test('REF-04 a derived column refuses a missing source or itself', () => {
    const { gd, sheetId } = harness();
    const t = grid(gd, sheetId, 'Sites', [['a', '']]);
    expect(
      addDerivedColumn(gd, t, { sourceColId: 'nope', method: 'Format', args: ['Trimmed'] }),
    ).toBeNull();
    const source = cellAt(gd, t, 0, 0).colId;
    const colId = addDerivedColumn(gd, t, {
      sourceColId: source,
      method: 'Format',
      args: ['Trimmed'],
    });
    if (colId === null) throw new Error('no column');
    expect(
      setDerivedColumn(gd, t, colId, { sourceColId: colId, method: 'Format', args: ['Trimmed'] }),
    ).toBe(false);
    expect(
      setDerivedColumn(gd, t, source, { sourceColId: colId, method: 'Format', args: ['Trimmed'] }),
    ).toBe(false);
  });
});

describe('HIER-07 Split() children', () => {
  test('HIER-07 Split pieces become read-only child rows beneath the parent, one depth deeper', () => {
    const { gd, sheetId, results } = harness();
    const t = grid(gd, sheetId, 'Notes', [
      ['One. Two. Three', ''],
      ['Solo', ''],
    ]);
    const source = cellAt(gd, t, 0, 0).colId;
    const colId = addDerivedColumn(gd, t, { sourceColId: source, method: 'Split', args: ['. '] });
    if (colId === null) throw new Error('no column');
    const before = tableById(gd, t);
    if (before === null) throw new Error('no table');
    const [p0, p1] = before.rows;
    if (p0 === undefined || p1 === undefined) throw new Error('rows');
    expect(valueText(results, t, p0, colId)).toBe('One|Two|Three');
    const pieces = new Map<Id, string[]>([
      [p0, ['One', 'Two', 'Three']],
      [p1, ['Solo']],
    ]);
    expect(reconcileSplitChildren(gd, t, pieces)).toBeGreaterThan(0);
    const after = tableById(gd, t);
    if (after === null) throw new Error('no table');
    expect(after.rows).toEqual([
      p0,
      splitChildId(p0, 0),
      splitChildId(p0, 1),
      splitChildId(p0, 2),
      p1,
      splitChildId(p1, 0),
    ]);
    // Child ids are deterministic and ULID-shaped so they fit inside bound tokens.
    expect(splitChildId(p0, 1)).toBe(splitChildId(p0, 1));
    expect(splitChildId(p0, 1)).not.toBe(splitChildId(p0, 2));
    expect(isId(splitChildId(p0, 1))).toBe(true);
    const table = tableMap(gd, t);
    if (table === null) throw new Error('no table');
    const c1 = splitChildId(p0, 1);
    expect(cellText(table, c1, colId)).toBe('Two');
    expect(rowMeta(table, c1)).toMatchObject({
      depth: 1,
      splitChild: true,
      splitOf: { rowId: p0, index: 1 },
    });
    expect(rowReadOnlyReason(rowMeta(table, c1))).toBe('splitChild');
    expect(cellReadOnlyReason(table, c1, source)).toBe('splitChild');
    // The engine leaves a child's stored text alone (no synthesis over it) and reads it back.
    expect(results.get(workbookCellId(t, cellKey(c1, colId)))).toBeUndefined();
    // Idempotent; fewer pieces drop rows; the parent deleted drops its children.
    expect(reconcileSplitChildren(gd, t, pieces)).toBe(0);
    expect(reconcileSplitChildren(gd, t, new Map([[p0, ['One']]]))).toBeGreaterThan(0);
    expect(tableById(gd, t)?.rows).toEqual([p0, splitChildId(p0, 0), p1]);
    deleteRow(gd, t, p0);
    reconcileSplitChildren(gd, t, new Map());
    expect(tableById(gd, t)?.rows).toEqual([p1]);
  });
  test('HIER-07 two replicas that materialise the same Split concurrently settle with no duplicates', () => {
    const a = harness();
    const b = harness();
    // A reconciles from its own engine after every apply, as the app does; so does B.
    const follow = (h: ReturnType<typeof harness>): (() => void) =>
      observeWorkbook(h.gd, () => {
        for (const [tableId, pieces] of splitPiecesOf(h.gd, (id) => h.results.get(id))) {
          reconcileSplitChildren(h.gd, tableId, pieces);
        }
      });
    const t = grid(a.gd, a.sheetId, 'Notes', [
      ['One. Two', ''],
      ['Solo', ''],
    ]);
    const source = cellAt(a.gd, t, 0, 0).colId;
    addDerivedColumn(a.gd, t, { sourceColId: source, method: 'Split', args: ['. '] });
    const rows = tableById(a.gd, t)?.rows ?? [];
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const stopA = follow(a);
    const stopB = follow(b);
    // Both engines evaluate the same edit and both materialise before either sees the other.
    setCellText(a.gd, t, rows[0] ?? '', source, 'One. Two. Three');
    setCellText(b.gd, t, rows[1] ?? '', source, 'Solo. Duo');
    const rounds = exchange(a.doc, b.doc);
    expect(rounds).toBeLessThan(30);
    const rowsA = tableById(a.gd, t)?.rows ?? [];
    expect(rowsA).toEqual(tableById(b.gd, t)?.rows);
    expect(new Set(rowsA).size).toBe(rowsA.length);
    // Each parent followed by its own children, in order.
    const [p0, p1] = rows;
    expect(rowsA).toEqual([
      p0,
      splitChildId(p0 ?? '', 0),
      splitChildId(p0 ?? '', 1),
      splitChildId(p0 ?? '', 2),
      p1,
      splitChildId(p1 ?? '', 0),
      splitChildId(p1 ?? '', 1),
    ]);
    stopA();
    stopB();
  });

  test('HIER-07 children are flagged through markSplitChildren: a merge-shaped parent depth is normalised', () => {
    const { gd, sheetId } = harness();
    const t = grid(gd, sheetId, 'Notes', [['One. Two', '']]);
    const source = cellAt(gd, t, 0, 0).colId;
    addDerivedColumn(gd, t, { sourceColId: source, method: 'Split', args: ['. '] });
    const parent = cellAt(gd, t, 0, 0).rowId;
    // A stored depth no reader would produce (a merge left it): the outline clamps it to 0.
    setRowDepth(gd, t, parent, 3);
    reconcileSplitChildren(gd, t, new Map([[parent, ['One', 'Two']]]));
    const table = tableMap(gd, t);
    if (table === null) throw new Error('no table');
    const child = splitChildId(parent, 0);
    expect(rowMeta(table, child)).toMatchObject({ depth: 1, splitChild: true });
    expect(rowMeta(table, child).depth).toBe((effectiveDepths([3])[0] ?? 0) + 1);
  });
});

describe('REF-02 pulls', () => {
  function pulled(gd: GedeDoc, sheetId: Id) {
    const source = grid(gd, sheetId, 'Peaks', [
      ['Lukla', 'Nepal'],
      ['Namche', 'Nepal'],
      ['Leh', 'India'],
    ]);
    const target = grid(gd, sheetId, 'Nepal trek', [['', '']]);
    const receiving = cellAt(gd, target, 0, 0).colId;
    const sourceCol = cellAt(gd, source, 0, 0).colId;
    return { source, target, receiving, sourceCol };
  }

  test('REF-02 setPull mirrors the matching rows, renames the column and keeps values live', () => {
    const { gd, sheetId, results } = harness();
    const { source, target, receiving, sourceCol } = pulled(gd, sheetId);
    expect(
      setPull(gd, target, receiving, { tableId: source, colId: sourceCol, filter: 'nepal' }),
    ).toBe(true);
    const record = tableById(gd, target);
    if (record === null) throw new Error('no table');
    expect(record.columns[0]?.label).toBe('↰ Peaks · Column 1');
    expect(record.columns[0]?.source).toBe('pulled');
    expect(record.columns[0]?.pull).toEqual({ tableId: source, colId: sourceCol, filter: 'nepal' });
    const own = record.rows[0] ?? '';
    const s = tableById(gd, source);
    if (s === null) throw new Error('no source');
    expect(record.rows).toEqual([own, s.rows[0], s.rows[1]]);
    const table = tableMap(gd, target);
    if (table === null) throw new Error('no table');
    const lukla = s.rows[0] ?? '';
    expect(rowMeta(table, lukla).pulledFrom).toEqual({ tableId: source, rowId: lukla });
    expect(rowReadOnlyReason(rowMeta(table, lukla))).toBe('pulled');
    expect(cellReadOnlyReason(table, lukla, record.columns[1]?.id ?? '')).toBe('pulled');
    expect(cellText(table, lukla, receiving)).toMatch(/^=\{c:/u);
    expect(valueText(results, target, lukla, receiving)).toBe('Lukla');
    // Live value: edit the source cell.
    setCellText(gd, source, lukla, sourceCol, 'Lukla airstrip');
    expect(valueText(results, target, lukla, receiving)).toBe('Lukla airstrip');
    expect(pullPlan(gd, target)?.rows).toEqual([s.rows[0], s.rows[1]]);
  });

  test('REF-02 observePulls follows source edits, is idempotent and clears with the pull', () => {
    const { gd, sheetId } = harness();
    const { source, target, receiving, sourceCol } = pulled(gd, sheetId);
    const stop = observePulls(gd);
    setPull(gd, target, receiving, { tableId: source, colId: sourceCol, filter: 'india' });
    const s = tableById(gd, source);
    if (s === null) throw new Error('no source');
    const own = tableById(gd, target)?.rows[0];
    expect(tableById(gd, target)?.rows).toEqual([own, s.rows[2]]);
    // Namche moves to India: the row set follows without a second setPull.
    setCellText(gd, source, s.rows[1] ?? '', cellAt(gd, source, 1, 1).colId, 'India');
    expect(tableById(gd, target)?.rows).toEqual([own, s.rows[1], s.rows[2]]);
    // Nothing moved: nothing written.
    expect(reconcilePull(gd, target)).toBe(0);
    // Delete the source row: the mirror goes.
    deleteRow(gd, source, s.rows[2] ?? '');
    expect(tableById(gd, target)?.rows).toEqual([own, s.rows[1]]);
    expect(clearPull(gd, target)).toBe(true);
    expect(tableById(gd, target)?.rows).toEqual([own]);
    expect(tableById(gd, target)?.columns[0]?.source).toBe('entered');
    stop();
  });

  test('REF-02 binding a pull is one undo step, rows included; a source edit stays one step', () => {
    const { gd, sheetId } = harness();
    const { source, target, receiving, sourceCol } = pulled(gd, sheetId);
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const stop = observePulls(gd);
    const own = tableById(gd, target)?.rows[0];
    setPull(gd, target, receiving, { tableId: source, colId: sourceCol, filter: 'nepal' });
    expect(tableById(gd, target)?.rows).toHaveLength(3);
    undo.undo();
    expect(tableById(gd, target)?.rows).toEqual([own]);
    expect(tableById(gd, target)?.columns[0]?.source).toBe('entered');
    undo.redo();
    expect(tableById(gd, target)?.rows).toHaveLength(3);
    // A source edit that adds a row to the mirror: undoing it removes the mirror again.
    const leh = cellAt(gd, source, 2, 1);
    setCellText(gd, source, leh.rowId, leh.colId, 'Nepal');
    expect(tableById(gd, target)?.rows).toHaveLength(4);
    undo.undo();
    expect(tableById(gd, target)?.rows).toHaveLength(3);
    stop();
  });

  test('REF-02 two replicas that reconcile concurrently settle with no duplicates', () => {
    const a = harness();
    const stopA = observePulls(a.gd);
    const b = new Y.Doc();
    const gdB = openDocument(b);
    const { source, target, receiving, sourceCol } = pulled(a.gd, a.sheetId);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const stopB = observePulls(gdB);
    setPull(a.gd, target, receiving, { tableId: source, colId: sourceCol, filter: 'nepal' });
    exchange(a.doc, b);
    // Both replicas edit the source before either sees the other's edit — each reconciles
    // on its own, then again on the other's transactions as the diffs cross.
    const s = tableById(a.gd, source);
    if (s === null) throw new Error('no source');
    const region = cellAt(a.gd, source, 0, 1).colId;
    setCellText(a.gd, source, s.rows[0] ?? '', region, 'Tibet');
    setCellText(gdB, source, s.rows[1] ?? '', region, 'Tibet');
    const rounds = exchange(a.doc, b);
    expect(rounds).toBeLessThan(30);
    const rowsA = tableById(a.gd, target)?.rows ?? [];
    expect(rowsA).toEqual(tableById(gdB, target)?.rows);
    expect(rowsA).toHaveLength(1); // the own row; no Nepal row is left
    // Rows that come back are reconciled the same way: both restore, both settle.
    setCellText(a.gd, source, s.rows[0] ?? '', region, 'Nepal');
    setCellText(gdB, source, s.rows[2] ?? '', region, 'Nepal');
    expect(exchange(a.doc, b)).toBeLessThan(30);
    const again = tableById(a.gd, target)?.rows ?? [];
    expect(again).toEqual(tableById(gdB, target)?.rows);
    expect(again).toEqual([again[0], s.rows[0], s.rows[2]]);
    expect(new Set(again).size).toBe(3);
    stopA();
    stopB();
  });

  test('REF-02 a pull mirrors blank source cells too, and a filter reads a derived or formula cell by its evaluated value', () => {
    const { gd, sheetId, results } = harness();
    const source = grid(gd, sheetId, 'Peaks', [
      ['Lukla (2860 m)', ''],
      ['', ''],
      ['Leh (3500 m)', ''],
    ]);
    const sourceCol = cellAt(gd, source, 0, 0).colId;
    const derived = addDerivedColumn(gd, source, {
      sourceColId: sourceCol,
      method: 'Replace',
      args: ['Leh', 'Ladakh'],
    });
    if (derived === null) throw new Error('no column');
    const target = grid(gd, sheetId, 'Heights', [['', '']]);
    const receiving = cellAt(gd, target, 0, 0).colId;
    // No filter: every source row, the blank one included (PRD §14 names only the filter).
    setPull(gd, target, receiving, { tableId: source, colId: derived, filter: '' });
    expect(tableById(gd, target)?.rows).toHaveLength(4);
    // The mirrored value is the engine's evaluation of the derived cell.
    const s = tableById(gd, source);
    if (s === null) throw new Error('no source');
    expect(valueText(results, target, s.rows[2] ?? '', receiving)).toBe('Ladakh (3500 m)');
    // A filter that only the derived value satisfies needs the engine's values: the reader
    // supplies them; without one a derived cell reads as empty — never a stale text.
    const reader = {
      cellValue: (tableId: Id, key: string) =>
        results.get(workbookCellId(tableId, key as `${string}:${string}`))?.value,
    };
    setPull(gd, target, receiving, { tableId: source, colId: derived, filter: 'ladakh' }, reader);
    expect(tableById(gd, target)?.rows).toEqual([tableById(gd, target)?.rows[0], s.rows[2]]);
    expect(pullPlan(gd, target)?.rows).toEqual([]);
    expect(pullPlan(gd, target, reader)?.rows).toEqual([s.rows[2]]);
  });

  test('REF-02 observePulls reconciles only for transactions the row set can depend on', () => {
    const { gd, sheetId } = harness();
    const { source, target, receiving, sourceCol } = pulled(gd, sheetId);
    // Reconcile transactions that wrote something (Yjs emits `update` only then).
    let reconciles = 0;
    gd.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === REF_ORIGIN) reconciles += 1;
    });
    const stop = observePulls(gd);
    setPull(gd, target, receiving, { tableId: source, colId: sourceCol, filter: 'nepal' });
    reconciles = 0;
    // A move, a title, a width: nothing the row set reads.
    setTablePosition(gd, source, { col: 9, row: 9 });
    setTableTitle(gd, source, 'Moved');
    setColumnWidth(gd, source, sourceCol, 3);
    expect(reconciles).toBe(0);
    // A cell in an unrelated table: nothing either.
    const other = grid(gd, sheetId, 'Other', [['x']]);
    reconciles = 0;
    setCellText(gd, other, cellAt(gd, other, 0, 0).rowId, cellAt(gd, other, 0, 0).colId, 'y');
    expect(reconciles).toBe(0);
    // A cell in the source: one reconcile, and the cached row text follows the edit.
    const leh = cellAt(gd, source, 2, 1);
    setCellText(gd, source, leh.rowId, leh.colId, 'Nepal');
    expect(reconciles).toBe(1);
    expect(tableById(gd, target)?.rows).toHaveLength(4);
    stop();
  });

  test('REF-02 own rows come first and the mirrored block last: a row appended after the block moves up', () => {
    const { gd, sheetId } = harness();
    const { source, target, receiving, sourceCol } = pulled(gd, sheetId);
    const stop = observePulls(gd);
    setPull(gd, target, receiving, { tableId: source, colId: sourceCol, filter: '' });
    const own = tableById(gd, target)?.rows[0] ?? '';
    const appended = addRow(gd, target);
    const rows = tableById(gd, target)?.rows ?? [];
    expect(rows.slice(0, 2)).toEqual([own, appended]);
    expect(rows).toHaveLength(5);
    const table = tableMap(gd, target);
    if (table === null) throw new Error('no table');
    expect(rows.slice(2).every((id) => rowMeta(table, id).pulledFrom !== null)).toBe(true);
    // Settled: nothing more to move.
    expect(reconcilePull(gd, target)).toBe(0);
    stop();
  });

  test('REF-02 a table cannot pull from itself and one pull replaces another', () => {
    const { gd, sheetId } = harness();
    const { source, target, receiving, sourceCol } = pulled(gd, sheetId);
    expect(setPull(gd, target, receiving, { tableId: target, colId: receiving, filter: '' })).toBe(
      false,
    );
    setPull(gd, target, receiving, { tableId: source, colId: sourceCol, filter: '' });
    const second = cellAt(gd, target, 0, 1).colId;
    setPull(gd, target, second, { tableId: source, colId: sourceCol, filter: 'leh' });
    const record = tableById(gd, target);
    expect(record?.columns.map((c) => c.source)).toEqual(['entered', 'pulled']);
    expect(record?.rows).toHaveLength(2);
  });
});

describe('REF-03 mapping columns', () => {
  test('REF-03 a mapping column offers the target distinct values, collated, and writes only those', () => {
    const { gd, sheetId } = harness();
    const regions = grid(gd, sheetId, 'Regions', [
      ['Nepal', ''],
      ['india', ''],
      ['Nepal ', ''],
      ['Éire', ''],
      ['', ''],
    ]);
    const trek = grid(gd, sheetId, 'Trek', [['Lukla', '']]);
    const targetCol = cellAt(gd, regions, 0, 0).colId;
    const colId = addMappingColumn(gd, trek, { tableId: regions, colId: targetCol });
    if (colId === null) throw new Error('no column');
    const record = tableById(gd, trek);
    expect(record?.columns[2]?.label).toBe('↔ Regions · Column 1');
    expect(record?.columns[2]?.source).toBe('linked');
    expect(record?.columns[2]?.link).toEqual({ tableId: regions, colId: targetCol });
    expect(distinctValues(gd, { tableId: regions, colId: targetCol }, 'en-GB')).toEqual([
      'Éire',
      'india',
      'Nepal',
    ]);
    const rowId = record?.rows[0] ?? '';
    const table = tableMap(gd, trek);
    if (table === null) throw new Error('no table');
    expect(cellReadOnlyReason(table, rowId, colId)).toBe('linked');
    expect(setMappingValue(gd, trek, rowId, colId, 'Tibet')).toBe(false);
    expect(setMappingValue(gd, trek, rowId, colId, 'Nepal')).toBe(true);
    expect(cellText(table, rowId, colId)).toBe('Nepal');
    expect(setMappingValue(gd, trek, rowId, colId, '')).toBe(true);
    expect(cellText(table, rowId, colId)).toBe('');
    expect(setMappingValue(gd, trek, rowId, cellAt(gd, trek, 0, 0).colId, 'Nepal')).toBe(false);
    expect(addMappingColumn(gd, trek, { tableId: regions, colId: 'nope' })).toBeNull();
    // A derived column has no stored values to pick from: refused (REF-03).
    const derived = addDerivedColumn(gd, regions, {
      sourceColId: targetCol,
      method: 'Format',
      args: ['Trimmed'],
    });
    expect(addMappingColumn(gd, trek, { tableId: regions, colId: derived ?? '' })).toBeNull();
  });
});

describe('REF-05 guard', () => {
  test('REF-05 derived, linked and pulled cells are read-only in every path and are not graph dimensions', () => {
    const { gd, sheetId } = harness();
    const regions = grid(gd, sheetId, 'Regions', [['Nepal', '']]);
    const t = grid(gd, sheetId, 'Trek', [['Lukla (2860 m)', '']]);
    const source = cellAt(gd, t, 0, 0).colId;
    const regionCol = cellAt(gd, regions, 0, 0).colId;
    const receiving = cellAt(gd, t, 0, 1).colId;
    const derived = addDerivedColumn(gd, t, {
      sourceColId: source,
      method: 'Format',
      args: ['Trimmed'],
    });
    const linked = addMappingColumn(gd, t, { tableId: regions, colId: regionCol });
    setPull(gd, t, receiving, { tableId: regions, colId: regionCol, filter: '' });
    if (derived === null || linked === null) throw new Error('columns');
    const record = tableById(gd, t);
    const table = tableMap(gd, t);
    if (record === null || table === null) throw new Error('no table');
    const own = record.rows[0] ?? '';
    const pulledRow = record.rows[record.rows.length - 1] ?? '';
    // The grid, find and replace and paste all ask this one question (GRID-04, FIND-08).
    expect(cellReadOnlyReason(table, own, derived)).toBe('derived');
    expect(cellReadOnlyReason(table, own, linked)).toBe('linked');
    expect(cellReadOnlyReason(table, own, receiving)).toBe('pulled');
    expect(cellReadOnlyReason(table, pulledRow, source)).toBe('pulled');
    expect(cellReadOnlyReason(table, own, source)).toBeNull();
    // The guard is the app layer's (ADR-032): the core mutations write what they are given —
    // the grid, find and the picker refuse before calling them. Pinned so the split is explicit.
    expect(setCellText(gd, t, own, derived, 'typed into a derived cell')).toBe(true);
    expect(cellText(table, own, derived)).toBe('typed into a derived cell');
    expect(commitCellText(gd, t, own, linked, 'typed into a linked cell')).toBe(true);
    // The search snapshot marks every such cell, so replace skips it (FIND-08).
    const readOnly = new Map(
      (tableEntries(gd, t)?.entries ?? [])
        .filter((e) => e.kind === 'cell')
        .map((e) => [`${e.rowId}:${e.colId}`, e.readOnly] as const),
    );
    expect(readOnly.get(`${own}:${source}`)).toBe(false);
    expect(readOnly.get(`${pulledRow}:${receiving}`)).toBe(true);
    // Graph dimensions: only entered columns are offered (PRD §19).
    expect(record.columns.map((c) => isGraphDimensionCandidate(c))).toEqual([
      true, // the source
      false, // derived, placed after its source
      false, // the receiving (pulled) column
      false, // linked
    ]);
  });
});
