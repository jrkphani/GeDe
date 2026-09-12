/**
 * Grid commands — the contract the toolbar, inspector and context menus call
 * to change table structure (GRID-02, GRID-04, GRID-07..11, KEYS-06).
 *
 * Every command:
 *   - is a no-op that returns `null` / `false` / `[]` when the document is not
 *     editable (RESP-02, SHARE-03) — callers may still render the command, but
 *     disabled with the reason;
 *   - writes through `@gede/core` mutations, so it is one `transact` under the
 *     local origin and one undo step (KEYS-03);
 *   - keeps the selection sane afterwards (a deleted row hands the selection
 *     to its neighbour, an inserted row or column is selected) and announces
 *     the outcome through the live region (A11Y-05);
 *   - takes explicit ids, so a context menu opened on a column that is not
 *     selected can act on that column.
 *
 * Obtain an instance from `useGrid` (`grid/use-grid.ts`); do not construct one
 * elsewhere. Nothing here touches the DOM.
 */
import {
  addColumn,
  addRow,
  cellAddress,
  cellReadOnlyReason,
  clearCell as clearCellText,
  deleteColumn as deleteColumnMutation,
  deleteRow as deleteRowMutation,
  hideColumn as hideColumnMutation,
  insertRowBefore,
  scaleTable as scaleTableMutation,
  setCellText,
  setColumnWidth as setColumnWidthMutation,
  setColumnWrap as setColumnWrapMutation,
  setFooterRows as setFooterRowsMutation,
  setFrozenColumns as setFrozenColumnsMutation,
  setHeaderRows as setHeaderRowsMutation,
  setRowWrapped,
  tableById,
  tableMap,
  unhideAllColumns as unhideAllColumnsMutation,
  unhideColumn as unhideColumnMutation,
  type GedeDoc,
  type Id,
  type ReadOnlyReason,
  type ScaleTableOptions,
  type StripCount,
  type TableRecord,
} from '@gede/core';

import type { CellSelection, GridEvent, GridState } from '../../../doc/selection.js';

export interface GridCommands {
  /**
   * Append a row, or insert one below `rowId`; selects its cell in `colId`
   * (else the selected column, else the first visible column).
   */
  insertRowBelow(tableId: Id, rowId?: Id, colId?: Id): Id | null;
  /** Insert a row above `rowId`; selects its first visible cell. */
  insertRowAbove(tableId: Id, rowId: Id): Id | null;
  /** Delete a row; the selection moves to the row below, else above, else the table. */
  deleteRow(tableId: Id, rowId: Id): boolean;
  /** Append a column, or insert one after `colId`; selects its cell in the current row. */
  insertColumnAfter(tableId: Id, colId?: Id): Id | null;
  insertColumnBefore(tableId: Id, colId: Id): Id | null;
  /** Delete a column; the selection moves to the column after, else before, else the table. */
  deleteColumn(tableId: Id, colId: Id): boolean;
  /** Hide a column (its data stays); the selection leaves it the same way a delete would. */
  hideColumn(tableId: Id, colId: Id): boolean;
  unhideColumn(tableId: Id, colId: Id): boolean;
  /** Reveal every hidden column of the table. Returns the ids revealed. */
  unhideAllColumns(tableId: Id): Id[];
  /** GRID-09: wrap every cell of the column (rows become two lattice units). */
  setColumnWrap(tableId: Id, colId: Id, wrap: boolean): boolean;
  /** GRID-09: wrap one row. */
  setRowWrap(tableId: Id, rowId: Id, wrapped: boolean): boolean;
  /** GRID-08: column width in whole units (≥ 1). Returns the width stored. */
  setColumnWidth(tableId: Id, colId: Id, units: number): number | null;
  /** GRID-08: the corner handle. Returns the visible columns' widths after the call. */
  scaleTable(tableId: Id, options: ScaleTableOptions): number[] | null;
  /** GRID-10: leading frozen columns, clamped to the table. Returns the count stored. */
  setFrozenColumns(tableId: Id, count: number): number | null;
  /** GRID-11: 0 hides the column-header row, 1 shows it. */
  setHeaderRows(tableId: Id, count: StripCount): boolean;
  /** GRID-11: 0 hides the footer count strip, 1 shows it. */
  setFooterRows(tableId: Id, count: StripCount): boolean;
  /** GRID-04: Delete clears the cell; read-only cells refuse and say why. */
  clearCell(cell: CellSelection): boolean;
  /** GRID-06: write the editor's text; read-only cells refuse. */
  commitCell(cell: CellSelection, text: string): boolean;
  /** GRID-04: why a cell will not take typing, or null when it will. */
  readOnlyReason(cell: CellSelection): ReadOnlyReason | null;
}

export interface GridCommandDeps {
  gd: GedeDoc;
  editable: () => boolean;
  state: () => GridState;
  dispatch: (event: GridEvent) => void;
  announce: (text: string) => void;
}

