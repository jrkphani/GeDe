import { describe, expect, it } from 'vitest';

import {
  IDLE,
  nextCell,
  reduce,
  sameCell,
  selectedCell,
  type CellSelection,
  type GridEvent,
  type GridState,
  type TraversalTable,
} from './selection.js';

const T: TraversalTable = {
  rows: ['r1', 'r2', 'r3'],
  columns: [
    { id: 'a', hidden: false },
    { id: 'b', hidden: true },
    { id: 'c', hidden: false },
  ],
};
const lookup = (id: string) => (id === 't' ? T : null);
const cell = (rowId: string, colId: string): CellSelection => ({ tableId: 't', rowId, colId });
const step = (state: GridState, ...events: GridEvent[]) =>
  events.reduce(
    (acc, e) => {
      const t = reduce(acc.state, e, lookup);
      return { state: t.state, effect: t.effect ?? acc.effect };
    },
    { state, effect: null as ReturnType<typeof reduce>['effect'] },
  );

describe('nextCell', () => {
  it('GRID-05 right and left wrap at row ends, skipping hidden columns', () => {
    expect(nextCell(T, { rowId: 'r1', colId: 'a' }, 'right')).toEqual({
      kind: 'cell',
      rowId: 'r1',
      colId: 'c',
    });
    expect(nextCell(T, { rowId: 'r1', colId: 'c' }, 'right')).toEqual({
      kind: 'cell',
      rowId: 'r2',
      colId: 'a',
    });
    expect(nextCell(T, { rowId: 'r2', colId: 'a' }, 'left')).toEqual({
      kind: 'cell',
      rowId: 'r1',
      colId: 'c',
    });
    expect(nextCell(T, { rowId: 'r1', colId: 'a' }, 'left')).toEqual({ kind: 'stay' });
  });

  it('GRID-05 up stops at the first row; down and right past the last cell ask for a new row', () => {
    expect(nextCell(T, { rowId: 'r1', colId: 'c' }, 'up')).toEqual({ kind: 'stay' });
    expect(nextCell(T, { rowId: 'r2', colId: 'c' }, 'up')).toEqual({
      kind: 'cell',
      rowId: 'r1',
      colId: 'c',
    });
    expect(nextCell(T, { rowId: 'r2', colId: 'c' }, 'down')).toEqual({
      kind: 'cell',
      rowId: 'r3',
      colId: 'c',
    });
    expect(nextCell(T, { rowId: 'r3', colId: 'a' }, 'down')).toEqual({ kind: 'append-row' });
    expect(nextCell(T, { rowId: 'r3', colId: 'c' }, 'right')).toEqual({ kind: 'append-row' });
    expect(nextCell(T, { rowId: 'r3', colId: 'a' }, 'right')).toEqual({
      kind: 'cell',
      rowId: 'r3',
      colId: 'c',
    });
  });

  it('GRID-05 an unknown cell, a hidden column or a table with no visible column stays put', () => {
    expect(nextCell(T, { rowId: 'zz', colId: 'a' }, 'down')).toEqual({ kind: 'stay' });
    expect(nextCell(T, { rowId: 'r1', colId: 'b' }, 'right')).toEqual({ kind: 'stay' });
    expect(
      nextCell(
        { rows: ['r1'], columns: [{ id: 'a', hidden: true }] },
        { rowId: 'r1', colId: 'a' },
        'right',
      ),
    ).toEqual({ kind: 'stay' });
  });
});

