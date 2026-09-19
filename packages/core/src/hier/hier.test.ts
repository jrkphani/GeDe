/**
 * Hierarchy against the document (HIER-01..03, HIER-06, HIER-07, HIER-09,
 * HIER-10): every write is one undo step, validity is enforced in core, depth
 * never moves an address, collapse hides the subtree from geometry, and two
 * replicas converge.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellAddress,
  cellReadOnlyReason,
  createSheet,
  createTable,
  createUndoManager,
  deleteColumn,
  deleteRow,
  hideColumn,
  openDocument,
  rowHeights,
  rowMeta,
  setRowDepth,
  setRowHeight,
  unhideColumn,
  tableAddresses,
  tableById,
  tableMap,
  tableUnitBounds,
  type GedeDoc,
  type Id,
  type TableMap,
} from '../index.js';
import {
  clearSplitChildren,
  collapseAll,
  expandAll,
  markSplitChildren,
  nestRow,
  promoteRow,
  rowDepths,
  setOutlineColumn,
  setRowCollapsed,
  toggleRowCollapsed,
} from './mutations.js';
import { isValidDepths, rowOutline, tableOutline } from './outline.js';

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

function seed(
  gd: GedeDoc,
  rowCount = 6,
): { tableId: Id; rows: readonly Id[]; cols: readonly Id[]; table: TableMap } {
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: rowCount });
  const record = tableById(gd, tableId);
  const table = tableMap(gd, tableId);
  if (record === null || table === null) throw new Error('seed failed');
  return { tableId, rows: record.rows, cols: record.columns.map((c) => c.id), table };
}

/** r0 > r1 > r2, r0 > r3, r4, r5 — an outline with a two-level subtree under the first row. */
function outlineFixture(gd: GedeDoc) {
  const s = seed(gd);
  const [r0, r1, r2, r3] = s.rows;
  if (r0 === undefined || r1 === undefined || r2 === undefined || r3 === undefined)
    throw new Error('rows');
  nestRow(gd, s.tableId, r1);
  nestRow(gd, s.tableId, r2);
  nestRow(gd, s.tableId, r2);
  nestRow(gd, s.tableId, r3);
  expect(rowDepths(gd, s.tableId)).toEqual([0, 1, 2, 1, 0, 0]);
  return s;
}

