/**
 * Grid commands — the contract the toolbar, inspector and context menus call
 * to change table structure (GRID-02, GRID-04, GRID-07..11, KEYS-06) and the
 * row hierarchy (HIER-01, HIER-06).
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
  ancestorIds,
  cellAddress,
  cellReadOnlyReason,
  clearCell as clearCellText,
  collapseAll as collapseAllMutation,
  commitCellText,
  deleteColumn as deleteColumnMutation,
  deleteRow as deleteRowMutation,
  expandAll as expandAllMutation,
  hideColumn as hideColumnMutation,
  insertRowBefore,
  nestRow as nestRowMutation,
  promoteRow as promoteRowMutation,
  rowOutline,
  scaleTable as scaleTableMutation,
  plainText,
  refreshDerivedLabels,
  renameColumn as renameColumnMutation,
  rowMeta,
  rowReadOnlyReason,
  setCellRich,
  setMappingValue,
  setColumnWidth as setColumnWidthMutation,
  setColumnWrap as setColumnWrapMutation,
  setFooterRows as setFooterRowsMutation,
  setFrozenColumns as setFrozenColumnsMutation,
  setHeaderRows as setHeaderRowsMutation,
  setRowCollapsed,
  setRowWrapped,
  tableById,
  tableMap,
  unhideAllColumns as unhideAllColumnsMutation,
  unhideColumn as unhideColumnMutation,
  type GedeDoc,
  type Id,
  type ReadOnlyReason,
  type RichDoc,
  type ScaleTableOptions,
  type StripCount,
  type TableMap,
  type TableRecord,
} from '@gede/core';

import type { CellSelection, GridEvent, GridState } from '../../../doc/selection.js';
import { workbookIndexFor } from '../../../doc/workbook-index.js';
import { isFormulaInput } from '../formula/input.js';

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
  /**
   * Rename a column; derived columns that name it re-spell their signature
   * (REF-04). A derived column refuses — its label is its signature.
   */
  renameColumn(tableId: Id, colId: Id, label: string): boolean;
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
  /**
   * REF-03: the mapping picker's write — one of the target column's distinct
   * values (or '' to clear) into a linked cell. The only write a linked
   * column accepts; a pulled or split row still refuses (REF-05).
   */
  pickMappingValue(cell: CellSelection, value: string, locale?: string): boolean;
  /** GRID-06: write the editor's text; read-only cells refuse. */
  commitCell(cell: CellSelection, text: string): boolean;
  /** GRID-06: write the editor's rich text (marks included); read-only cells refuse. */
  commitRichCell(cell: CellSelection, doc: RichDoc): boolean;
  /** GRID-04: why a cell will not take typing, or null when it will. */
  readOnlyReason(cell: CellSelection): ReadOnlyReason | null;
  /**
   * HIER-01 / KEYS-06 `⌘]`: nest the row one level under the row above, its
   * subtree with it. False when HIER-02 refuses (the control is disabled then).
   */
  nestRow(tableId: Id, rowId: Id): boolean;
  /** HIER-01 / KEYS-06 `⌘[`: promote the row one level. False at depth 0. */
  promoteRow(tableId: Id, rowId: Id): boolean;
  /**
   * HIER-06: collapse or expand a row with descendants. The selection leaves
   * a subtree about to be hidden for its parent first, so it never sits on a
   * row that does not render. False for a childless row or when the row
   * already reads that way.
   */
  setCollapsed(tableId: Id, rowId: Id, collapsed: boolean): boolean;
  /** HIER-06: the chevron. `setCollapsed` with the opposite of the row's state. */
  toggleCollapse(tableId: Id, rowId: Id): boolean;
  /** HIER-06: collapse every row with descendants. Returns the ids collapsed. */
  collapseAll(tableId: Id): Id[];
  /** HIER-06: expand every collapsed row. Returns the ids expanded. */
  expandAll(tableId: Id): Id[];
}

export interface GridCommandDeps {
  gd: GedeDoc;
  editable: () => boolean;
  state: () => GridState;
  dispatch: (event: GridEvent) => void;
  announce: (text: string) => void;
  /**
   * Called after every command (KEYS-03): the shell passes the undo manager's
   * `stopCapturing`, so one command is one undo step however quickly the next
   * follows — the manager's capture timeout would otherwise merge a commit with
   * the row it appended, or two divider presses.
   */
  settle?: (() => void) | undefined;
}

/** Wrap every command so `settle` runs after it, whatever it returned. */
function settled(commands: GridCommands, settle: (() => void) | undefined): GridCommands {
  if (settle === undefined) return commands;
  const source = commands as unknown as Record<string, (...args: unknown[]) => unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of Object.keys(source)) {
    if (key === 'readOnlyReason') continue; // a read, not an action
    const fn = source[key];
    if (fn === undefined) continue;
    out[key] = (...args: unknown[]) => {
      try {
        return fn(...args);
      } finally {
        settle();
      }
    };
  }
  return out as unknown as GridCommands;
}

/** Sentence for a read-only reason (A11Y-04: the reason is text, not a tint). */
export function readOnlyLabel(reason: ReadOnlyReason): string {
  switch (reason) {
    case 'derived':
      return 'derived column';
    case 'linked':
      return 'linked column';
    case 'pulled':
      return 'pulled from another table';
    case 'group':
      return 'category band';
    case 'splitChild':
      return 'split child row';
  }
}

