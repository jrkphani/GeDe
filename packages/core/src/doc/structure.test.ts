/**
 * Row, column and table structure (GRID-02, GRID-04, GRID-08..11): every
 * mutation is one undo step, snaps to the lattice, and two replicas that edit
 * structure concurrently converge on the same addresses.
 */
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addColumn,
  addRow,
  cellAddress,
  cellReadOnlyReason,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  deleteColumn,
  deleteRow,
  distributeUnits,
  headerRow,
  hideColumn,
  insertRowBefore,
  openDocument,
  orphanCellKeys,
  rowHeights,
  scaleTable,
  setCellText,
  setColumnWidth,
  setColumnWrap,
  setFooterRows,
  setFrozenColumns,
  setHeaderRows,
  setRowHeight,
  setRowHeights,
  setRowWrap,
  distributeEvenly,
  evenShares,
  sweepOrphanCells,
  TABLE_TITLE_ROWS,
  tableAddresses,
  tableById,
  tableMap,
  tableUnitBounds,
  tableWidthUnits,
  unhideAllColumns,
  unhideColumn,
  rowMeta,
  tableBodyUnits,
  type GedeDoc,
  type TableMap,
} from './index.js';
import {
  effectiveWrap,
  setCellAppearance,
  setColumnAppearance,
  setTableLook,
  wrapScopeOf,
} from '../style/index.js';

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

/** Two replicas that start in sync and then diverge until `merge` is called. */
function offlinePair(seed: (a: GedeDoc) => void): { a: GedeDoc; b: GedeDoc; merge: () => void } {
  const a = fresh();
  const b = fresh();
  seed(a);
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  return {
    a,
    b,
    merge: () => {
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
    },
  };
}

function table(gd: GedeDoc, tableId: string): TableMap {
  const map = tableMap(gd, tableId);
  if (map === null) throw new Error('no table');
  return map;
}

interface Fixture {
  gd: GedeDoc;
  id: string;
  rows: string[];
  cols: string[];
}

/** A 3 × 3 table at A1: title rows 1–2, header row 3, data A4:C6. */
function fixture(gd: GedeDoc = fresh(), at = { col: 0, row: 0 }): Fixture {
  const sheet = createSheet(gd);
  const id = createTable(gd, { sheetId: sheet, at, columns: 3, rows: 3 });
  const rec = tableById(gd, id);
  return {
    gd,
    id,
    rows: [...(rec?.rows ?? [])],
    cols: rec?.columns.map((c) => c.id) ?? [],
  };
}