describe('nest and promote (HIER-02, HIER-10)', () => {
  test('HIER-01 (partial: the write; the inspector mounts the controls later) HIER-10 nestRow stores depth per row in the document; promoteRow takes it back', () => {
    const gd = fresh();
    const { tableId, rows, table } = seed(gd);
    const r1 = rows[1] ?? '';
    expect(nestRow(gd, tableId, r1)).toBe(1);
    expect(rowMeta(table, r1).depth).toBe(1);
    expect(promoteRow(gd, tableId, r1)).toBe(0);
    expect(rowMeta(table, r1).depth).toBe(0);
  });

  test('HIER-02 the first row never nests, a row nests at most one deeper than the row above, and promote stops at 0', () => {
    const gd = fresh();
    const { tableId, rows } = seed(gd);
    const [r0, r1, r2] = rows;
    expect(nestRow(gd, tableId, r0 ?? '')).toBeNull();
    expect(promoteRow(gd, tableId, r0 ?? '')).toBeNull();
    expect(nestRow(gd, tableId, r1 ?? '')).toBe(1);
    expect(nestRow(gd, tableId, r1 ?? '')).toBeNull(); // r0 is at 0, so r1 stops at 1
    expect(nestRow(gd, tableId, r2 ?? '')).toBe(1);
    expect(nestRow(gd, tableId, r2 ?? '')).toBe(2);
    expect(nestRow(gd, tableId, r2 ?? '')).toBeNull();
    expect(nestRow(gd, tableId, 'not-a-row')).toBeNull();
    // The predicates the controls render from agree with what the writes accept.
    const table = tableMap(gd, tableId);
    if (table === null) throw new Error('table');
    expect(rowOutline(table, r1 ?? '')).toMatchObject({ canNest: false, canPromote: true });
    expect(rowOutline(table, r0 ?? '')).toMatchObject({ canNest: false, canPromote: false });
  });

  test('HIER-02 nest and promote carry the subtree with the row, so the outline stays valid', () => {
    const gd = fresh();
    const { tableId, rows } = outlineFixture(gd);
    const r0 = rows[0] ?? '';
    const r1 = rows[1] ?? '';
    // Promote r1 (which has r2 under it): r2 comes with it. r3, still at depth 1,
    // now resolves to r1 as its parent (HIER-03) — position is data.
    expect(promoteRow(gd, tableId, r1)).toBe(0);
    expect(rowDepths(gd, tableId)).toEqual([0, 0, 1, 1, 0, 0]);
    // Nest r1 again: its subtree is now r2 and r3, and both follow.
    expect(nestRow(gd, tableId, r1)).toBe(1);
    expect(rowDepths(gd, tableId)).toEqual([0, 1, 2, 2, 0, 0]);
    // The first row cannot move; nothing under it changes.
    expect(promoteRow(gd, tableId, r0)).toBeNull();
    expect(rowDepths(gd, tableId)).toEqual([0, 1, 2, 2, 0, 0]);
  });

  test('HIER-02 HIER-09 any sequence of accepted nests and promotes keeps the outline valid and every address where it was', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(5), fc.boolean()), { maxLength: 40 }), (ops) => {
        const gd = fresh();
        const { tableId, rows, table } = seed(gd);
        const before = tableAddresses(table);
        for (const [pick, nest] of ops) {
          const rowId = rows[pick] ?? '';
          if (nest) nestRow(gd, tableId, rowId);
          else promoteRow(gd, tableId, rowId);
          expect(isValidDepths(rowDepths(gd, tableId))).toBe(true);
        }
        expect(tableAddresses(table)).toEqual(before);
      }),
    );
  });

  test('HIER-02 HIER-04 HIER-09 any sequence of nests and promotes from any column — known, hidden or unknown — keeps the outline valid, every address in place, and every row’s outline column a visible column; a top-level row has none of its own', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(5), fc.boolean(), fc.nat(3)), { maxLength: 40 }),
        (ops) => {
          const gd = fresh();
          const { tableId, rows, cols, table } = seed(gd);
          const hiddenCol = cols[1] ?? '';
          hideColumn(gd, tableId, hiddenCol);
          const before = tableAddresses(table);
          for (const [pick, nest, col] of ops) {
            const rowId = rows[pick] ?? '';
            // 0 → column A, 1 → the hidden column, 2 → a column not in the table, 3 → no column.
            const colId =
              col === 0 ? cols[0] : col === 1 ? hiddenCol : col === 2 ? 'nope' : undefined;
            if (nest) nestRow(gd, tableId, rowId, colId);
            else promoteRow(gd, tableId, rowId, colId);
            expect(isValidDepths(rowDepths(gd, tableId))).toBe(true);
            const outline = tableOutline(table);
            for (const row of outline.rows) {
              expect(row.column).toBe(cols[0]);
              if (row.depth === 0) expect(rowMeta(table, row.id).outlineColumn).toBeNull();
            }
          }
          expect(tableAddresses(table)).toEqual(before);
        },
      ),
    );
  });

  test('HIER-01 (partial: the write) KEYS-03 a nest that moves a subtree is one undo step; a refused nest is no step at all', () => {
    const gd = fresh();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const { tableId, rows } = outlineFixture(gd);
    undo.clear();
    expect(promoteRow(gd, tableId, rows[1] ?? '')).toBe(0); // moves r1 and r2
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(rowDepths(gd, tableId)).toEqual([0, 1, 2, 1, 0, 0]);
    undo.redo();
    expect(rowDepths(gd, tableId)).toEqual([0, 0, 1, 1, 0, 0]);
    const steps = undo.undoStack.length;
    expect(nestRow(gd, tableId, rows[0] ?? '')).toBeNull();
    expect(undo.undoStack).toHaveLength(steps);
  });
});

