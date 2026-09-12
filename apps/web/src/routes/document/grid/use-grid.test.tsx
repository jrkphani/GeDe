/**
 * `useGrid` against two live replicas: what a collaborator does to the
 * structure under the local selection, and undo granularity with the real
 * undo manager (its production capture timeout, not the tests' 0).
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addDerivedColumn,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  deleteColumn,
  deleteRow,
  deleteTable,
  hideColumn,
  nestRow,
  openDocument,
  orphanCellKeys,
  rowHeights,
  setCellText,
  setRowCollapsed,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { useGrid } from './use-grid.js';

/** Two replicas that exchange every update, as the sync service would relay them. */
function pair(): { a: GedeDoc; b: GedeDoc } {
  const a = openDocument(new Y.Doc());
  const b = openDocument(new Y.Doc());
  a.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(b.doc, update, 'relay');
  });
  b.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(a.doc, update, 'relay');
  });
  return { a, b };
}

let a: GedeDoc;
let b: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];

beforeEach(() => {
  ({ a, b } = pair());
  const sheet = createSheet(a);
  tableId = createTable(a, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 3, rows: 3 });
  const rec = tableById(a, tableId)!;
  rows = rec.rows;
  cols = rec.columns.map((c) => c.id);
});

describe('remote structure under the selection (GRID-02, GRID-03, GRID-05, SHARE-04)', () => {
  it('GRID-02 GRID-05 a collaborator deleting the selected row hands the selection to the row that took its place', () => {
    const { result } = renderHook(() => useGrid(a, true));
    act(() => {
      result.current.actions.selectCell({ tableId, rowId: rows[1]!, colId: cols[1]! });
    });
    act(() => {
      deleteRow(b, tableId, rows[1]!);
    });
    expect(result.current.cell).toEqual({ tableId, rowId: rows[2], colId: cols[1] });
    // The last row going hands it to the one above.
    act(() => {
      deleteRow(b, tableId, rows[2]!);
    });
    expect(result.current.cell).toEqual({ tableId, rowId: rows[0], colId: cols[1] });
    // Every row gone: the table stays selected, no cell.
    act(() => {
      deleteRow(b, tableId, rows[0]!);
    });
    expect(result.current.state.selection).toEqual({ tableId, cell: null });
  });

  it('GRID-02 a collaborator hiding or deleting the selected column moves the selection to the next visible column', () => {
    const { result } = renderHook(() => useGrid(a, true));
    act(() => {
      result.current.actions.selectCell({ tableId, rowId: rows[0]!, colId: cols[0]! });
    });
    act(() => {
      hideColumn(b, tableId, cols[0]!);
    });
    expect(result.current.cell).toEqual({ tableId, rowId: rows[0], colId: cols[1] });
    act(() => {
      deleteColumn(b, tableId, cols[1]!);
    });
    expect(result.current.cell).toEqual({ tableId, rowId: rows[0], colId: cols[2] });
    // Nothing visible after it: the one before.
    act(() => {
      deleteColumn(b, tableId, cols[2]!);
    });
    expect(result.current.state.selection).toEqual({ tableId, cell: null }); // only a hidden column remains
  });

  it('HIER-06 HIER-10 a collaborator collapsing the parent of the selected row moves the selection off the hidden subtree; traversal skips it', () => {
    nestRow(a, tableId, rows[1]!);
    nestRow(a, tableId, rows[2]!);
    const { result } = renderHook(() => useGrid(a, true));
    act(() => {
      result.current.actions.selectCell({ tableId, rowId: rows[2]!, colId: cols[1]! });
    });
    act(() => {
      setRowCollapsed(b, tableId, rows[0]!, true);
    });
    // The hidden row's nearest drawn ancestor takes the selection: r0, the row that collapsed.
    expect(result.current.cell).toEqual({ tableId, rowId: rows[0], colId: cols[1] });
    // Down from the last drawn row appends a row (GRID-05) rather than entering the hidden subtree.
    act(() => {
      result.current.actions.move('down');
    });
    const after = tableById(a, tableId)!.rows;
    expect(after).toHaveLength(4);
    expect(result.current.cell?.rowId).toBe(after[3]);
    // An edit in flight on a row that gets hidden is dropped the same way a deleted row's is.
    act(() => {
      setRowCollapsed(b, tableId, rows[0]!, false);
      result.current.actions.selectCell({ tableId, rowId: rows[1]!, colId: cols[0]! });
      result.current.actions.dispatch({ type: 'edit', seed: { kind: 'overwrite', text: 'd' } });
    });
    expect(result.current.state.editing).not.toBeNull();
    act(() => {
      setRowCollapsed(b, tableId, rows[0]!, true);
    });
    expect(result.current.state.editing).toBeNull();
    expect(result.current.cell?.rowId).toBe(rows[0]);
  });

  it('GRID-03 a collaborator deleting the selected table clears the selection; an edit in flight is dropped, not written', () => {
    const { result } = renderHook(() => useGrid(a, true));
    act(() => {
      result.current.actions.selectCell({ tableId, rowId: rows[0]!, colId: cols[0]! });
      result.current.actions.dispatch({ type: 'edit', seed: { kind: 'overwrite', text: 'd' } });
    });
    expect(result.current.state.editing).not.toBeNull();
    act(() => {
      deleteRow(b, tableId, rows[0]!);
    });
    expect(result.current.state.editing).toBeNull();
    // The editor's unmount commit arrives late, aimed at the vanished row: refused, no orphan.
    act(() => {
      result.current.actions.commit({ tableId, rowId: rows[0]!, colId: cols[0]! }, 'draft', null);
    });
    expect(orphanCellKeys(tableMap(a, tableId)!)).toEqual([]);
    expect(JSON.stringify(a.tables.toJSON())).not.toContain('draft');
    act(() => {
      deleteTable(b, tableId);
    });
    expect(result.current.state).toEqual({ selection: null, editing: null });
  });

  it('GRID-02 LOAD-06 an orphan cell left by a merged delete‖write is swept when the delete is observed', () => {
    renderHook(() => useGrid(a, true));
    // Diverge: B goes offline (stop relaying), A writes into r2, B deletes r2, then B's delete lands on A.
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(b.doc));
    const c = openDocument(offline);
    setCellText(a, tableId, rows[1]!, cols[0]!, 'written while c was away');
    deleteRow(c, tableId, rows[1]!);
    act(() => {
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(a.doc)), 'relay');
    });
    expect(tableById(a, tableId)?.rows).not.toContain(rows[1]);
    expect(orphanCellKeys(tableMap(a, tableId)!)).toEqual([]);
    expect(cellText(tableMap(a, tableId)!, rows[1]!, cols[0]!)).toBe('');
  });
});

