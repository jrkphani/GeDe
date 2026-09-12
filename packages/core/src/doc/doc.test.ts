import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { isId } from '../ids.js';
import { LATTICE } from '../lattice.js';
import {
  addColumn,
  addRow,
  assignPresenceColour,
  cellAddress,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  dataGeometry,
  deleteTable,
  documentMeta,
  ensureFirstSheet,
  initials,
  listSheets,
  objectCount,
  openDocument,
  resizeColumn,
  seedMeta,
  setCellText,
  setRowWrapped,
  setTablePosition,
  setTitle,
  sheetBounds,
  TABLE_HEADER_ROWS,
  TABLE_TITLE_ROWS,
  tableAddresses,
  tableById,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  toPresenceState,
  unitBoundsToPx,
  type GedeDoc,
} from './index.js';

function fresh(): GedeDoc {
  return openDocument(new Y.Doc());
}

/** Two replicas that exchange every update, as the sync service would relay them. */
function pair(): { a: GedeDoc; b: GedeDoc } {
  const a = fresh();
  const b = fresh();
  a.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(b.doc, update, 'relay');
  });
  b.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(a.doc, update, 'relay');
  });
  return { a, b };
}

function table(gd: GedeDoc, tableId: string) {
  const map = tableMap(gd, tableId);
  if (map === null) throw new Error('no table');
  return map;
}