describe('addressing recomputes on every structural edit', () => {
  test('GRID-02 insert, delete, hide and wrap each move the addresses of what follows, and nothing stores one', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    const [r1, r2, r3] = rows as [string, string, string];
    const [c1, c2, c3] = cols as [string, string, string];
    setCellText(gd, id, r3, c3, 'corner');
    expect(cellAddress(t, r3, c3)).toBe('C6');
    // Insert above the first row: everything below moves one down.
    insertRowBefore(gd, id, r1);
    expect(cellAddress(t, r1, c1)).toBe('A5');
    expect(cellAddress(t, r3, c3)).toBe('C7');
    // Delete the second row: what follows moves back up, its cells go with it.
    setCellText(gd, id, r2, c1, 'doomed');
    expect(deleteRow(gd, id, r2)).toBe(true);
    expect(deleteRow(gd, id, r2)).toBe(false); // already gone: not an error
    expect(cellAddress(t, r2, c1)).toBeNull();
    expect(cellAddress(t, r3, c3)).toBe('C6');
    expect(JSON.stringify(t.toJSON())).not.toContain('doomed');
    // Hide the first column: the second takes its letter; the hidden one has no address.
    hideColumn(gd, id, c1);
    expect(cellAddress(t, r3, c2)).toBe('A6');
    expect(cellAddress(t, r3, c3)).toBe('B6');
    expect(cellAddress(t, r3, c1)).toBeNull();
    unhideColumn(gd, id, c1);
    expect(cellAddress(t, r3, c2)).toBe('B6');
    // Delete a column: what follows moves left and its cells are gone.
    setCellText(gd, id, r1, c2, 'middle');
    expect(deleteColumn(gd, id, c2)).toBe(true);
    expect(cellAddress(t, r3, c3)).toBe('B6');
    expect(cellText(t, r1, c2)).toBe('');
    expect(JSON.stringify(t.toJSON())).not.toContain('middle');
    // Make the row above two units tall: the corner is two addresses down.
    setRowHeight(gd, id, r1, 2);
    expect(cellAddress(t, r3, c3)).toBe('B7');
    expect(cellText(t, r3, c3)).toBe('corner');
    expect(JSON.stringify(t.toJSON())).not.toMatch(/"[A-Z]{1,3}[0-9]{1,4}"/);
  });

  test('GRID-09 wrap at any scope is paint: column, row, table and cell wrap write no height and move no address (ADR-049)', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    const [r1, r2, r3] = rows as [string, string, string];
    const c2 = cols[1] ?? '';
    const column = () => tableById(gd, id)?.columns[1] ?? null;
    setColumnWrap(gd, id, c2, true);
    expect(rowHeights(t)).toEqual([1, 1, 1]);
    expect(tableAddresses(t).map((row) => row[0])).toEqual(['A4', 'A5', 'A6']);
    expect(column()?.wrap).toBe(true);
    expect(effectiveWrap(t, column(), r1)).toBe(true);
    // Precedence: cell > row > column > table.
    setRowWrap(gd, id, r1, false);
    expect(effectiveWrap(t, column(), r1)).toBe(false);
    expect(wrapScopeOf(t, column()!, r1)).toBe('row');
    setCellAppearance(gd, id, r1, c2, { wrap: true });
    expect(effectiveWrap(t, column(), r1)).toBe(true);
    expect(wrapScopeOf(t, column()!, r1)).toBe('cell');
    setColumnWrap(gd, id, c2, null);
    expect(effectiveWrap(t, column(), r2)).toBe(false);
    expect(wrapScopeOf(t, column()!, r2)).toBe('table');
    setTableLook(gd, id, { wrap: true });
    expect(effectiveWrap(t, column(), r2)).toBe(true);
    expect(effectiveWrap(t, column(), r1)).toBe(true); // the cell override still wins
    setCellAppearance(gd, id, r1, c2, { wrap: null });
    expect(effectiveWrap(t, column(), r1)).toBe(false); // the row's false now wins
    setRowWrap(gd, id, r1, null);
    expect(effectiveWrap(t, column(), r1)).toBe(true);
    // Column-scope wrap has one home: the column key, never the appearance map.
    setColumnAppearance(gd, id, c2, { wrap: false });
    expect(column()?.wrap).toBe(false);
    expect(column()?.appearance.wrap).toBeUndefined();
    // Nothing above changed a height or an address.
    expect(rowHeights(t)).toEqual([1, 1, 1]);
    expect(cellAddress(t, r3, c2)).toBe('B6');
  });

  test('GRID-09 a legacy two-unit row with no wrap key reads wrapped; an ADR-049 row reads what it stores', () => {
    const { gd, id, rows } = fixture();
    const t = table(gd, id);
    const r1 = rows[0] ?? '';
    const metas = t.get('rowMeta') as Y.Map<Y.Map<unknown>>;
    gd.doc.transact(() => {
      metas.get(r1)?.set('height', 2);
    });
    expect(rowMeta(t, r1)).toMatchObject({ height: 2, fit: true, wrap: true });
    // A stored fraction or a value below one is snapped: addressing stays exact (GRID-01).
    gd.doc.transact(() => {
      metas.get(r1)?.set('height', 0.2);
    });
    expect(rowMeta(t, r1).height).toBe(1);
    setRowHeight(gd, id, r1, 3); // a hand-set height: the row stops following its content
    expect(rowMeta(t, r1)).toMatchObject({ height: 3, fit: false, wrap: null });
    setRowHeight(gd, id, r1, 2, 'auto'); // refused: the row keeps what was set by hand
    expect(rowMeta(t, r1)).toMatchObject({ height: 3, fit: false });
    setRowHeight(gd, id, r1, 5, 'auto');
    expect(rowMeta(t, r1)).toMatchObject({ height: 3, fit: false });
    setRowHeight(gd, id, r1, 2, 'fit'); // Fit to content: follows its content again
    expect(rowMeta(t, r1)).toMatchObject({ height: 2, fit: true });
    setRowHeight(gd, id, r1, 1, 'auto');
    expect(rowMeta(t, r1)).toMatchObject({ height: 1, fit: true, wrap: null });
  });

  test('GRID-08 distributeEvenly shares the total in whole units, the remainder to the first, for a selection or the whole axis, in one undo step', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    expect(evenShares([1, 4, 2])).toEqual([3, 2, 2]);
    expect(evenShares([1, 1])).toEqual([1, 1]);
    expect(evenShares([])).toEqual([]);
    setColumnWidth(gd, id, cols[0] ?? '', 5);
    expect(distributeEvenly(gd, id, 'column')).toEqual([3, 2, 2]);
    expect(distributeEvenly(gd, id, 'column', [cols[0] ?? '', cols[1] ?? ''])).toEqual([3, 2]);
    expect(tableById(gd, id)?.columns.map((c) => c.width)).toEqual([3, 2, 2]);
    setRowHeight(gd, id, rows[2] ?? '', 4);
    expect(distributeEvenly(gd, id, 'row')).toEqual([2, 2, 2]);
    expect(rowHeights(t)).toEqual([2, 2, 2]);
    expect(rowMeta(t, rows[0] ?? '').fit).toBe(false);
    expect(undo.undoStack).toHaveLength(4);
    undo.undo();
    expect(rowHeights(t)).toEqual([1, 1, 4]);
  });

  test('GRID-02 unhideAllColumns reveals every hidden column in one step', () => {
    const { gd, id, cols } = fixture();
    hideColumn(gd, id, cols[0] ?? '');
    hideColumn(gd, id, cols[2] ?? '');
    expect(tableWidthUnits(tableById(gd, id)!)).toBe(1);
    expect(unhideAllColumns(gd, id).sort()).toEqual([cols[0], cols[2]].sort());
    expect(unhideAllColumns(gd, id)).toEqual([]);
    expect(tableWidthUnits(tableById(gd, id)!)).toBe(3);
  });
});