/** Sentence for a read-only reason (A11Y-04: the reason is text, not a tint). */
export function readOnlyLabel(reason: ReadOnlyReason): string {
  switch (reason) {
    case 'derived':
      return 'derived column';
    case 'linked':
      return 'linked column';
    case 'pulled':
      return 'pulled column';
    case 'group':
      return 'category band';
  }
}

function firstVisibleColumn(record: TableRecord, preferred?: Id): Id | null {
  const wanted = record.columns.find((c) => c.id === preferred && !c.hidden);
  if (wanted !== undefined) return wanted.id;
  return record.columns.find((c) => !c.hidden)?.id ?? null;
}

export function createGridCommands(deps: GridCommandDeps): GridCommands {
  const { gd, dispatch, announce } = deps;
  const editable = () => deps.editable();
  const record = (tableId: Id) => tableById(gd, tableId);
  const map = (tableId: Id) => tableMap(gd, tableId);
  const selectedIn = (tableId: Id) => {
    const s = deps.state().selection;
    return s !== null && s.tableId === tableId ? s.cell : null;
  };
  const select = (cell: CellSelection) => {
    dispatch({ type: 'select', cell });
  };
  const addressOf = (cell: CellSelection): string => {
    const t = map(cell.tableId);
    return (t === null ? null : cellAddress(t, cell.rowId, cell.colId)) ?? 'the cell';
  };
  const readOnlyReason = (cell: CellSelection): ReadOnlyReason | null => {
    const t = map(cell.tableId);
    return t === null ? null : cellReadOnlyReason(t, cell.rowId, cell.colId);
  };
  const refuseReadOnly = (cell: CellSelection): boolean => {
    const reason = readOnlyReason(cell);
    if (reason === null) return false;
    announce(`${addressOf(cell)} is read-only: ${readOnlyLabel(reason)}`);
    return true;
  };

  /** After a row or column goes, land the selection on a neighbour, else the table. */
  const reselectAfterRow = (tableId: Id, before: TableRecord, index: number) => {
    const after = record(tableId);
    const sel = selectedIn(tableId);
    if (after === null || sel === null || sel.rowId !== before.rows[index]) return;
    const rowId = after.rows[Math.min(index, after.rows.length - 1)];
    const colId = firstVisibleColumn(after, sel.colId);
    if (rowId === undefined || colId === null) dispatch({ type: 'selectTable', tableId });
    else select({ tableId, rowId, colId });
  };
  const reselectAfterColumn = (tableId: Id, before: TableRecord, index: number) => {
    const after = record(tableId);
    const sel = selectedIn(tableId);
    if (after === null || sel === null || sel.colId !== before.columns[index]?.id) return;
    const visible = after.columns.filter((c) => !c.hidden);
    const gone = before.columns.filter((c, i) => !c.hidden && i < index).length;
    const next = visible[Math.min(gone, visible.length - 1)];
    if (next === undefined) dispatch({ type: 'selectTable', tableId });
    else select({ tableId, rowId: sel.rowId, colId: next.id });
  };

  return {
    insertRowBelow(tableId, rowId, colId) {
      if (!editable() || record(tableId) === null) return null;
      const id = addRow(gd, tableId, rowId);
      const rec = record(tableId);
      const target =
        rec === null ? null : firstVisibleColumn(rec, colId ?? selectedIn(tableId)?.colId);
      if (target !== null) select({ tableId, rowId: id, colId: target });
      announce(rowId === undefined ? 'Added a row' : 'Inserted a row below');
      return id;
    },
    insertRowAbove(tableId, rowId) {
      if (!editable() || record(tableId) === null) return null;
      const id = insertRowBefore(gd, tableId, rowId);
      const rec = record(tableId);
      const colId = rec === null ? null : firstVisibleColumn(rec, selectedIn(tableId)?.colId);
      if (colId !== null) select({ tableId, rowId: id, colId });
      announce('Inserted a row above');
      return id;
    },
    deleteRow(tableId, rowId) {
      const before = record(tableId);
      if (!editable() || before === null) return false;
      const index = before.rows.indexOf(rowId);
      if (index < 0 || !deleteRowMutation(gd, tableId, rowId)) return false;
      reselectAfterRow(tableId, before, index);
      announce('Deleted the row');
      return true;
    },
    insertColumnAfter(tableId, colId) {
      if (!editable() || record(tableId) === null) return null;
      const id = addColumn(gd, tableId, { afterColId: colId });
      const rowId = selectedIn(tableId)?.rowId ?? record(tableId)?.rows[0];
      if (rowId !== undefined) select({ tableId, rowId, colId: id });
      announce(colId === undefined ? 'Added a column' : 'Inserted a column after');
      return id;
    },
    insertColumnBefore(tableId, colId) {
      if (!editable() || record(tableId) === null) return null;
      const id = addColumn(gd, tableId, { beforeColId: colId });
      const rowId = selectedIn(tableId)?.rowId ?? record(tableId)?.rows[0];
      if (rowId !== undefined) select({ tableId, rowId, colId: id });
      announce('Inserted a column before');
      return id;
    },
    deleteColumn(tableId, colId) {
      const before = record(tableId);
      if (!editable() || before === null) return false;
      const index = before.columns.findIndex((c) => c.id === colId);
      if (index < 0 || !deleteColumnMutation(gd, tableId, colId)) return false;
      reselectAfterColumn(tableId, before, index);
      announce('Deleted the column');
      return true;
    },
    hideColumn(tableId, colId) {
      const before = record(tableId);
      if (!editable() || before === null) return false;
      const index = before.columns.findIndex((c) => c.id === colId);
      if (index < 0 || before.columns[index]?.hidden === true) return false;
      hideColumnMutation(gd, tableId, colId);
      reselectAfterColumn(tableId, before, index);
      announce(`Hid column ${before.columns[index]?.label ?? ''}`.trim());
      return true;
    },
    unhideColumn(tableId, colId) {
      const rec = record(tableId);
      const column = rec?.columns.find((c) => c.id === colId);
      if (!editable() || column?.hidden !== true) return false;
      unhideColumnMutation(gd, tableId, colId);
      announce(`Showed column ${column.label}`);
      return true;
    },
    unhideAllColumns(tableId) {
      if (!editable() || record(tableId) === null) return [];
      const revealed = unhideAllColumnsMutation(gd, tableId);
      if (revealed.length > 0) {
        announce(
          `Showed ${String(revealed.length)} hidden ${revealed.length === 1 ? 'column' : 'columns'}`,
        );
      }
      return revealed;
    },
    setColumnWrap(tableId, colId, wrap) {
      const column = record(tableId)?.columns.find((c) => c.id === colId);
      if (!editable() || column === undefined) return false;
      setColumnWrapMutation(gd, tableId, colId, wrap);
      announce(wrap ? `Wrapped column ${column.label}` : `Unwrapped column ${column.label}`);
      return true;
    },
    setRowWrap(tableId, rowId, wrapped) {
      const rec = record(tableId);
      if (!editable() || rec?.rows.includes(rowId) !== true) return false;
      setRowWrapped(gd, tableId, rowId, wrapped);
      announce(wrapped ? 'Wrapped the row' : 'Unwrapped the row');
      return true;
    },
    setColumnWidth(tableId, colId, units) {
      const column = record(tableId)?.columns.find((c) => c.id === colId);
      if (!editable() || column === undefined || !Number.isFinite(units)) return null;
      const width = setColumnWidthMutation(gd, tableId, colId, units);
      announce(`${column.label} is ${String(width)} ${width === 1 ? 'unit' : 'units'} wide`);
      return width;
    },
    scaleTable(tableId, options) {
      const rec = record(tableId);
      if (!editable() || rec === null) return null;
      const widths = scaleTableMutation(gd, tableId, options);
      const total = widths.reduce((a, b) => a + b, 0);
      announce(
        `${rec.title} is ${String(total)} ${total === 1 ? 'unit' : 'units'} wide${
          options.wrapped === undefined ? '' : options.wrapped ? ', rows wrapped' : ', rows compact'
        }`,
      );
      return widths;
    },
    setFrozenColumns(tableId, count) {
      const rec = record(tableId);
      if (!editable() || rec === null) return null;
      const frozen = setFrozenColumnsMutation(gd, tableId, count);
      announce(
        frozen === 0
          ? 'No frozen columns'
          : `${String(frozen)} frozen ${frozen === 1 ? 'column' : 'columns'}`,
      );
      return frozen;
    },
    setHeaderRows(tableId, count) {
      if (!editable() || record(tableId) === null) return false;
      setHeaderRowsMutation(gd, tableId, count);
      announce(count === 1 ? 'Header row shown' : 'Header row hidden');
      return true;
    },
    setFooterRows(tableId, count) {
      if (!editable() || record(tableId) === null) return false;
      setFooterRowsMutation(gd, tableId, count);
      announce(count === 1 ? 'Footer shown' : 'Footer hidden');
      return true;
    },
    clearCell(cell) {
      if (!editable() || map(cell.tableId) === null || refuseReadOnly(cell)) return false;
      clearCellText(gd, cell.tableId, cell.rowId, cell.colId);
      return true;
    },
    commitCell(cell, text) {
      if (!editable() || map(cell.tableId) === null || refuseReadOnly(cell)) return false;
      setCellText(gd, cell.tableId, cell.rowId, cell.colId, text);
      return true;
    },
    readOnlyReason,
  };
}
