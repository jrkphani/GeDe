/**
 * Selection, traversal and structure for one open document: the state machine
 * in `doc/selection.ts` wired to the Yjs document and the live region. The
 * shell holds one of these; `TableView`, the toolbar menu, the inspector and
 * context menus all act through `actions` and `commands`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  cellAddress,
  sweepOrphanCells,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { announce } from '../../../announce.js';
import {
  IDLE,
  reduce,
  selectedCell,
  type CellSelection,
  type Direction,
  type GridEvent,
  type GridState,
  type TraversalTable,
} from '../../../doc/selection.js';
import { createGridCommands, type GridCommands } from './commands.js';

/** Stable for the life of the document, so `TableView` stays memoised and handlers can be passed bare. */
export interface GridActions {
  readonly dispatch: (event: GridEvent) => void;
  readonly selectCell: (cell: CellSelection) => void;
  readonly selectTable: (tableId: Id) => void;
  readonly clear: () => void;
  /** GRID-06: write the editor's text, close it, then move (Enter down, Tab right, blur nowhere). */
  readonly commit: (cell: CellSelection, text: string, then: Direction | null) => void;
  readonly cancel: () => void;
  readonly move: (direction: Direction) => void;
}

export interface Grid {
  state: GridState;
  cell: CellSelection | null;
  actions: GridActions;
  commands: GridCommands;
}

export interface GridOptions {
  /**
   * The document's undo manager (KEYS-03). Every grid command ends by
   * `stopCapturing()` on it, so one user action is one undo step whatever the
   * manager's capture timeout merges for typing elsewhere.
   */
  undo?: Pick<Y.UndoManager, 'stopCapturing'> | undefined;
}

/** True when the event is a deletion from a table's `rows` or `columns` array. */
function isStructuralDelete(event: unknown): boolean {
  if (!(event instanceof Y.YArrayEvent)) return false;
  if (event.changes.deleted.size === 0) return false;
  const parent = event.target.parent;
  if (!(parent instanceof Y.Map)) return false;
  return parent.get('rows') === event.target || parent.get('columns') === event.target;
}

export function useGrid(gd: GedeDoc, editable: boolean, options: GridOptions = {}): Grid {
  const [state, setState] = useState<GridState>(IDLE);
  // Handlers read the latest state synchronously (commit then move in one keystroke).
  const stateRef = useRef(state);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const undoRef = useRef(options.undo);
  undoRef.current = options.undo;
  // The selected table as last seen, so a vanished row or column can hand the
  // selection to the neighbour that took its place.
  const snapshotRef = useRef<{ tableId: Id; table: TraversalTable } | null>(null);

  const lookup = useCallback(
    (tableId: Id): TraversalTable | null => {
      const record = tableById(gd, tableId);
      if (record === null) return null;
      return {
        rows: record.rows,
        columns: record.columns.map((c) => ({ id: c.id, hidden: c.hidden })),
      };
    },
    [gd],
  );

  const commandsRef = useRef<GridCommands | null>(null);

  const dispatch = useCallback(
    (event: GridEvent) => {
      const before = stateRef.current;
      const { state: next, effect } = reduce(before, event, lookup);
      if (next !== before) {
        stateRef.current = next;
        setState(next);
        announceSelection(gd, before, next);
        const tableId = next.selection?.tableId;
        const table = tableId === undefined ? null : lookup(tableId);
        snapshotRef.current = tableId === undefined || table === null ? null : { tableId, table };
      }
      if (effect?.kind === 'append-row' && editableRef.current) {
        // GRID-05: past the final row a new row appears and the cursor lands in it —
        // its first cell after a Tab, the same column after an arrow or Enter.
        const first =
          effect.direction === 'right'
            ? lookup(effect.tableId)?.columns.find((c) => !c.hidden)?.id
            : undefined;
        commandsRef.current?.insertRowBelow(effect.tableId, undefined, first);
      }
    },
    [gd, lookup],
  );

  const commands = useMemo(
    () =>
      createGridCommands({
        gd,
        editable: () => editableRef.current,
        state: () => stateRef.current,
        dispatch,
        announce,
        settle: () => undoRef.current?.stopCapturing(),
      }),
    [gd, dispatch],
  );
  commandsRef.current = commands;

  // Structure can change under the selection — a collaborator deletes or hides the
  // selected row or column, or the table itself (GRID-02, SHARE-04). Keep the
  // selection on something that renders, and sweep the orphan cells a merge can
  // leave behind a remote delete.
  useEffect(() => {
    const onChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      for (const event of events) {
        if (!isStructuralDelete(event)) continue;
        const table = event.target.parent as Y.Map<unknown>;
        const tableId = table.get('id');
        if (typeof tableId === 'string') sweepOrphanCells(gd, tableId);
      }
      reconcileSelection(stateRef.current, lookup, snapshotRef.current, dispatch);
    };
    gd.tables.observeDeep(onChange);
    return () => {
      gd.tables.unobserveDeep(onChange);
    };
  }, [gd, lookup, dispatch]);

  const actions = useMemo<GridActions>(
    () => ({
      dispatch,
      selectCell: (cell) => {
        dispatch({ type: 'select', cell });
      },
      selectTable: (tableId) => {
        dispatch({ type: 'selectTable', tableId });
      },
      clear: () => {
        dispatch({ type: 'clear' });
      },
      commit: (cell, text, then) => {
        commands.commitCell(cell, text);
        dispatch({ type: 'committed', then });
      },
      cancel: () => {
        dispatch({ type: 'cancel' });
      },
      move: (direction) => {
        dispatch({ type: 'move', direction });
      },
    }),
    [dispatch, commands],
  );

  return { state, cell: selectedCell(state.selection), actions, commands };
}