describe('resize and scale snap to the lattice', () => {
  test('GRID-08 setColumnWidth takes whole units with a floor of one and refuses non-finite widths', () => {
    const { gd, id, cols } = fixture();
    const c1 = cols[0] ?? '';
    expect(setColumnWidth(gd, id, c1, 2.4)).toBe(2);
    expect(tableById(gd, id)?.columns[0]?.width).toBe(2);
    expect(setColumnWidth(gd, id, c1, 0)).toBe(1);
    expect(() => setColumnWidth(gd, id, c1, Number.NaN)).toThrow(RangeError);
    expect(() => setColumnWidth(gd, id, 'nope', 1)).toThrow(RangeError);
  });

  test('GRID-08 distributeUnits shares whole units in proportion, sums exactly, floors at one', () => {
    expect(distributeUnits([1, 1, 1], 4)).toEqual([2, 1, 1]);
    expect(distributeUnits([1, 1, 1], 5)).toEqual([2, 2, 1]);
    expect(distributeUnits([2, 1, 1], 8)).toEqual([4, 2, 2]);
    expect(distributeUnits([3, 1], 2)).toEqual([1, 1]); // never below one each
    expect(distributeUnits([3, 1], 3)).toEqual([2, 1]);
    expect(distributeUnits([4, 2, 2], 4)).toEqual([2, 1, 1]);
    expect(distributeUnits([], 5)).toEqual([]);
    expect(distributeUnits([1, 1], 0)).toEqual([1, 1]);
    for (const [sizes, total] of [
      [[1, 2, 3], 7],
      [[5, 5, 5], 4],
      [[1, 1, 1, 1], 9],
      [[7, 3], 11],
    ] as const) {
      const out = distributeUnits(sizes, total);
      expect(out.reduce((a, b) => a + b, 0)).toBe(Math.max(sizes.length, total));
      expect(out.every((w) => Number.isInteger(w) && w >= 1)).toBe(true);
    }
  });

  test('GRID-08 scaleTable spreads the width across visible columns and the height across visible rows, whole units each', () => {
    const { gd, id, cols, rows } = fixture();
    const t = table(gd, id);
    hideColumn(gd, id, cols[1] ?? '');
    expect(scaleTable(gd, id, { widthUnits: 5 })).toEqual([3, 2]);
    expect(tableById(gd, id)?.columns.map((c) => c.width)).toEqual([3, 1, 2]);
    expect(tableWidthUnits(tableById(gd, id)!)).toBe(5);
    scaleTable(gd, id, { heightUnits: 6 });
    expect(rowHeights(t)).toEqual([2, 2, 2]);
    expect(rowMeta(t, rows[0] ?? '').fit).toBe(false);
    scaleTable(gd, id, { heightUnits: 7 });
    expect(rowHeights(t)).toEqual([3, 2, 2]);
    scaleTable(gd, id, { heightUnits: 1, widthUnits: 1 });
    expect(rowHeights(t)).toEqual([1, 1, 1]);
    expect(tableById(gd, id)?.columns.map((c) => c.width)).toEqual([1, 1, 1]);
    expect(tableBodyUnits(t)).toBe(3);
  });

  test('GRID-08 GRID-09 KEYS-03 writing the height a row already has writes nothing: no undo step is added; a real change is one step however many rows it touches', () => {
    const { gd, id, rows } = fixture();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    // Every row is born with its meta map (so concurrent first writes on two replicas both
    // land, HIER-10); a no-op write must still leave it untouched and add no undo step.
    const metas = table(gd, id).get('rowMeta') as Y.Map<Y.Map<unknown>>;
    expect(metas.size).toBe(3);
    setRowHeights(
      gd,
      id,
      rows.map((rowId) => ({ rowId, units: 1 })),
      'auto',
    );
    setRowHeight(gd, id, rows[0] ?? '', 1, 'auto');
    setRowWrap(gd, id, rows[0] ?? '', null);
    expect(metas.get(rows[0] ?? '')?.get('height')).toBe(1);
    expect(undo.undoStack).toHaveLength(0);
    // A real change still writes exactly what it needs.
    setRowHeight(gd, id, rows[0] ?? '', 2);
    expect(metas.get(rows[0] ?? '')?.get('height')).toBe(2);
    expect(undo.undoStack).toHaveLength(1);
    setRowHeights(
      gd,
      id,
      rows.map((rowId) => ({ rowId, units: 4 })),
    );
    expect(rowHeights(table(gd, id))).toEqual([4, 4, 4]);
    expect(undo.undoStack).toHaveLength(2);
    undo.undo();
    expect(rowHeights(table(gd, id))).toEqual([2, 1, 1]);
  });

  test('GRID-01 GRID-08 a column resize never desynchronises the ruler from the data: the address follows the width', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    const r1 = rows[0] ?? '';
    setColumnWidth(gd, id, cols[0] ?? '', 3);
    expect(cellAddress(t, r1, cols[1] ?? '')).toBe('D4');
    expect(tableUnitBounds(t).cols).toBe(5);
    scaleTable(gd, id, { widthUnits: 10 });
    expect(cellAddress(t, r1, cols[1] ?? '')).toBe('G4');
    expect(tableUnitBounds(t).cols).toBe(10);
  });
});