describe('document schema', () => {
  test('DOC-03 sheets carry id, label, ordinal and parentContext; + appends at the end', () => {
    const gd = fresh();
    const first = createSheet(gd);
    const second = createSheet(gd, { label: 'GovernBASE' });
    const child = createSheet(gd, { label: 'Children of α', parentContext: 'α' });
    const sheets = listSheets(gd);
    expect(sheets.map((s) => s.id)).toEqual([first, second, child]);
    expect(sheets.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(sheets.map((s) => s.label)).toEqual(['Sheet 1', 'GovernBASE', 'Children of α']);
    expect(sheets[2]?.parentContext).toBe('α');
    expect(sheets[0]?.parentContext).toBeNull();
    expect(sheets.every((s) => isId(s.id))).toBe(true);
  });

  test('DOC-03 ensureFirstSheet is idempotent and never an undo step', () => {
    const gd = fresh();
    const undo = createUndoManager(gd);
    const id = ensureFirstSheet(gd);
    expect(ensureFirstSheet(gd)).toBe(id);
    expect(listSheets(gd)).toHaveLength(1);
    expect(undo.canUndo()).toBe(false);
  });

  test('DOC-03 object count per sheet counts tables and graphs on that sheet', () => {
    const gd = fresh();
    const s1 = createSheet(gd);
    const s2 = createSheet(gd);
    createTable(gd, { sheetId: s1, at: { col: 0, row: 0 } });
    createTable(gd, { sheetId: s1, at: { col: 4, row: 0 } });
    createTable(gd, { sheetId: s2, at: { col: 0, row: 0 } });
    expect(objectCount(gd, s1)).toBe(2);
    expect(objectCount(gd, s2)).toBe(1);
    expect(tablesOnSheet(gd, s1).map((t) => t.title)).toEqual(['Table 1', 'Table 2']);
  });

  test('DOC-01 meta holds the title; seeding fills only what is missing and stays out of undo', () => {
    const gd = fresh();
    const undo = createUndoManager(gd);
    seedMeta(gd, { title: 'Everest trek', createdAt: '2026-09-12T00:00:00Z' });
    expect(documentMeta(gd)).toEqual({ title: 'Everest trek', createdAt: '2026-09-12T00:00:00Z' });
    expect(undo.canUndo()).toBe(false);
    setTitle(gd, 'Everest trek 2027');
    expect(undo.canUndo()).toBe(true);
    seedMeta(gd, { title: 'Overwrite attempt' });
    expect(documentMeta(gd).title).toBe('Everest trek 2027');
    undo.undo();
    expect(documentMeta(gd).title).toBe('Everest trek');
  });
});

describe('tables and snapping', () => {
  test('GRID-01 createTable snaps a pixel origin to whole lattice units', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { x: 330, y: 45 }, columns: 2, rows: 3 });
    const t = tableById(gd, id);
    expect(t?.gridCol).toBe(2);
    expect(t?.gridRow).toBe(2);
    expect(t?.columns).toHaveLength(2);
    expect(t?.rows).toHaveLength(3);
    expect(t?.columns.every((c) => c.width === 1)).toBe(true);
  });

  test('GRID-01 setTablePosition snaps and never goes above or left of A1', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 3, row: 3 } });
    setTablePosition(gd, id, { x: -40, y: 100 });
    expect(tableById(gd, id)).toMatchObject({ gridCol: 0, gridRow: 5 });
    setTablePosition(gd, id, { col: 2.6, row: -1 });
    expect(tableById(gd, id)).toMatchObject({ gridCol: 3, gridRow: 0 });
    // A non-finite unit is a caller bug; it must throw rather than store NaN / Infinity.
    expect(() => {
      setTablePosition(gd, id, { col: Number.NaN, row: 0 });
    }).toThrow(RangeError);
    expect(() => {
      setTablePosition(gd, id, { col: 0, row: Number.POSITIVE_INFINITY });
    }).toThrow();
    expect(tableMap(gd, id)?.toJSON()).toMatchObject({ gridCol: 3, gridRow: 0 });
  });

  test('GRID-01 resizeColumn snaps to whole units with a minimum of one', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 2 });
    const col = tableById(gd, id)?.columns[0]?.id ?? '';
    expect(resizeColumn(gd, id, col, 400)).toBe(3);
    expect(tableById(gd, id)?.columns[0]?.width).toBe(3);
    expect(resizeColumn(gd, id, col, 12)).toBe(1);
  });

  test('GRID-07 addRow and addColumn append by default and insert after a given id', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 1, rows: 2 });
    const before = tableById(gd, id);
    const appended = addRow(gd, id);
    const inserted = addRow(gd, id, before?.rows[0]);
    const after = tableById(gd, id);
    expect(after?.rows).toEqual([before?.rows[0], inserted, before?.rows[1], appended]);
    const col2 = addColumn(gd, id);
    const colMid = addColumn(gd, id, { label: 'Mid', afterColId: before?.columns[0]?.id });
    expect(tableById(gd, id)?.columns.map((c) => c.id)).toEqual([
      before?.columns[0]?.id,
      colMid,
      col2,
    ]);
    expect(tableById(gd, id)?.columns[1]?.label).toBe('Mid');
  });

  test('GRID-02 addresses derive from the lattice origin below the title and header rows', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 1, row: 2 }, columns: 2, rows: 2 });
    const t = table(gd, id);
    expect(dataGeometry(t).origin).toEqual({
      col: 1,
      row: 2 + TABLE_TITLE_ROWS + TABLE_HEADER_ROWS,
    });
    // Title rows 3–4 (lattice rows 2,3), header at lattice row 4 → B5; data starts at B6.
    expect(tableAddresses(t)).toEqual([
      ['B6', 'C6'],
      ['B7', 'C7'],
    ]);
  });

  test('GRID-02 addresses recompute on insert and on column resize, without being stored', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 2, rows: 2 });
    const t = table(gd, id);
    const rec = tableById(gd, id);
    const [r1, r2] = rec?.rows ?? [];
    const [c1, c2] = rec?.columns.map((c) => c.id) ?? [];
    expect(cellAddress(t, r2 ?? '', c2 ?? '')).toBe('B5');
    addRow(gd, id, r1);
    expect(cellAddress(t, r2 ?? '', c2 ?? '')).toBe('B6');
    resizeColumn(gd, id, c1 ?? '', 320);
    expect(cellAddress(t, r2 ?? '', c2 ?? '')).toBe('C6');
    expect(cellAddress(t, 'nope', c2 ?? '')).toBeNull();
    // Nothing in the map is an address.
    expect(JSON.stringify(t.toJSON())).not.toMatch(/"[A-Z]{1,3}[0-9]{1,4}"/);
  });

  test('GRID-09 a wrapped row occupies two lattice rows so the row after it is two addresses down', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 1, rows: 3 });
    const t = table(gd, id);
    const rec = tableById(gd, id);
    const [r1, r2, r3] = rec?.rows ?? [];
    const c1 = rec?.columns[0]?.id ?? '';
    expect(cellAddress(t, r3 ?? '', c1)).toBe('A6');
    setRowWrapped(gd, id, r2 ?? '', true);
    expect(cellAddress(t, r1 ?? '', c1)).toBe('A4');
    expect(cellAddress(t, r2 ?? '', c1)).toBe('A5');
    expect(cellAddress(t, r3 ?? '', c1)).toBe('A7');
    expect(tableUnitBounds(t).rows).toBe(TABLE_TITLE_ROWS + TABLE_HEADER_ROWS + 4);
  });

  test('DOC-07 sheetBounds frames every table on the sheet, in units and pixels', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    createTable(gd, { sheetId: sheet, at: { col: 1, row: 1 }, columns: 2, rows: 2 });
    createTable(gd, { sheetId: sheet, at: { col: 5, row: 10 }, columns: 1, rows: 1 });
    const other = createSheet(gd);
    createTable(gd, { sheetId: other, at: { col: 40, row: 40 }, columns: 1, rows: 1 });
    const bounds = sheetBounds(gd, sheet);
    expect(bounds).toEqual({ col: 1, row: 1, cols: 5, rows: 13 });
    expect(unitBoundsToPx(bounds ?? { col: 0, row: 0, cols: 0, rows: 0 })).toEqual({
      x: LATTICE.col,
      y: LATTICE.row,
      width: 5 * LATTICE.col,
      height: 13 * LATTICE.row,
    });
    expect(sheetBounds(gd, 'empty')).toBeNull();
  });
});