/**
 * After the document changed, move the selection off anything that no longer
 * renders: table gone → cleared; row gone → the row now at its index; column
 * gone or hidden → the visible column now at its place; nothing left → the table.
 */
function reconcileSelection(
  state: GridState,
  lookup: (tableId: Id) => TraversalTable | null,
  snapshot: { tableId: Id; table: TraversalTable } | null,
  dispatch: (event: GridEvent) => void,
): void {
  const selection = state.selection;
  if (selection === null) return;
  const now = lookup(selection.tableId);
  if (now === null) {
    dispatch({ type: 'tableGone', tableId: selection.tableId });
    return;
  }
  const cell = selection.cell;
  if (cell === null) return;
  const rowOk = now.rows.includes(cell.rowId);
  const column = now.columns.find((c) => c.id === cell.colId);
  const colOk = column !== undefined && !column.hidden;
  if (rowOk && colOk) return;
  const prev = snapshot?.tableId === selection.tableId ? snapshot.table : null;
  let rowId: Id | undefined = cell.rowId;
  if (!rowOk) {
    const was = prev?.rows.indexOf(cell.rowId) ?? -1;
    rowId = now.rows[Math.min(Math.max(was, 0), now.rows.length - 1)];
  }
  let colId: Id | undefined = cell.colId;
  if (!colOk) {
    const visible = now.columns.filter((c) => !c.hidden);
    const wasAt = prev?.columns.findIndex((c) => c.id === cell.colId) ?? -1;
    const before =
      prev === null || wasAt < 0 ? 0 : prev.columns.filter((c, i) => !c.hidden && i < wasAt).length;
    colId = visible[Math.min(before, visible.length - 1)]?.id;
  }
  if (rowId === undefined || colId === undefined) {
    dispatch({ type: 'selectTable', tableId: selection.tableId });
  } else {
    dispatch({ type: 'select', cell: { tableId: selection.tableId, rowId, colId } });
  }
}

/** A11Y-05: say what got selected, once per change. */
function announceSelection(gd: GedeDoc, before: GridState, after: GridState): void {
  const was = before.selection;
  const now = after.selection;
  if (now === null) {
    if (was !== null) announce('Selection cleared');
    return;
  }
  const title = tableById(gd, now.tableId)?.title ?? 'table';
  if (now.cell === null) {
    if (was?.tableId !== now.tableId || was.cell !== null) announce(`Selected ${title}`);
    return;
  }
  const same =
    was?.tableId === now.tableId &&
    was.cell?.rowId === now.cell.rowId &&
    was.cell.colId === now.cell.colId;
  if (same) return;
  const table = tableMap(gd, now.tableId);
  const address = table === null ? null : cellAddress(table, now.cell.rowId, now.cell.colId);
  announce(address === null ? `Selected a cell in ${title}` : `Selected ${address} in ${title}`);
}