describe('frozen columns, header and footer strips', () => {
  test('GRID-10 setFrozenColumns clamps to the table and shrinks when columns are deleted', () => {
    const { gd, id, cols } = fixture();
    expect(tableById(gd, id)?.frozenColumns).toBe(0);
    expect(setFrozenColumns(gd, id, 2)).toBe(2);
    expect(setFrozenColumns(gd, id, 9)).toBe(3);
    expect(setFrozenColumns(gd, id, -1)).toBe(0);
    expect(setFrozenColumns(gd, id, Number.NaN)).toBe(0);
    setFrozenColumns(gd, id, 3);
    deleteColumn(gd, id, cols[2] ?? '');
    expect(tableById(gd, id)?.frozenColumns).toBe(2);
    // A stale count written by another client is still read clamped.
    table(gd, id).set('frozenColumns', 40);
    expect(tableById(gd, id)?.frozenColumns).toBe(2);
  });

  test('GRID-11 header 0 moves the data up one lattice row; footer 1 adds a strip to the footprint', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    expect(headerRow(tableById(gd, id)!)).toBe(TABLE_TITLE_ROWS);
    expect(cellAddress(t, rows[0] ?? '', cols[0] ?? '')).toBe('A4');
    setHeaderRows(gd, id, 0);
    expect(headerRow(tableById(gd, id)!)).toBeNull();
    expect(cellAddress(t, rows[0] ?? '', cols[0] ?? '')).toBe('A3');
    expect(tableUnitBounds(t).rows).toBe(TABLE_TITLE_ROWS + 3);
    setFooterRows(gd, id, 1);
    expect(tableUnitBounds(t).rows).toBe(TABLE_TITLE_ROWS + 3 + 1);
    expect(cellAddress(t, rows[2] ?? '', cols[0] ?? '')).toBe('A5'); // the footer follows the data
    setHeaderRows(gd, id, 1);
    expect(tableUnitBounds(t).rows).toBe(TABLE_TITLE_ROWS + 1 + 3 + 1);
    // Anything but 0 or 1 in the map reads as the default.
    t.set('headerRows', 3);
    expect(tableById(gd, id)?.headerRows).toBe(1);
  });
});