describe('cells', () => {
  test('setCellText stores plain text as a paragraph fragment and formulas as strings', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
    const t = table(gd, id);
    const rec = tableById(gd, id);
    const row = rec?.rows[0] ?? '';
    const col = rec?.columns[0]?.id ?? '';
    setCellText(gd, id, row, col, 'Singapore');
    expect(cellText(t, row, col)).toBe('Singapore');
    const stored = t.get('cells');
    expect(stored).toBeInstanceOf(Y.Map);
    const value = (stored as Y.Map<unknown>).get(`${row}:${col}`);
    expect(value).toBeInstanceOf(Y.XmlFragment);
    setCellText(gd, id, row, col, '=Sum(B2:B4)');
    expect(cellText(t, row, col)).toBe('=Sum(B2:B4)');
    expect(typeof (stored as Y.Map<unknown>).get(`${row}:${col}`)).toBe('string');
    setCellText(gd, id, row, col, '');
    expect(cellText(t, row, col)).toBe('');
    expect((stored as Y.Map<unknown>).has(`${row}:${col}`)).toBe(false);
  });

  test('multi-line text round-trips as one paragraph per line', () => {
    const gd = fresh();
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
    const rec = tableById(gd, id);
    setCellText(gd, id, rec?.rows[0] ?? '', rec?.columns[0]?.id ?? '', 'a\nb');
    expect(cellText(table(gd, id), rec?.rows[0] ?? '', rec?.columns[0]?.id ?? '')).toBe('a\nb');
  });

  test('undo is scoped to local edits; a remote edit stays put', () => {
    const { a, b } = pair();
    const undoA = createUndoManager(a, { captureTimeout: 0 });
    const sheet = createSheet(a);
    const id = createTable(a, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 1, rows: 2 });
    const rec = tableById(a, id);
    const [r1, r2] = rec?.rows ?? [];
    const col = rec?.columns[0]?.id ?? '';
    setCellText(a, id, r1 ?? '', col, 'mine');
    setCellText(b, id, r2 ?? '', col, 'theirs');
    expect(cellText(table(a, id), r2 ?? '', col)).toBe('theirs');
    undoA.undo();
    expect(cellText(table(a, id), r1 ?? '', col)).toBe('');
    expect(cellText(table(a, id), r2 ?? '', col)).toBe('theirs');
    undoA.redo();
    expect(cellText(table(b, id), r1 ?? '', col)).toBe('mine');
  });
});

