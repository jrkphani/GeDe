/**
 * Selection and traversal (GRID-03..06, KEYS-06): a pure state machine over
 * viewer state. Selection is never document state — it lives in React and is
 * mirrored into awareness so collaborators see it (SHARE-04).
 *
 * The machine knows nothing about the DOM or Yjs. Moving past the final row is
 * reported as an *effect* (`append-row`) for the caller to perform against the
 * document and then feed back as a `select`; everything else is a pure
 * transition. `reduce` is total: an event that makes no sense in the current
 * state returns the state unchanged.
 */
import type { Id } from '@gede/core';

export interface CellSelection {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
}

/**
 * A band of whole rows or whole columns (ADR-049, Numbers' row and column
 * selection): what a press on a row handle or a column header selects, and
 * what a divider drag, the Table tab's Height / Width fields and Distribute
 * evenly act on together. `ids` are in table order; `anchor` is where the
 * band began, so Shift extends from it.
 */
export interface AxisBand {
  readonly axis: 'row' | 'column';
  readonly ids: readonly Id[];
  readonly anchor: Id;
}

export interface Selection {
  readonly tableId: Id;
  /** The armed cell; with a band, its first cell (the band's anchor row or column). */
  readonly cell: Omit<CellSelection, 'tableId'> | null;
  /** The selected rows or columns, or null for a plain cell or table selection. */
  readonly band?: AxisBand | null;
}

/**
 * How an edit began (GRID-04): Enter or double-click opens the editor on the
 * cell's text with the caret at the end; a printable key overwrites, seeding
 * the editor with that character and nothing else.
 */
export type EditSeed =
  { readonly kind: 'existing' } | { readonly kind: 'overwrite'; readonly text: string };

export interface Editing {
  readonly cell: CellSelection;
  readonly seed: EditSeed;
}

export interface GridState {
  readonly selection: Selection | null;
  readonly editing: Editing | null;
}

export const IDLE: GridState = { selection: null, editing: null };

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * What the machine needs to know about a table to traverse it; hidden
 * columns are skipped, and so are the cells a merged span covers (MENU-04):
 * `covered` maps each covered cell's `rowId:colId` to its anchor's, and a
 * move that lands on one lands on the anchor instead — or, from the anchor
 * itself, carries on past its own span.
 */
export interface TraversalTable {
  readonly rows: readonly Id[];
  readonly columns: readonly { readonly id: Id; readonly hidden: boolean }[];
  readonly covered?: ReadonlyMap<string, string> | undefined;
}

export type MoveResult =
  | { readonly kind: 'cell'; readonly rowId: Id; readonly colId: Id }
  /** GRID-05: moved past the final row — the caller appends one and selects its first cell. */
  | { readonly kind: 'append-row' }
  /** Nowhere to go (up from the first row, left from the first cell): selection stays. */
  | { readonly kind: 'stay' };

export type GridEvent =
  | { readonly type: 'select'; readonly cell: CellSelection }
  | { readonly type: 'selectTable'; readonly tableId: Id }
  /**
   * ADR-049: select whole rows or columns. `extend` grows the current band of
   * the same axis (or starts one at the armed cell) to reach `id`, as a
   * Shift-press or a Shift-arrow does; otherwise the band is `id` alone.
   */
  | {
      readonly type: 'selectBand';
      readonly tableId: Id;
      readonly axis: 'row' | 'column';
      readonly id: Id;
      readonly extend?: boolean | undefined;
    }
  | { readonly type: 'clear' }
  /** Open the editor on the selected cell (or `cell` when given). */
  | { readonly type: 'edit'; readonly seed: EditSeed; readonly cell?: CellSelection | undefined }
  | { readonly type: 'cancel' }
  /** The editor's text was written; `then` is where the selection goes next (Enter down, Tab right, blur nowhere). */
  | { readonly type: 'committed'; readonly then: Direction | null }
  | { readonly type: 'move'; readonly direction: Direction }
  /** The table the selection lives in was removed. */
  | { readonly type: 'tableGone'; readonly tableId: Id };