describe('read-only cells', () => {
  test('GRID-04 derived, linked, pulled and group cells are not editable; the reason names which', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    const [r1, r2] = rows as [string, string];
    const [c1, c2] = cols as [string, string];
    expect(cellReadOnlyReason(t, r1, c1)).toBeNull();
    const columns = t.get('columns') as Y.Array<Y.Map<unknown>>;
    columns.get(1).set('source', 'derived');
    expect(cellReadOnlyReason(t, r1, c2)).toBe('derived');
    columns.get(1).set('source', 'linked');
    expect(cellReadOnlyReason(t, r1, c2)).toBe('linked');
    columns.get(1).set('source', 'pulled');
    expect(cellReadOnlyReason(t, r1, c2)).toBe('pulled');
    columns.get(1).set('source', 'nonsense');
    expect(cellReadOnlyReason(t, r1, c2)).toBeNull(); // unknown source reads as entered
    const meta = new Y.Map<unknown>();
    meta.set('group', true);
    (t.get('rowMeta') as Y.Map<unknown>).set(r2, meta);
    expect(cellReadOnlyReason(t, r2, c1)).toBe('group');
    expect(cellReadOnlyReason(t, r1, c1)).toBeNull();
    expect(tableById(gd, id)?.columns[1]?.source).toBe('entered');
  });
});

describe('undo', () => {
  test('KEYS-03 GRID-02 every structural change is one undo step: delete row, delete column, hide, resize, freeze, header', () => {
    const { gd, id, rows, cols } = fixture();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const t = table(gd, id);
    const r2 = rows[1] ?? '';
    const c1 = cols[0] ?? '';
    setCellText(gd, id, r2, c1, 'keep me');
    deleteRow(gd, id, r2);
    expect(tableById(gd, id)?.rows).toHaveLength(2);
    undo.undo();
    expect(tableById(gd, id)?.rows).toEqual(rows);
    expect(cellText(t, r2, c1)).toBe('keep me');
    deleteColumn(gd, id, c1);
    hideColumn(gd, id, cols[1] ?? '');
    setColumnWidth(gd, id, cols[2] ?? '', 4);
    setFrozenColumns(gd, id, 1);
    setHeaderRows(gd, id, 0);
    expect(undo.undoStack.length).toBeGreaterThanOrEqual(5);
    undo.undo(); // header
    expect(tableById(gd, id)?.headerRows).toBe(1);
    undo.undo(); // freeze
    expect(tableById(gd, id)?.frozenColumns).toBe(0);
    undo.undo(); // width
    expect(tableById(gd, id)?.columns.find((c) => c.id === cols[2])?.width).toBe(1);
    undo.undo(); // hide
    expect(tableById(gd, id)?.columns.find((c) => c.id === cols[1])?.hidden).toBe(false);
    undo.undo(); // delete column
    expect(tableById(gd, id)?.columns.map((c) => c.id)).toEqual(cols);
    expect(cellText(t, r2, c1)).toBe('keep me');
    undo.redo();
    expect(tableById(gd, id)?.columns).toHaveLength(2);
  });
});