describe('undo granularity (KEYS-03)', () => {
  it('KEYS-03 GRID-06 with the production capture timeout, a commit and the row it appended are two undo steps, and two divider presses are two', () => {
    const undo = createUndoManager(a); // default 500 ms capture timeout
    const { result } = renderHook(() => useGrid(a, true, { undo }));
    act(() => {
      result.current.actions.selectCell({ tableId, rowId: rows[2]!, colId: cols[0]! });
      result.current.actions.dispatch({ type: 'edit', seed: { kind: 'overwrite', text: 'z' } });
    });
    act(() => {
      // Enter past the last row: commit, then append.
      result.current.actions.commit({ tableId, rowId: rows[2]!, colId: cols[0]! }, 'z', 'down');
    });
    expect(tableById(a, tableId)?.rows).toHaveLength(4);
    expect(undo.undoStack).toHaveLength(2);
    act(() => {
      undo.undo();
    });
    expect(tableById(a, tableId)?.rows).toHaveLength(3);
    expect(cellText(tableMap(a, tableId)!, rows[2]!, cols[0]!)).toBe('z');
    act(() => {
      undo.undo();
    });
    expect(cellText(tableMap(a, tableId)!, rows[2]!, cols[0]!)).toBe('');
    act(() => {
      result.current.commands.setColumnWidth(tableId, cols[0]!, 2);
      result.current.commands.setColumnWidth(tableId, cols[0]!, 3);
    });
    expect(undo.undoStack).toHaveLength(2);
    act(() => {
      undo.undo();
    });
    expect(tableById(a, tableId)?.columns[0]?.width).toBe(2);
  });
});