describe('parent resolution (HIER-03)', () => {
  test('HIER-03 a row’s parent is the nearest row above at a shallower depth, or null at the top level', () => {
    const gd = fresh();
    const { rows, table } = outlineFixture(gd);
    const outline = tableOutline(table);
    expect(outline.rows.map((r) => r.parent)).toEqual([
      null,
      rows[0],
      rows[1],
      rows[0], // r3 at depth 1 skips r2 (deeper) and lands on r0
      null,
      null,
    ]);
    expect(outline.rows.map((r) => r.hasChildren)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  test('HIER-03 HIER-02 a stored depth a merge left invalid resolves through the effective depth', () => {
    const gd = fresh();
    const { tableId, rows, table } = seed(gd);
    setRowDepth(gd, tableId, rows[1] ?? '', 4); // raw write, as a merge could leave it
    const row = rowOutline(table, rows[1] ?? '');
    expect(row?.depth).toBe(1);
    expect(row?.parent).toBe(rows[0]);
  });
});

describe('collapse (HIER-06, HIER-09, HIER-10)', () => {
  test('HIER-06 collapsing a parent hides its whole subtree from geometry: no height, no address, the rows below move up', () => {
    const gd = fresh();
    const { tableId, rows, cols, table } = outlineFixture(gd);
    const c0 = cols[0] ?? '';
    // Data starts at B5 (title rows 2–3, header row 4).
    expect(rows.map((r) => cellAddress(table, r, c0))).toEqual([
      'B5',
      'B6',
      'B7',
      'B8',
      'B9',
      'B10',
    ]);
    expect(setRowCollapsed(gd, tableId, rows[0] ?? '', true)).toBe(true);
    expect(rowHeights(table)).toEqual([1, 0, 0, 0, 1, 1]);
    expect(rows.map((r) => cellAddress(table, r, c0))).toEqual([
      'B5',
      null,
      null,
      null,
      'B6',
      'B7',
    ]);
    expect(tableAddresses(table).map((r) => r[0])).toEqual(['B5', null, null, null, 'B6', 'B7']);
    expect(tableUnitBounds(table).rows).toBe(2 + 1 + 3);
    // The rows keep their data and depth; only presence changes (HIER-10).
    expect(rowDepths(gd, tableId)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(setRowCollapsed(gd, tableId, rows[0] ?? '', false)).toBe(false);
    expect(rows.map((r) => cellAddress(table, r, c0))).toEqual([
      'B5',
      'B6',
      'B7',
      'B8',
      'B9',
      'B10',
    ]);
  });

  test('HIER-06 a collapsed grandchild stays hidden while its parent is collapsed, and reappears in its own state', () => {
    const gd = fresh();
    const { tableId, rows, table } = outlineFixture(gd);
    setRowCollapsed(gd, tableId, rows[1] ?? '', true); // r1 hides r2
    expect(tableOutline(table).rows.map((r) => r.hidden)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    setRowCollapsed(gd, tableId, rows[0] ?? '', true);
    expect(tableOutline(table).rows.map((r) => r.hidden)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    setRowCollapsed(gd, tableId, rows[0] ?? '', false);
    expect(tableOutline(table).rows.map((r) => r.hidden)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  test('HIER-06 a childless row cannot collapse; toggle flips; collapse all and expand all act on the whole table in one undo step each', () => {
    const gd = fresh();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const { tableId, rows, table } = outlineFixture(gd);
    undo.clear();
    expect(setRowCollapsed(gd, tableId, rows[4] ?? '', true)).toBeNull();
    expect(undo.undoStack).toHaveLength(0);
    expect(toggleRowCollapsed(gd, tableId, rows[1] ?? '')).toBe(true);
    expect(toggleRowCollapsed(gd, tableId, rows[1] ?? '')).toBe(false);
    expect(collapseAll(gd, tableId)).toEqual([rows[0], rows[1]]);
    expect(tableOutline(table).rows.map((r) => r.collapsed)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(undo.undoStack).toHaveLength(3);
    expect(expandAll(gd, tableId)).toEqual([rows[0], rows[1]]);
    expect(tableOutline(table).rows.map((r) => r.collapsed)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(undo.undoStack).toHaveLength(4);
    undo.undo();
    expect(tableOutline(table).rows.map((r) => r.collapsed)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(collapseAll(gd, tableId)).toEqual([]); // nothing left to collapse: no step
    expect(undo.undoStack).toHaveLength(3);
  });

  test('HIER-09 depth alone never moves an address; a hidden column and a collapsed row compose as GRID-02 says', () => {
    const gd = fresh();
    const { tableId, rows, cols, table } = outlineFixture(gd);
    const before = tableAddresses(table);
    expect(before.map((r) => r[1])).toEqual(['C5', 'C6', 'C7', 'C8', 'C9', 'C10']);
    hideColumn(gd, tableId, cols[0] ?? '');
    expect(tableAddresses(table).map((r) => r[1])).toEqual(['B5', 'B6', 'B7', 'B8', 'B9', 'B10']);
    setRowCollapsed(gd, tableId, rows[1] ?? '', true);
    expect(tableAddresses(table)).toEqual([
      [null, 'B5'],
      [null, 'B6'],
      [null, null],
      [null, 'B7'],
      [null, 'B8'],
      [null, 'B9'],
    ]);
  });
});

describe('a row that loses its last child (HIER-06)', () => {
  test('HIER-06 promoting, deleting or inserting under a collapsed parent that leaves it childless clears its collapsed flag in the same step', () => {
    const gd = fresh();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const { tableId, rows, table } = seed(gd);
    const [r0, r1, r2] = rows;
    nestRow(gd, tableId, r1 ?? '');
    setRowCollapsed(gd, tableId, r0 ?? '', true);
    undo.clear();
    // Promote the only child: the parent is childless and no longer collapsed — one undo step.
    expect(promoteRow(gd, tableId, r1 ?? '')).toBe(0);
    expect(rowMeta(table, r0 ?? '').collapsed).toBe(false);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(rowMeta(table, r0 ?? '').collapsed).toBe(true);
    expect(rowDepths(gd, tableId)[1]).toBe(1);
    // Delete the only child.
    deleteRow(gd, tableId, r1 ?? '');
    expect(rowMeta(table, r0 ?? '').collapsed).toBe(false);
    // Insert a top-level row directly under a collapsed parent: the subtree now belongs to the
    // new row and the old parent is childless.
    nestRow(gd, tableId, r2 ?? '');
    setRowCollapsed(gd, tableId, r0 ?? '', true);
    const inserted = addRow(gd, tableId, r0 ?? '');
    expect(rowDepths(gd, tableId).slice(0, 3)).toEqual([0, 0, 1]);
    expect(rowMeta(table, r0 ?? '').collapsed).toBe(false);
    expect(rowOutline(table, r2 ?? '')?.parent).toBe(inserted);
    // A parent that keeps a child keeps its flag.
    setRowCollapsed(gd, tableId, inserted, true);
    addRow(gd, tableId);
    expect(rowMeta(table, inserted).collapsed).toBe(true);
  });
});

describe('split children', () => {
  test('HIER-07 (partial: Split() in formulas) rows marked as split children sit one under their parent, are read-only for that reason, and collapse with the parent', () => {
    const gd = fresh();
    const { tableId, rows, cols, table } = seed(gd);
    const [r0, r1, r2] = rows;
    nestRow(gd, tableId, r1 ?? ''); // the parent itself sits at depth 1 under r0
    expect(markSplitChildren(gd, tableId, r1 ?? '', [r2 ?? ''])).toBe(true);
    expect(rowMeta(table, r2 ?? '')).toMatchObject({ depth: 2, splitChild: true });
    expect(cellReadOnlyReason(table, r2 ?? '', cols[0] ?? '')).toBe('splitChild');
    expect(cellReadOnlyReason(table, r1 ?? '', cols[0] ?? '')).toBeNull();
    expect(rowOutline(table, r2 ?? '')).toMatchObject({ parent: r1, splitChild: true });
    setRowCollapsed(gd, tableId, r1 ?? '', true);
    expect(rowOutline(table, r2 ?? '')?.hidden).toBe(true);
    setRowCollapsed(gd, tableId, r0 ?? '', true);
    expect(rowOutline(table, r2 ?? '')?.hidden).toBe(true);
    clearSplitChildren(gd, tableId, [r2 ?? '']);
    expect(cellReadOnlyReason(table, r2 ?? '', cols[0] ?? '')).toBeNull();
    expect(markSplitChildren(gd, tableId, 'gone', [r2 ?? ''])).toBe(false);
  });
});

describe('outline column and grouping (HIER-04, HIER-08)', () => {
  test('HIER-04 the outline column is the designated one when visible, else the first visible column', () => {
    const gd = fresh();
    const { tableId, cols, table } = seed(gd);
    expect(tableOutline(table).column).toBe(cols[0]);
    expect(setOutlineColumn(gd, tableId, cols[1] ?? '')).toBe(true);
    expect(tableOutline(table).column).toBe(cols[1]);
    hideColumn(gd, tableId, cols[1] ?? '');
    expect(tableOutline(table).column).toBe(cols[0]);
    expect(setOutlineColumn(gd, tableId, 'nope')).toBe(false);
    expect(setOutlineColumn(gd, tableId, null)).toBe(true);
    expect(tableById(gd, tableId)?.outlineColumn).toBeNull();
  });

  test('HIER-08 grouping is the viewer’s, not the document’s: a stray `groupBy` key changes nothing here and depth is preserved in the data', () => {
    const gd = fresh();
    const { tableId, rows, cols, table } = outlineFixture(gd);
    const before = tableOutline(table);
    // A key an older build stored: the record and the outline ignore it.
    gd.doc.transact(() => {
      table.set('groupBy', cols[1]);
    }, gd.origin);
    expect(tableById(gd, tableId)).not.toHaveProperty('groupBy');
    expect(tableOutline(table)).toEqual(before);
    expect(rowDepths(gd, tableId)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(nestRow(gd, tableId, rows[4] ?? '')).toBe(1); // the data still takes depth
    expect(rowDepths(gd, tableId)).toEqual([0, 1, 2, 1, 1, 0]);
  });
});

describe('the outline column of a row (ADR-051; HIER-04, HIER-05, HIER-09, HIER-10)', () => {
  test('HIER-04 HIER-10 a nest names the column its outline is drawn in, stored per row; the subtree keeps its own; a promote keeps it until the row reaches the top level, which clears it', () => {
    const gd = fresh();
    const s = seed(gd);
    const [r0, r1, r2] = s.rows;
    const [colA, colB] = s.cols;
    if (r0 === undefined || r1 === undefined || r2 === undefined) throw new Error('rows');
    if (colA === undefined || colB === undefined) throw new Error('cols');
    // Nothing named: the table's outline column (A) draws every row, and nothing is stored.
    expect(nestRow(gd, s.tableId, r1)).toBe(1);
    expect(rowMeta(s.table, r1).outlineColumn).toBeNull();
    expect(rowOutline(s.table, r1)?.column).toBe(colA);
    // From column B: r2 draws in B, r1 stays in A, the table default is untouched.
    expect(nestRow(gd, s.tableId, r2, colB)).toBe(1);
    expect(rowMeta(s.table, r2).outlineColumn).toBe(colB);
    expect(rowOutline(s.table, r2)?.column).toBe(colB);
    expect(rowOutline(s.table, r1)?.column).toBe(colA);
    expect(tableOutline(s.table).column).toBe(colA);
    expect(tableById(gd, s.tableId)?.outlineColumn).toBeNull();
    // Nesting r2 again from A moves its outline to A; the depth is the same write.
    expect(nestRow(gd, s.tableId, r2, colA)).toBe(2);
    expect(rowOutline(s.table, r2)?.column).toBe(colA);
    expect(nestRow(gd, s.tableId, r2, colB)).toBeNull(); // HIER-02 refuses: nothing moves
    expect(rowOutline(s.table, r2)?.column).toBe(colA);
    // Promote from B does not move the outline (the nest chose it); the top level clears it.
    expect(promoteRow(gd, s.tableId, r2, colB)).toBe(1);
    expect(rowMeta(s.table, r2).outlineColumn).toBe(colA);
    expect(promoteRow(gd, s.tableId, r2)).toBe(0);
    expect(rowMeta(s.table, r2).outlineColumn).toBeNull();
    expect(rowOutline(s.table, r2)?.column).toBe(colA);
  });

  test('HIER-04 HIER-05 the subtree keeps its own columns: nesting a parent from B leaves its children where they were, and the chevron follows the parent’s column', () => {
    const gd = fresh();
    const s = outlineFixture(gd); // r0 > r1 > r2, r0 > r3
    const [, r1, r2, r3] = s.rows;
    const [colA, colB] = s.cols;
    if (r1 === undefined || r2 === undefined || r3 === undefined) throw new Error('rows');
    if (colA === undefined || colB === undefined) throw new Error('cols');
    promoteRow(gd, s.tableId, r1); // r1 to 0 with r2; r3 stays at 1 under r1
    expect(rowDepths(gd, s.tableId)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(nestRow(gd, s.tableId, r1, colB)).toBe(1);
    expect(rowDepths(gd, s.tableId)).toEqual([0, 1, 2, 2, 0, 0]);
    const outline = tableOutline(s.table);
    expect(outline.rows.map((r) => r.column)).toEqual([colA, colB, colA, colA, colA, colA]);
    expect(outline.rows[1]).toMatchObject({ hasChildren: true, column: colB });
    expect(rowMeta(s.table, r2).outlineColumn).toBeNull();
  });

  test('HIER-04 an unknown or hidden column is ignored — the nest still happens where the row was — and a column hidden or deleted later falls back to the table’s outline column without rewriting the row', () => {
    const gd = fresh();
    const s = seed(gd);
    const [, r1, r2] = s.rows;
    const [colA, colB] = s.cols;
    if (r1 === undefined || r2 === undefined || colA === undefined || colB === undefined)
      throw new Error('fixture');
    expect(nestRow(gd, s.tableId, r1, 'not-a-column')).toBe(1);
    expect(rowMeta(s.table, r1).outlineColumn).toBeNull();
    hideColumn(gd, s.tableId, colB);
    expect(nestRow(gd, s.tableId, r2, colB)).toBe(1);
    expect(rowMeta(s.table, r2).outlineColumn).toBeNull();
    expect(rowOutline(s.table, r2)?.column).toBe(colA);
    unhideColumn(gd, s.tableId, colB);
    expect(nestRow(gd, s.tableId, r2, colB)).toBe(2);
    expect(rowOutline(s.table, r2)?.column).toBe(colB);
    // Hidden again: the stored column stays (the row remembers), the outline falls back.
    hideColumn(gd, s.tableId, colB);
    expect(rowMeta(s.table, r2).outlineColumn).toBe(colB);
    expect(rowOutline(s.table, r2)?.column).toBe(colA);
    unhideColumn(gd, s.tableId, colB);
    expect(rowOutline(s.table, r2)?.column).toBe(colB);
    deleteColumn(gd, s.tableId, colB);
    expect(rowOutline(s.table, r2)?.column).toBe(colA);
    expect(rowOutline(s.table, r2)?.depth).toBe(2);
  });

  test('HIER-09 the column a row’s outline is drawn in moves no address: B and C read the same before and after', () => {
    const gd = fresh();
    const s = seed(gd);
    const before = tableAddresses(s.table);
    nestRow(gd, s.tableId, s.rows[1] ?? '', s.cols[1]);
    nestRow(gd, s.tableId, s.rows[2] ?? '', s.cols[1]);
    nestRow(gd, s.tableId, s.rows[2] ?? '', s.cols[0]);
    expect(tableAddresses(s.table)).toEqual(before);
    expect(cellAddress(s.table, s.rows[2] ?? '', s.cols[1] ?? '')).toBe('C7');
  });

  test('HIER-01 (partial: the write) KEYS-03 KEYS-06 a nest from another column is one undo step: depth and column go back together', () => {
    const gd = fresh();
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const s = seed(gd);
    undo.clear();
    expect(nestRow(gd, s.tableId, s.rows[1] ?? '', s.cols[1])).toBe(1);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(rowMeta(s.table, s.rows[1] ?? '')).toMatchObject({ depth: 0, outlineColumn: null });
    undo.redo();
    expect(rowMeta(s.table, s.rows[1] ?? '')).toMatchObject({
      depth: 1,
      outlineColumn: s.cols[1],
    });
  });

  test('HIER-10 the outline column written on one replica reads the same on the other', () => {
    const { a, b } = pair();
    const { tableId, rows, cols } = seed(a);
    nestRow(a, tableId, rows[1] ?? '', cols[1]);
    const tb = tableMap(b, tableId);
    if (tb === null) throw new Error('table');
    expect(rowMeta(tb, rows[1] ?? '')).toMatchObject({ depth: 1, outlineColumn: cols[1] });
    expect(rowOutline(tb, rows[1] ?? '')?.column).toBe(cols[1]);
    promoteRow(b, tableId, rows[1] ?? '');
    const ta = tableMap(a, tableId);
    if (ta === null) throw new Error('table');
    expect(rowMeta(ta, rows[1] ?? '')).toMatchObject({ depth: 0, outlineColumn: null });
  });
});

describe('two replicas (HIER-10, SHARE)', () => {
  test('HIER-10 depth and collapse written on one replica read the same on the other, addresses included', () => {
    const { a, b } = pair();
    const { tableId, rows, cols } = seed(a);
    nestRow(a, tableId, rows[1] ?? '');
    nestRow(a, tableId, rows[2] ?? '');
    setRowCollapsed(b, tableId, rows[0] ?? '', true);
    const ta = tableMap(a, tableId);
    const tb = tableMap(b, tableId);
    if (ta === null || tb === null) throw new Error('tables');
    expect(rowDepths(b, tableId)).toEqual([0, 1, 1, 0, 0, 0]);
    expect(rowMeta(ta, rows[0] ?? '').collapsed).toBe(true);
    expect(tableAddresses(ta)).toEqual(tableAddresses(tb));
    expect(cellAddress(ta, rows[3] ?? '', cols[0] ?? '')).toBe('B6');
  });

  test('HIER-10 GRID-09 two replicas that first write different keys of the same row while apart keep both writes: the meta map is born with the row', () => {
    const a = fresh();
    const b = fresh();
    const { tableId, rows } = seed(a);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    // A row added after the fork on A, synced, then written on both sides.
    const added = addRow(a, tableId);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
    for (const rowId of [rows[1] ?? '', added]) {
      nestRow(a, tableId, rowId); // A: depth
      setRowHeight(b, tableId, rowId, 2); // B: height
    }
    const fromA = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
    const fromB = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    Y.applyUpdate(a.doc, fromB);
    Y.applyUpdate(b.doc, fromA);
    const ta = tableMap(a, tableId);
    const tb = tableMap(b, tableId);
    if (ta === null || tb === null) throw new Error('tables');
    for (const rowId of [rows[1] ?? '', added]) {
      expect(rowMeta(ta, rowId)).toMatchObject({ depth: 1, height: 2 });
      expect(rowMeta(tb, rowId)).toMatchObject({ depth: 1, height: 2 });
    }
    expect(tableAddresses(ta)).toEqual(tableAddresses(tb));
  });

  test('HIER-02 HIER-10 concurrent nests on two replicas converge; the effective outline is valid on both even when the stored depths are not', () => {
    const a = fresh();
    const b = fresh();
    const { tableId, rows } = seed(a);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    // Offline: A nests r1 under r0; B nests r2 under r1 twice (needs r1 at 1 — B does that too), then B promotes r1.
    nestRow(a, tableId, rows[1] ?? '');
    nestRow(b, tableId, rows[1] ?? '');
    nestRow(b, tableId, rows[2] ?? '');
    nestRow(b, tableId, rows[2] ?? '');
    promoteRow(b, tableId, rows[1] ?? ''); // r1 back to 0, r2 to 1 on B
    // Exchange.
    const fromA = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
    const fromB = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    Y.applyUpdate(a.doc, fromB);
    Y.applyUpdate(b.doc, fromA);
    expect(rowDepths(a, tableId)).toEqual(rowDepths(b, tableId));
    const ta = tableMap(a, tableId);
    const tb = tableMap(b, tableId);
    if (ta === null || tb === null) throw new Error('tables');
    const depthsA = tableOutline(ta).rows.map((r) => r.depth);
    expect(depthsA).toEqual(tableOutline(tb).rows.map((r) => r.depth));
    expect(isValidDepths(depthsA)).toBe(true);
    expect(tableAddresses(ta)).toEqual(tableAddresses(tb));
  });
});
