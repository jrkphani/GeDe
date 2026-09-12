/**
 * Selection, traversal and structure for one open document: the state machine
 * in `doc/selection.ts` wired to the Yjs document and the live region. The
 * shell holds one of these; `TableView`, the toolbar menu, the inspector and
 * context menus all act through `actions` and `commands`.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { cellAddress, tableById, tableMap, type GedeDoc, type Id } from '@gede/core';

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

export function useGrid(gd: GedeDoc, editable: boolean): Grid {
  const [state, setState] = useState<GridState>(IDLE);
  // Handlers read the latest state synchronously (commit then move in one keystroke).
  const stateRef = useRef(state);
  const editableRef = useRef(editable);
  editableRef.current = editable;

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
      }),
    [gd, dispatch],
  );
  commandsRef.current = commands;

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