describe('the formula expression line (FX-07, REF-01; ADR 39)', () => {
  it('FX-07 GRID-09 committing a formula into a compact row wraps the row in the same undo step; a text commit leaves the height alone and never unwraps (#142, ADR 39)', () => {
    const undo = createUndoManager(a, { captureTimeout: 0 });
    const { result } = renderHook(() => useGrid(a, true, { undo }));
    const table = tableMap(a, tableId)!;
    expect(rowHeights(table)).toEqual([1, 1, 1]);
    act(() => {
      result.current.commands.commitCell({ tableId, rowId: rows[1]!, colId: cols[0]! }, '=Sum(A1)');
    });
    expect(rowHeights(table)).toEqual([1, 2, 1]);
    expect(undo.undoStack).toHaveLength(1);
    act(() => {
      undo.undo();
    });
    expect(rowHeights(table)).toEqual([1, 1, 1]);
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('');
    act(() => {
      undo.redo();
      result.current.commands.commitCell({ tableId, rowId: rows[1]!, colId: cols[0]! }, 'text');
    });
    // The row keeps the height the commit gave it: a commit never unwraps.
    expect(rowHeights(table)).toEqual([1, 2, 1]);
    act(() => {
      result.current.commands.commitCell({ tableId, rowId: rows[0]!, colId: cols[1]! }, 'plain');
    });
    expect(rowHeights(table)).toEqual([1, 2, 1]);
  });
});

describe('column rename and derived lineage (REF-04)', () => {
  it('REF-04 renaming a source column re-spells the derived columns that name it, as one undo step; a derived column refuses', () => {
    const undo = createUndoManager(a, { captureTimeout: 0 });
    const { result } = renderHook(() => useGrid(a, true, { undo }));
    const derived = addDerivedColumn(a, tableId, {
      sourceColId: cols[0]!,
      method: 'Format',
      args: ['UPPERCASE'],
    })!;
    expect(tableById(a, tableId)?.columns[1]?.label).toBe('@"Column 1".Format("UPPERCASE")');
    let ok = false;
    act(() => {
      ok = result.current.commands.renameColumn(tableId, cols[0]!, 'Site');
    });
    expect(ok).toBe(true);
    const after = tableById(a, tableId)!;
    expect(after.columns[0]?.label).toBe('Site');
    expect(after.columns[1]?.label).toBe('@Site.Format("UPPERCASE")');
    // Both replicas see the same labels; one undo step restores both.
    expect(tableById(b, tableId)?.columns[1]?.label).toBe('@Site.Format("UPPERCASE")');
    act(() => {
      undo.undo();
    });
    expect(tableById(a, tableId)?.columns[0]?.label).toBe('Column 1');
    expect(tableById(a, tableId)?.columns[1]?.label).toBe('@"Column 1".Format("UPPERCASE")');
    act(() => {
      ok = result.current.commands.renameColumn(tableId, derived, 'Shout');
    });
    expect(ok).toBe(false);
    expect(tableById(a, tableId)?.columns[1]?.label).toBe('@"Column 1".Format("UPPERCASE")');
  });

  it('REF-04 deleting the source column leaves the derived column naming #REF', () => {
    const { result } = renderHook(() => useGrid(a, true));
    addDerivedColumn(a, tableId, { sourceColId: cols[0]!, method: 'Format', args: ['Trimmed'] });
    act(() => {
      result.current.commands.deleteColumn(tableId, cols[0]!);
    });
    expect(tableById(a, tableId)?.columns[0]?.label).toBe('@#REF.Format("Trimmed")');
  });
});