describe('reduce', () => {
  it('GRID-03 select arms a cell; Escape (clear) empties the selection; selectTable keeps the table only', () => {
    const armed = reduce(IDLE, { type: 'select', cell: cell('r1', 'a') }, lookup).state;
    expect(armed).toEqual({
      selection: { tableId: 't', cell: { rowId: 'r1', colId: 'a' } },
      editing: null,
    });
    expect(selectedCell(armed.selection)).toEqual(cell('r1', 'a'));
    expect(reduce(armed, { type: 'clear' }, lookup).state).toBe(IDLE);
    expect(reduce(armed, { type: 'selectTable', tableId: 't' }, lookup).state).toEqual({
      selection: { tableId: 't', cell: null },
      editing: null,
    });
  });

  it('GRID-04 edit opens on the selected cell with its seed; cancel closes it and keeps the selection', () => {
    const { state } = step(
      IDLE,
      { type: 'select', cell: cell('r1', 'a') },
      { type: 'edit', seed: { kind: 'existing' } },
    );
    expect(state.editing).toEqual({ cell: cell('r1', 'a'), seed: { kind: 'existing' } });
    const typed = reduce(
      state,
      { type: 'edit', seed: { kind: 'overwrite', text: 'K' } },
      lookup,
    ).state;
    expect(typed.editing?.seed).toEqual({ kind: 'overwrite', text: 'K' });
    const cancelled = reduce(typed, { type: 'cancel' }, lookup).state;
    expect(cancelled.editing).toBeNull();
    expect(selectedCell(cancelled.selection)).toEqual(cell('r1', 'a'));
    // Nothing selected: edit is a no-op rather than an error.
    expect(reduce(IDLE, { type: 'edit', seed: { kind: 'existing' } }, lookup).state).toBe(IDLE);
    // A double-click on an unselected cell arms and edits it in one step.
    const direct = reduce(
      IDLE,
      { type: 'edit', seed: { kind: 'existing' }, cell: cell('r2', 'c') },
      lookup,
    ).state;
    expect(selectedCell(direct.selection)).toEqual(cell('r2', 'c'));
    expect(direct.editing?.cell).toEqual(cell('r2', 'c'));
  });

  it('GRID-06 committed with a direction closes the editor and moves; blur (null) stays put', () => {
    const editing = step(
      IDLE,
      { type: 'select', cell: cell('r1', 'a') },
      { type: 'edit', seed: { kind: 'existing' } },
    ).state;
    const down = reduce(editing, { type: 'committed', then: 'down' }, lookup);
    expect(down.state.editing).toBeNull();
    expect(selectedCell(down.state.selection)).toEqual(cell('r2', 'a'));
    const right = reduce(editing, { type: 'committed', then: 'right' }, lookup);
    expect(selectedCell(right.state.selection)).toEqual(cell('r1', 'c'));
    const blur = reduce(editing, { type: 'committed', then: null }, lookup);
    expect(blur.state).toEqual({ selection: editing.selection, editing: null });
  });

  it('GRID-05 moving past the final row is an append-row effect, not a state change', () => {
    const last = reduce(IDLE, { type: 'select', cell: cell('r3', 'c') }, lookup).state;
    const t = reduce(last, { type: 'move', direction: 'down' }, lookup);
    expect(t.effect).toEqual({ kind: 'append-row', tableId: 't', direction: 'down' });
    expect(t.state).toEqual(last);
    const viaTab = reduce(
      { ...last, editing: { cell: cell('r3', 'c'), seed: { kind: 'existing' } } },
      { type: 'committed', then: 'right' },
      lookup,
    );
    expect(viaTab.effect).toEqual({ kind: 'append-row', tableId: 't', direction: 'right' });
    expect(viaTab.state.editing).toBeNull();
  });

  it('GRID-05 a move with nowhere to go, no selection, or a vanished table leaves the state alone', () => {
    const first = reduce(IDLE, { type: 'select', cell: cell('r1', 'a') }, lookup).state;
    expect(reduce(first, { type: 'move', direction: 'up' }, lookup).state).toEqual(first);
    expect(reduce(IDLE, { type: 'move', direction: 'down' }, lookup).state).toBe(IDLE);
    const gone = reduce(
      IDLE,
      { type: 'select', cell: { tableId: 'x', rowId: 'r', colId: 'c' } },
      lookup,
    ).state;
    expect(reduce(gone, { type: 'move', direction: 'down' }, lookup).state).toEqual(gone);
    expect(reduce(gone, { type: 'tableGone', tableId: 'x' }, lookup).state).toBe(IDLE);
    expect(reduce(first, { type: 'tableGone', tableId: 'x' }, lookup).state).toBe(first);
  });

  it('GRID-06 selecting another cell while editing ends the edit; re-selecting the same cell keeps it', () => {
    const editing = step(
      IDLE,
      { type: 'select', cell: cell('r1', 'a') },
      { type: 'edit', seed: { kind: 'existing' } },
    ).state;
    expect(reduce(editing, { type: 'select', cell: cell('r1', 'a') }, lookup).state).toEqual(
      editing,
    );
    const other = reduce(editing, { type: 'select', cell: cell('r2', 'a') }, lookup).state;
    expect(other.editing).toBeNull();
    expect(selectedCell(other.selection)).toEqual(cell('r2', 'a'));
  });

  it('sameCell compares by table, row and column and treats null as its own value', () => {
    expect(sameCell(cell('r1', 'a'), cell('r1', 'a'))).toBe(true);
    expect(sameCell(cell('r1', 'a'), cell('r1', 'c'))).toBe(false);
    expect(sameCell(null, null)).toBe(true);
    expect(sameCell(cell('r1', 'a'), null)).toBe(false);
  });
});