export interface GridEffect {
  readonly kind: 'append-row';
  readonly tableId: Id;
  /** How the edge was crossed: `right` (Tab past the last cell) lands on the new row's first cell, `down` keeps the column. */
  readonly direction: 'right' | 'down';
}

export interface Transition {
  readonly state: GridState;
  readonly effect: GridEffect | null;
}

export function sameCell(a: CellSelection | null, b: CellSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tableId === b.tableId && a.rowId === b.rowId && a.colId === b.colId;
}

export function selectedCell(selection: Selection | null): CellSelection | null {
  const cell = selection?.cell;
  if (selection === null || cell === null || cell === undefined) return null;
  return { tableId: selection.tableId, ...cell };
}

/** The band in the selection, if it is on `tableId` and of `axis`. */
export function selectedBand(
  selection: Selection | null,
  tableId: Id,
  axis: 'row' | 'column',
): AxisBand | null {
  const band = selection?.band;
  if (selection === null || band === null || band === undefined) return null;
  return selection.tableId === tableId && band.axis === axis ? band : null;
}

/**
 * The ids a divider on `id` acts on (ADR-049, Numbers N2): every member of a
 * band that contains it, else itself alone.
 */
export function bandFor(band: AxisBand | null, id: Id): readonly Id[] {
  return band?.ids.includes(id) === true ? band.ids : [id];
}

/**
 * The contiguous run of `order` from `anchor` to `id`, in table order
 * (hidden columns already left out of `order` by the caller).
 */
export function bandRange(order: readonly Id[], anchor: Id, id: Id): Id[] {
  const a = order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a < 0 || b < 0) return b < 0 ? (a < 0 ? [] : [anchor]) : [id];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * The cell a move lands on (GRID-05). Right and left wrap at row ends — the
 * last visible column continues on the next row's first, and vice versa. Down
 * from the last row, or right from the last cell, asks for a new row.
 */
export function nextCell(
  table: TraversalTable,
  from: { readonly rowId: Id; readonly colId: Id },
  direction: Direction,
): MoveResult {
  const covered = table.covered;
  if (covered === undefined || covered.size === 0) return step(table, from, direction);
  // MENU-04: a covered landing resolves to its anchor; from the anchor itself the move
  // carries on past the span. Bounded by the table's cell count, so it always ends.
  const origin = `${from.rowId}:${from.colId}`;
  const anchorOfOrigin = covered.get(origin) ?? origin;
  let cursor = from;
  for (let guard = table.rows.length * table.columns.length + 1; guard > 0; guard -= 1) {
    const result = step(table, cursor, direction);
    if (result.kind !== 'cell') return result;
    const key = `${result.rowId}:${result.colId}`;
    const anchor = covered.get(key);
    if (anchor === undefined) return result;
    if (anchor !== anchorOfOrigin) {
      const [rowId, colId] = anchor.split(':');
      return rowId === undefined || colId === undefined ? result : { kind: 'cell', rowId, colId };
    }
    cursor = result;
  }
  return { kind: 'stay' };
}

function step(
  table: TraversalTable,
  from: { readonly rowId: Id; readonly colId: Id },
  direction: Direction,
): MoveResult {
  const visible = table.columns.filter((c) => !c.hidden).map((c) => c.id);
  const rowIndex = table.rows.indexOf(from.rowId);
  const colIndex = visible.indexOf(from.colId);
  if (rowIndex < 0 || colIndex < 0 || visible.length === 0) return { kind: 'stay' };
  const lastRow = table.rows.length - 1;
  const lastCol = visible.length - 1;
  const at = (r: number, c: number): MoveResult => ({
    kind: 'cell',
    rowId: table.rows[r] ?? from.rowId,
    colId: visible[c] ?? from.colId,
  });
  switch (direction) {
    case 'up':
      return rowIndex === 0 ? { kind: 'stay' } : at(rowIndex - 1, colIndex);
    case 'down':
      return rowIndex === lastRow ? { kind: 'append-row' } : at(rowIndex + 1, colIndex);
    case 'right':
      if (colIndex < lastCol) return at(rowIndex, colIndex + 1);
      return rowIndex === lastRow ? { kind: 'append-row' } : at(rowIndex + 1, 0);
    case 'left':
      if (colIndex > 0) return at(rowIndex, colIndex - 1);
      return rowIndex === 0 ? { kind: 'stay' } : at(rowIndex - 1, lastCol);
  }
}