describe('convergence', () => {
  test('LOAD-06 two replicas applying each other’s updates converge on sheets, tables and cells', () => {
    const { a, b } = pair();
    const sheet = createSheet(a);
    const id = createTable(a, { sheetId: sheet, at: { col: 2, row: 4 }, columns: 2, rows: 2 });
    const rec = tableById(b, id);
    expect(rec).not.toBeNull();
    const [r1, r2] = rec?.rows ?? [];
    const [c1, c2] = rec?.columns.map((c) => c.id) ?? [];
    setCellText(a, id, r1 ?? '', c1 ?? '', 'from a');
    setCellText(b, id, r2 ?? '', c2 ?? '', 'from b');
    addRow(b, id);
    resizeColumn(a, id, c1 ?? '', 320);
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
    expect(a.doc.getMap('tables').toJSON()).toEqual(b.doc.getMap('tables').toJSON());
    expect(cellText(table(b, id), r1 ?? '', c1 ?? '')).toBe('from a');
    expect(cellText(table(a, id), r2 ?? '', c2 ?? '')).toBe('from b');
    expect(tableAddresses(table(a, id))).toEqual(tableAddresses(table(b, id)));
    expect(tableById(a, id)?.rows).toHaveLength(3);
  });

  test('LOAD-06 offline edits merge on reconnect without losing either side', () => {
    const a = fresh();
    const b = fresh();
    const sheet = createSheet(a);
    const id = createTable(a, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    const rec = tableById(a, id);
    const row = rec?.rows[0] ?? '';
    const col = rec?.columns[0]?.id ?? '';
    // Both go offline and diverge.
    setCellText(a, id, row, col, 'A wrote this');
    const rowB = addRow(b, id);
    setCellText(b, id, rowB, col, 'B wrote this');
    createSheet(b, { label: 'B sheet' });
    // Reconnect: exchange the deltas each side is missing.
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    expect(a.doc.getMap('tables').toJSON()).toEqual(b.doc.getMap('tables').toJSON());
    expect(cellText(table(b, id), row, col)).toBe('A wrote this');
    expect(cellText(table(a, id), rowB, col)).toBe('B wrote this');
    expect(listSheets(a).map((s) => s.label)).toEqual(['Sheet 1', 'B sheet']);
    deleteTable(a, id);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    expect(tableById(b, id)).toBeNull();
  });
});

describe('presence', () => {
  test('SHARE-04 awareness payload carries user, name, colour index, sheet and cell', () => {
    expect(
      toPresenceState({
        userId: 'u1',
        name: 'Meena',
        colour: 2,
        sheetId: 's1',
        cell: { tableId: 't', rowId: 'r', colId: 'c' },
      }),
    ).toEqual({
      userId: 'u1',
      name: 'Meena',
      colour: 2,
      sheetId: 's1',
      cell: { tableId: 't', rowId: 'r', colId: 'c' },
    });
    expect(toPresenceState({ userId: 'u1', name: 'x', colour: 7 })).toBeNull();
    expect(toPresenceState(null)).toBeNull();
  });

  test('SHARE-04 colours are assigned least-used first from the six presence tokens', () => {
    expect(assignPresenceColour([])).toBe(1);
    expect(assignPresenceColour([1])).toBe(2);
    expect(assignPresenceColour([1, 2, 3, 4, 5, 6])).toBe(1);
    expect(assignPresenceColour([1, 1, 2, 3, 4, 5, 6])).toBe(2);
  });

  test('SHARE-04 avatar fallback is initials, never a generated face', () => {
    expect(initials('Meenarapan D')).toBe('MD');
    expect(initials('sembian')).toBe('S');
    expect(initials('  ')).toBe('');
  });
});