describe('two replicas converge on structure', () => {
  test('LOAD-06 GRID-02 a concurrent row insert on one side and row delete on the other merge without losing either', () => {
    const { a, b, merge } = offlinePair((gd) => {
      fixture(gd);
    });
    const id = tableById(a, Object.keys(a.tables.toJSON())[0] ?? '')?.id ?? '';
    const rows = [...(tableById(a, id)?.rows ?? [])];
    const cols = tableById(a, id)?.columns.map((c) => c.id) ?? [];
    const [r1, r2, r3] = rows as [string, string, string];
    // A inserts after the first row and writes into it; B deletes the second row.
    const inserted = addRow(a, id, r1);
    setCellText(a, id, inserted, cols[0] ?? '', 'from a');
    deleteRow(b, id, r2);
    setCellText(b, id, r3, cols[0] ?? '', 'from b');
    merge();
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    expect(tableById(a, id)?.rows).toEqual([r1, inserted, r3]);
    expect(tableAddresses(table(a, id))).toEqual(tableAddresses(table(b, id)));
    expect(cellAddress(table(b, id), inserted, cols[0] ?? '')).toBe('A5');
    expect(cellAddress(table(b, id), r3, cols[0] ?? '')).toBe('A6');
    expect(cellText(table(b, id), inserted, cols[0] ?? '')).toBe('from a');
    expect(cellText(table(a, id), r3, cols[0] ?? '')).toBe('from b');
  });

  test('LOAD-06 GRID-08 GRID-10 a resize on one replica and a freeze on the other both survive the merge', () => {
    const { a, b } = pair();
    const { id, cols } = fixture(a);
    setColumnWidth(a, id, cols[0] ?? '', 3);
    setFrozenColumns(b, id, 2);
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    expect(tableById(b, id)?.columns[0]?.width).toBe(3);
    expect(tableById(a, id)?.frozenColumns).toBe(2);
    // Both delete the same column concurrently: one delete wins, nothing is lost twice.
    const doomed = cols[2] ?? '';
    const { a: a2, b: b2, merge } = offlinePair((gd) => Object.assign(gd, fixture(gd)));
    const id2 = Object.keys(a2.tables.toJSON())[0] ?? '';
    const col2 = tableById(a2, id2)?.columns[2]?.id ?? '';
    expect(deleteColumn(a2, id2, col2)).toBe(true);
    expect(deleteColumn(b2, id2, col2)).toBe(true);
    merge();
    expect(a2.tables.toJSON()).toEqual(b2.tables.toJSON());
    expect(tableById(a2, id2)?.columns).toHaveLength(2);
    expect(tableById(a2, id2)?.columns.some((c) => c.id === col2)).toBe(false);
    expect(doomed).not.toBe('');
  });

  test('LOAD-06 GRID-09 GRID-11 wrap, header and footer changes converge and give both replicas the same footprint', () => {
    const { a, b } = pair();
    const { id, cols, rows } = fixture(a);
    setColumnWrap(a, id, cols[1] ?? '', true);
    setHeaderRows(b, id, 0);
    setFooterRows(a, id, 1);
    setRowHeight(b, id, rows[0] ?? '', 4);
    setRowHeight(a, id, rows[1] ?? '', 2, 'auto');
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    expect(tableUnitBounds(table(a, id))).toEqual(tableUnitBounds(table(b, id)));
    expect(tableUnitBounds(table(a, id)).rows).toBe(TABLE_TITLE_ROWS + 0 + 7 + 1);
    expect(tableAddresses(table(a, id))).toEqual(tableAddresses(table(b, id)));
  });

  test('GRID-07 addColumn inserts before a given column and converges', () => {
    const { a, b } = pair();
    const { id, cols } = fixture(a);
    const first = addColumn(a, id, { label: 'First', beforeColId: cols[0] });
    const mid = addColumn(b, id, { label: 'Mid', beforeColId: cols[2], afterColId: cols[0] });
    expect(tableById(b, id)?.columns.map((c) => c.id)).toEqual([
      first,
      cols[0],
      cols[1],
      mid,
      cols[2],
    ]);
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
  });
});