/** HIER-06: whether `rowId` sits anywhere in `parentId`'s subtree. */
function isUnder(table: TableMap, rowId: Id, parentId: Id): boolean {
  return ancestorIds(table, rowId).includes(parentId);
}

/** The top-level row above `rowId` (itself when already at depth 0), or null when unknown. */
function topLevelAncestor(table: TableMap, rowId: Id): Id | null {
  if (rowOutline(table, rowId) === null) return null;
  return ancestorIds(table, rowId).at(-1) ?? rowId;
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

  const commands: GridCommands = {
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
      // A derived column that named the deleted source now reads `@#REF.…` (REF-04).
      refreshDerivedLabels(gd, tableId);
      reselectAfterColumn(tableId, before, index);
      announce('Deleted the column');
      return true;
    },
    renameColumn(tableId, colId, label) {
      const before = record(tableId);
      if (!editable() || before === null) return false;
      if (!renameColumnMutation(gd, tableId, colId, label)) {
        announce('A derived column is named by its signature');
        return false;
      }
      announce(`Column renamed to ${label}`);
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
      return clearCellText(gd, cell.tableId, cell.rowId, cell.colId);
    },
    pickMappingValue(cell, value, locale) {
      const t = map(cell.tableId);
      if (!editable() || t === null) return false;
      const rowReason = rowReadOnlyReason(rowMeta(t, cell.rowId));
      if (rowReason !== null) {
        announce(`${addressOf(cell)} is read-only: ${readOnlyLabel(rowReason)}`);
        return false;
      }
      const ok = setMappingValue(gd, cell.tableId, cell.rowId, cell.colId, value, locale);
      announce(
        ok
          ? `${addressOf(cell)} set to ${value === '' ? 'nothing' : value}`
          : `${value} is not a value of the target column`,
      );
      return ok;
    },
    commitCell(cell, text) {
      if (!editable() || map(cell.tableId) === null || refuseReadOnly(cell)) return false;
      // False when the row or column went while the editor was open: the draft is dropped
      // rather than written as a cell keyed to nothing (GRID-02). A formula's references
      // are bound to ids here, once, against today's geometry (PRD §20).
      return commitCellText(gd, cell.tableId, cell.rowId, cell.colId, text, {
        index: workbookIndexFor(gd.doc),
      });
    },
    commitRichCell(cell, doc) {
      if (!editable() || map(cell.tableId) === null || refuseReadOnly(cell)) return false;
      // A formula is a plain string bound to ids (PRD §20), never a fragment: the `commitCell`
      // that follows from the same editor finish writes it through commitCellText.
      if (isFormulaInput(plainText(doc))) return true;
      return setCellRich(gd, cell.tableId, cell.rowId, cell.colId, doc);
    },
    readOnlyReason,
    nestRow(tableId, rowId) {
      if (!editable() || record(tableId) === null) return false;
      const depth = nestRowMutation(gd, tableId, rowId);
      if (depth === null) {
        announce('Cannot nest deeper than one level under the row above');
        return false;
      }
      announce(`Nested to level ${String(depth + 1)}`);
      return true;
    },
    promoteRow(tableId, rowId) {
      if (!editable() || record(tableId) === null) return false;
      const depth = promoteRowMutation(gd, tableId, rowId);
      if (depth === null) {
        announce('Already at the top level');
        return false;
      }
      announce(
        depth === 0 ? 'Promoted to the top level' : `Promoted to level ${String(depth + 1)}`,
      );
      return true;
    },
    setCollapsed(tableId, rowId, collapsed) {
      const table = map(tableId);
      if (!editable() || table === null) return false;
      const row = rowOutline(table, rowId);
      if (row === null || !row.hasChildren || row.collapsed === collapsed) return false;
      if (collapsed) {
        // A selection inside the subtree would be on a hidden row after the write;
        // hand it to the parent before the write so the observer sees nothing to fix.
        const sel = selectedIn(tableId);
        if (sel !== null && sel.rowId !== rowId && isUnder(table, sel.rowId, rowId)) {
          select({ tableId, rowId, colId: sel.colId });
        }
      }
      const stored = setRowCollapsed(gd, tableId, rowId, collapsed);
      if (stored === null) return false;
      announce(stored ? 'Collapsed the row' : 'Expanded the row');
      return true;
    },
    toggleCollapse(tableId, rowId) {
      const table = map(tableId);
      const row = table === null ? null : rowOutline(table, rowId);
      if (row === null) return false;
      return commands.setCollapsed(tableId, rowId, !row.collapsed);
    },
    collapseAll(tableId) {
      const table = map(tableId);
      if (!editable() || table === null) return [];
      // Every selection below the top level ends up hidden: move it to its top-level ancestor first.
      const sel = selectedIn(tableId);
      if (sel !== null) {
        const top = topLevelAncestor(table, sel.rowId);
        if (top !== null && top !== sel.rowId) select({ tableId, rowId: top, colId: sel.colId });
      }
      const ids = collapseAllMutation(gd, tableId);
      if (ids.length > 0)
        announce(`Collapsed ${String(ids.length)} ${ids.length === 1 ? 'row' : 'rows'}`);
      return ids;
    },
    expandAll(tableId) {
      if (!editable() || record(tableId) === null) return [];
      const ids = expandAllMutation(gd, tableId);
      if (ids.length > 0)
        announce(`Expanded ${String(ids.length)} ${ids.length === 1 ? 'row' : 'rows'}`);
      return ids;
    },
  };
  return settled(commands, deps.settle);
}