function selecting(cell: CellSelection): Selection {
  return { tableId: cell.tableId, cell: { rowId: cell.rowId, colId: cell.colId } };
}

function pure(state: GridState): Transition {
  return { state, effect: null };
}

/**
 * One step of the machine. `lookup` resolves a table for traversal; it may
 * return null (table gone), which makes a move a no-op.
 */
export function reduce(
  state: GridState,
  event: GridEvent,
  lookup: (tableId: Id) => TraversalTable | null,
): Transition {
  const current = selectedCell(state.selection);
  switch (event.type) {
    case 'select': {
      // Selecting another cell ends an edit (its commit is the editor's job: blur commits).
      const editing =
        state.editing !== null && sameCell(state.editing.cell, event.cell) ? state.editing : null;
      return pure({ selection: selecting(event.cell), editing });
    }
    case 'selectTable':
      return pure({ selection: { tableId: event.tableId, cell: null }, editing: null });
    case 'selectBand': {
      const table = lookup(event.tableId);
      if (table === null) return pure(state);
      const visible = table.columns.filter((c) => !c.hidden).map((c) => c.id);
      const order = event.axis === 'row' ? table.rows : visible;
      if (!order.includes(event.id)) return pure(state);
      const previous = state.selection?.tableId === event.tableId ? state.selection : null;
      const prior = previous?.band ?? null;
      // Extending: from the band's anchor, else from the armed cell's row or column.
      const armed = previous?.cell ?? null;
      const anchor =
        event.extend === true
          ? prior !== null && prior.axis === event.axis
            ? prior.anchor
            : ((event.axis === 'row' ? armed?.rowId : armed?.colId) ?? event.id)
          : event.id;
      const ids = bandRange(order, anchor, event.id);
      // The armed cell: the anchor's cell in the armed column (or row), else the first.
      const cell =
        event.axis === 'row'
          ? { rowId: anchor, colId: armed?.colId ?? visible[0] ?? '' }
          : { rowId: armed?.rowId ?? table.rows[0] ?? '', colId: anchor };
      if (cell.rowId === '' || cell.colId === '') return pure(state);
      return pure({
        selection: { tableId: event.tableId, cell, band: { axis: event.axis, ids, anchor } },
        editing: null,
      });
    }
    case 'clear':
      return pure(IDLE);
    case 'edit': {
      const cell = event.cell ?? current;
      if (cell === null) return pure(state);
      return pure({ selection: selecting(cell), editing: { cell, seed: event.seed } });
    }
    case 'cancel':
      return pure({ selection: state.selection, editing: null });
    case 'committed': {
      // A late commit from an editor that already closed (its unmount, after the
      // selection moved) changes nothing.
      if (state.editing === null && event.then === null) return pure(state);
      const after = { selection: state.selection, editing: null };
      if (event.then === null || current === null) return pure(after);
      return move(after, current, event.then, lookup);
    }
    case 'move':
      if (current === null) return pure(state);
      return move({ selection: state.selection, editing: null }, current, event.direction, lookup);
    case 'tableGone':
      return state.selection?.tableId === event.tableId ? pure(IDLE) : pure(state);
  }
}

function move(
  state: GridState,
  from: CellSelection,
  direction: Direction,
  lookup: (tableId: Id) => TraversalTable | null,
): Transition {
  const table = lookup(from.tableId);
  if (table === null) return pure(state);
  const result = nextCell(table, from, direction);
  switch (result.kind) {
    case 'stay':
      return pure(state);
    case 'cell':
      return pure({
        selection: selecting({ tableId: from.tableId, rowId: result.rowId, colId: result.colId }),
        editing: null,
      });
    case 'append-row':
      return {
        state,
        effect: {
          kind: 'append-row',
          tableId: from.tableId,
          direction: direction === 'right' ? 'right' : 'down',
        },
      };
  }
}