describe('addresses agree across projections', () => {
  test('GRID-02 tableAddresses and cellAddress give the same answer for a hidden column: null, and the successor takes the letter', () => {
    const { gd, id, rows, cols } = fixture();
    const t = table(gd, id);
    hideColumn(gd, id, cols[1] ?? '');
    const grid = tableAddresses(t);
    expect(grid[0]).toEqual(['A4', null, 'B4']);
    expect(grid[2]).toEqual(['A6', null, 'B6']);
    rows.forEach((rowId, ri) => {
      cols.forEach((colId, ci) => {
        expect(cellAddress(t, rowId, colId)).toBe(grid[ri]?.[ci] ?? null);
      });
    });
    unhideColumn(gd, id, cols[1] ?? '');
    expect(tableAddresses(t)[0]).toEqual(['A4', 'B4', 'C4']);
  });
});

describe('orphan cells', () => {
  test('GRID-02 LOAD-06 a row deleted on one replica while another wrote into it leaves an orphan the sweep removes; a write into a vanished row is refused', () => {
    const { a, b, merge } = offlinePair((gd) => {
      fixture(gd);
    });
    const id = Object.keys(a.tables.toJSON())[0] ?? '';
    const rec = tableById(a, id);
    const r2 = rec?.rows[1] ?? '';
    const c1 = rec?.columns[0]?.id ?? '';
    // The reviewer's probe: deleteRow ‖ setCellText, then merge.
    expect(deleteRow(a, id, r2)).toBe(true);
    expect(setCellText(b, id, r2, c1, 'written offline')).toBe(true);
    merge();
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    expect(tableById(a, id)?.rows).not.toContain(r2);
    expect(orphanCellKeys(table(a, id))).toEqual([`${r2}:${c1}`]);
    // Addresses never saw it; the sweep takes it out on both sides and is not an undo step.
    const undoA = createUndoManager(a, { captureTimeout: 0 });
    expect(sweepOrphanCells(a, id)).toBe(1);
    expect(orphanCellKeys(table(a, id))).toEqual([]);
    expect(undoA.undoStack).toHaveLength(0);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    expect(orphanCellKeys(table(b, id))).toEqual([]);
    expect(sweepOrphanCells(b, id)).toBe(0);
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    // Once the row is known to be gone, a late commit (the editor's unmount) writes nothing.
    let writes = 0;
    a.doc.on('update', () => {
      writes += 1;
    });
    expect(setCellText(a, id, r2, c1, 'late draft')).toBe(false);
    expect(setCellText(a, id, rec?.rows[0] ?? '', 'no-such-column', 'x')).toBe(false);
    expect(writes).toBe(0);
    expect(orphanCellKeys(table(a, id))).toEqual([]);
    // A deleted column behaves the same.
    const c3 = rec?.columns[2]?.id ?? '';
    deleteColumn(a, id, c3);
    expect(setCellText(a, id, rec?.rows[0] ?? '', c3, 'x')).toBe(false);
    expect(sweepOrphanCells(a, 'no-such-table')).toBe(0);
  });
});
