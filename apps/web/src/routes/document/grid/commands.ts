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
  addColumnRule,
  addRow,
  ancestorIds,
  appendRowWithValues,
  CANVAS_LAYOUT_LABELS,
  cellAddress,
  cellReadOnlyReason,
  clearCell as clearCellText,
  collapseAll as collapseAllMutation,
  commitCellText,
  deleteColumn as deleteColumnMutation,
  deleteRow as deleteRowMutation,
  deleteTableWithGraphs,
  distributeEvenly as distributeEvenlyMutation,
  duplicateColumnLabel,
  duplicateTableTitle,
  graphsBoundTo,
  expandAll as expandAllMutation,
  hideColumn as hideColumnMutation,
  insertRowBefore,
  layoutSheet,
  mergeCells as mergeCellsMutation,
  moveColumnRule,
  nestRow as nestRowMutation,
  promoteRow as promoteRowMutation,
  removeColumnRule,
  restack,
  rowOutline,
  scaleTable as scaleTableMutation,
  plainText,
  refreshDerivedLabels,
  richFromText,
  renameColumn as renameColumnMutation,
  rowHeights,
  rowMeta,
  rowReadOnlyReason,
  setCellAppearance,
  setCellRich,
  setColumnAppearance,
  setMappingValue,
  setColumnWidth as setColumnWidthMutation,
  setColumnWidths as setColumnWidthsMutation,
  setColumnWrap as setColumnWrapMutation,
  setFooterRows as setFooterRowsMutation,
  setFrozenColumns as setFrozenColumnsMutation,
  setHeaderRows as setHeaderRowsMutation,
  setOutlineColumn as setOutlineColumnMutation,
  setRowCollapsed,
  setRowHeights as setRowHeightsMutation,
  setRowWrap as setRowWrapMutation,
  setSheetEdgesShown,
  setTableLook as setTableLookMutation,
  setTablePinned,
  setTableTitle as setTableTitleMutation,
  spanAt,
  spanCovering,
  STACKING_LABELS,
  tableById,
  tableMap,
  tableOutline,
  unhideAllColumns as unhideAllColumnsMutation,
  unhideColumn as unhideColumnMutation,
  unmergeCells as unmergeCellsMutation,
  updateColumnRule,
  type AppearancePatch,
  type CanvasLayout,
  type ColumnRecord,
  type ConditionalRule,
  type GedeDoc,
  type Id,
  type ReadOnlyReason,
  type RichDoc,
  type ScaleTableOptions,
  type SpanExtent,
  type StackingMove,
  type StripCount,
  type TableLookPatch,
  type TableMap,
  type TableRecord,
} from '@gede/core';

import type { CellSelection, GridEvent, GridState } from '../../../doc/selection.js';
import { workbookIndexFor } from '../../../doc/workbook-index.js';
import { columnDisplayName } from './column-name.js';
import { isFormulaInput } from '../formula/input.js';

/** One cell's worth of clipboard content: its text, and its marks when it had any. */
export interface ColumnValue {
  readonly text: string;
  readonly rich: RichDoc | null;
}

export interface GridCommands {
  /**
   * Append a row, or insert one below `rowId`; selects its cell in `colId`
   * (else the selected column, else the first visible column).
   */
  insertRowBelow(tableId: Id, rowId?: Id, colId?: Id): Id | null;
  /** Insert a row above `rowId`; selects its first visible cell. */
  insertRowAbove(tableId: Id, rowId: Id): Id | null;
  /**
   * GRAPH-10: append a row pre-filled with `values` (column id → text) in one
   * undo step; selects its first pre-filled cell. Only entered columns are
   * written (REF-05); the rest of the tuple is dropped, not refused.
   */
  appendRowWith(tableId: Id, values: Readonly<Record<Id, string>>): Id | null;
  /** Delete a row; the selection moves to the row below, else above, else the table. */
  deleteRow(tableId: Id, rowId: Id): boolean;
  /** Append a column, or insert one after `colId`; selects its cell in the current row. */
  insertColumnAfter(tableId: Id, colId?: Id): Id | null;
  insertColumnBefore(tableId: Id, colId: Id): Id | null;
  /** Delete a column; the selection moves to the column after, else before, else the table. */
  deleteColumn(tableId: Id, colId: Id): boolean;
  /**
   * ADR-047: delete the table — cells, row and column meta, and every graph
   * object bound to it — as one undo step; references from other tables read
   * the reference-removed error (FX-06). No confirmation: undo is the safety.
   * The selection clears. Returns the table's title and how many graphs (pairs)
   * went with it, for the caller to announce once it has moved focus and the
   * engine has reported the dependents it broke — so the undo hint, not the
   * landing cell's "Selected …", is what the live region ends on — or null
   * when nothing was deleted.
   */
  deleteTable(tableId: Id): { title: string; graphs: number } | null;
  /**
   * ADR-051: rename a column; every label that names it re-spells — derived
   * signatures (REF-04), pulled and mapping labels anywhere (REF-02, REF-03).
   * The name is trimmed; an unchanged one writes nothing. Refused, with the
   * reason announced and returned for the field to show: an empty name, a
   * name another column of the table already carries, a column whose label
   * is its lineage (`columnRenameReason`). Formulas and `@` paths are
   * id-bound, so nothing that reads the column breaks (REF-01).
   */
  renameColumn(tableId: Id, colId: Id, label: string): RenameResult;
  /**
   * ADR-051: rename the table. Trimmed; unchanged writes nothing; an empty
   * title or one another table already carries is refused with the reason.
   * One undo step, synced; pulled and mapping labels naming the table re-spell.
   */
  setTableTitle(tableId: Id, title: string): RenameResult;
  /** Hide a column (its data stays); the selection leaves it the same way a delete would. */
  hideColumn(tableId: Id, colId: Id): boolean;
  unhideColumn(tableId: Id, colId: Id): boolean;
  /** Reveal every hidden column of the table. Returns the ids revealed. */
  unhideAllColumns(tableId: Id): Id[];
  /**
   * GRID-09 / ADR-049: column-scope wrap — `true` wraps the column's cells,
   * `false` clips them, `null` follows the table. Paint only: the editing
   * replica's auto-height then stores what each row needs.
   */
  setColumnWrap(tableId: Id, colId: Id, wrap: boolean | null): boolean;
  /** GRID-09 / ADR-049: row-scope wrap, over the column's and the table's; `null` follows them. */
  setRowWrap(tableId: Id, rowId: Id, wrap: boolean | null): boolean;
  /** The same over a selected band of rows, in one transaction (one undo step). */
  setRowsWrap(tableId: Id, rowIds: readonly Id[], wrap: boolean | null): boolean;
  /** INSP-04 / ADR-049: table-scope wrap, the default every cell inherits. */
  setTableWrap(tableId: Id, wrap: boolean): boolean;
  /** GRID-08: column width in whole units (≥ 1). Returns the width stored. */
  setColumnWidth(tableId: Id, colId: Id, units: number): number | null;
  /**
   * GRID-08 / ADR-049: several columns' widths in one transaction — a drag
   * on one divider of a selected band, or the Width field over a selection.
   * Returns the widths stored, in the given order.
   */
  setColumnWidths(tableId: Id, widths: readonly { colId: Id; units: number }[]): number[] | null;
  /**
   * GRID-09 / ADR-049: rows set to a height by hand — a row divider drag, the
   * Height field, the keyboard on a focused divider. The rows stop following
   * their content (R-B) until Fit to content. Returns the heights stored.
   */
  setRowHeights(tableId: Id, heights: readonly { rowId: Id; units: number }[]): number[] | null;
  /** GRID-08: the corner handle: total width and total height, each shared out in whole units. */
  scaleTable(tableId: Id, options: ScaleTableOptions): number[] | null;
  /**
   * ADR-049 (Numbers' Table › Distribute Rows / Columns Evenly): the selected
   * rows or columns, or every visible one, share their total evenly. One undo step.
   */
  distributeEvenly(tableId: Id, axis: 'row' | 'column', only?: readonly Id[]): number[] | null;
  /** GRID-10: leading frozen columns, clamped to the table. Returns the count stored. */
  setFrozenColumns(tableId: Id, count: number): number | null;
  /**
   * HIER-04 / ADR-052: the table's designated outline column — the default a
   * row falls back to — or null for the first visible column. One undo step.
   * False when the column is not in the table or nothing changes.
   */
  setOutlineColumn(tableId: Id, colId: Id | null): boolean;
  /** GRID-11: 0 hides the column-header row, 1 shows it. */
  setHeaderRows(tableId: Id, count: StripCount): boolean;
  /** GRID-11: 0 hides the footer count strip, 1 shows it. */
  setFooterRows(tableId: Id, count: StripCount): boolean;
  /** GRID-04: Delete clears the cell; read-only cells refuse and say why. */
  clearCell(cell: CellSelection): boolean;
  /**
   * MENU-03 / REF-05: clear every cell of one column in one transaction (one
   * undo step). A derived, linked or pulled column refuses and says why; a
   * read-only row (a pulled row, a split child) is skipped and counted.
   * Returns how many cells were cleared, or null when the column refused.
   */
  clearColumn(tableId: Id, colId: Id): number | null;
  /**
   * MENU-03: write a value into every row of one column in one transaction —
   * the column menu's Paste. One value fills every row; several fill rows top
   * to bottom, in order, and the rest of the column is left as it was. `plain`
   * is Paste and match style: marks are dropped. Read-only rows are skipped.
   * Returns how many cells were written, or null when the column refused.
   */
  fillColumn(
    tableId: Id,
    colId: Id,
    values: readonly ColumnValue[],
    options?: { plain?: boolean | undefined },
  ): number | null;
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
   * subtree with it. `colId` — the selected cell's column — is where the row's
   * outline is drawn from then on (ADR-052). False when HIER-02 refuses (the
   * control is disabled then).
   */
  nestRow(tableId: Id, rowId: Id, colId?: Id): boolean;
  /** HIER-01 / KEYS-06 `⌘[`: promote the row one level. False at depth 0. */
  promoteRow(tableId: Id, rowId: Id, colId?: Id): boolean;
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

  // --- appearance (INSP-04..07, MENU-04): each one transaction, live on the canvas (INSP-12)

  /** INSP-04: table style, title and caption, outline, gridline density, banding. */
  setTableLook(tableId: Id, patch: TableLookPatch): boolean;
  /** INSP-04: the given columns to their measured widths, one transaction. */
  fitColumns(tableId: Id, widths: readonly { colId: Id; units: number }[]): boolean;
  /**
   * INSP-04 / ADR-049: the given rows to their measured heights, one
   * transaction; each row follows its content again (`fit` on).
   */
  fitRows(tableId: Id, rows: readonly { rowId: Id; units: number }[]): boolean;
  /**
   * INSP-05 / INSP-06 / INSP-10: fill, border, typography and alignment on the
   * column (every cell without its own value, and rows added later), or on
   * one cell as an override. A field set to `null` clears it back to inherit.
   */
  setColumnAppearance(tableId: Id, colId: Id, patch: AppearancePatch): boolean;
  setCellAppearance(cell: CellSelection, patch: AppearancePatch | null): boolean;
  /** INSP-05: conditional highlighting rules on a column; the list order is the priority. */
  addRule(tableId: Id, colId: Id, rule: Omit<ConditionalRule, 'id'>): ConditionalRule | null;
  updateRule(
    tableId: Id,
    colId: Id,
    ruleId: string,
    patch: Partial<Omit<ConditionalRule, 'id'>>,
  ): boolean;
  removeRule(tableId: Id, colId: Id, ruleId: string): boolean;
  /** INSP-05: move a rule one place up or down the list — its priority. */
  moveRule(tableId: Id, colId: Id, ruleId: string, direction: 'up' | 'down'): boolean;
  /**
   * MENU-04: merge from the anchor across rows × columns as a visual span —
   * the covered cells keep their addresses and data (non-negotiable 3).
   * Refuses past the table edge or over another span, and says why.
   */
  mergeCells(cell: CellSelection, extent: SpanExtent): boolean;
  /** MENU-04: grow the span at the cell by one column or one row. */
  mergeRight(cell: CellSelection): boolean;
  mergeDown(cell: CellSelection): boolean;
  /** MENU-04: unmerge the span the cell anchors or is covered by. */
  unmergeCells(cell: CellSelection): boolean;
  /** INSP-07: stacking order among the sheet's tables. False when the move changes nothing. */
  restack(tableId: Id, move: StackingMove): boolean;
  /** INSP-07 / PRD §10: pin the table to the viewport, or release it. */
  setTablePinned(tableId: Id, pinned: boolean): boolean;
  /** INSP-07: place every table on the sheet by the layout; positions stay data (RESP-01). */
  layoutSheet(sheetId: Id, layout: CanvasLayout): boolean;
  /** INSP-07 / PRD §7: show or hide the sheet's DAG edges. */
  setSheetEdgesShown(sheetId: Id, shown: boolean): boolean;
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

/**
 * Commands whose write must merge into the step already open: a commit ends
 * an edit session whose keystrokes are that step (KEYS-03, `RichCellEditor`).
 */
const MERGING_COMMANDS = new Set<keyof GridCommands>(['commitCell', 'commitRichCell']);

/**
 * Wrap every command so `settle` runs before and after it, whatever it
 * returned: one command is one undo step however close it lands to the
 * change before it — a divider drag a moment after Add table is its own step
 * (ADR-047's rule for delete, made general by ADR-049). A commit settles
 * after only, so it joins its edit session.
 */
function settled(commands: GridCommands, settle: (() => void) | undefined): GridCommands {
  if (settle === undefined) return commands;
  const source = commands as unknown as Record<string, (...args: unknown[]) => unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of Object.keys(source)) {
    if (key === 'readOnlyReason') continue; // a read, not an action
    const fn = source[key];
    if (fn === undefined) continue;
    const merging = MERGING_COMMANDS.has(key as keyof GridCommands);
    out[key] = (...args: unknown[]) => {
      if (!merging) settle();
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

/**
 * ADR-051 / MENU-02: why a column cannot be renamed by hand, or undefined
 * when it can. A label that is lineage is rewritten from its spec: the
 * derived signature (REF-04), `↰ Table · Column` for a pull (REF-02), the
 * mapping's target (REF-03). Inline English, as every menu reason is.
 */
export function columnRenameReason(column: Pick<ColumnRecord, 'source'>): string | undefined {
  switch (column.source) {
    case 'entered':
      return undefined;
    case 'derived':
      return 'a derived column is named by its signature';
    case 'pulled':
      return 'a pulled column is named by its source';
    case 'linked':
      return 'a mapping column is named by its target';
  }
}

/** ADR-051 / A11Y-04: what the inline field says beside itself when the name is empty. */
export const EMPTY_COLUMN_NAME_REASON = 'A column needs a name';
export const EMPTY_TABLE_TITLE_REASON = 'A table needs a title';
const VIEW_ONLY_REASON = 'You have view-only access';

/**
 * ADR-051: what a rename came to. A refusal carries the sentence the field
 * shows beside itself (`aria-describedby`, A11Y-04); the command has already
 * said it through the live region (A11Y-05) — except an empty name, which
 * the field says itself as it does for a sheet (ADR-048).
 */
export type RenameResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
const OK: RenameResult = { ok: true };

/** "a derived column is named by its signature" → "A derived column is named by its signature". */
function sentence(reason: string): string {
  return reason.charAt(0).toLocaleUpperCase() + reason.slice(1);
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

const LOOK_LABELS: Readonly<Record<keyof TableLookPatch, string>> = {
  style: 'style',
  titleShown: 'title',
  caption: 'caption',
  captionShown: 'caption',
  outline: 'outline',
  gridlines: 'gridlines',
  alternating: 'alternating rows',
  wrap: 'wrap',
};

/** "Row 5", by the row's lattice number as the ruler shows it (DOC-06), for announcements. */
function rowName(table: TableMap, record: TableRecord, rowId: Id): string {
  const first = record.columns.find((c) => !c.hidden);
  const address = first === undefined ? null : cellAddress(table, rowId, first.id);
  const number = address?.replace(/^[A-Z]+/, '');
  return number === undefined || number === '' ? 'The row' : `Row ${number}`;
}

/** ADR-052: how a column is named in an announcement — its label, else "column C". */
function columnName(rec: TableRecord, colId: Id | null): string {
  if (colId === null) return 'the first visible column';
  const column = rec.columns.find((c) => c.id === colId);
  const name = columnDisplayName(rec, colId);
  if (column === undefined || name === null) return 'the first visible column';
  return column.label.trim() === '' ? `column ${name}` : name;
}

/** "3 units tall" / "1 unit wide": a size in words. */
function units(n: number, what: 'tall' | 'wide'): string {
  return `${String(n)} ${n === 1 ? 'unit' : 'units'} ${what}`;
}

/** A11Y-05: what an appearance change did, in words. */
function describePatch(patch: AppearancePatch): string {
  const parts: string[] = [];
  const say = (label: string, value: unknown) => {
    parts.push(value === null ? `${label} cleared` : `${label} set`);
  };
  if (patch.fill !== undefined) say('Fill', patch.fill);
  if (patch.border !== undefined) say('Border', patch.border);
  if (patch.font !== undefined) say('Font', patch.font);
  if (patch.weight !== undefined) say('Weight', patch.weight);
  if (patch.size !== undefined) say('Size', patch.size);
  if (patch.textColour !== undefined) say('Text colour', patch.textColour);
  if (patch.hAlign !== undefined) say('Alignment', patch.hAlign);
  if (patch.vAlign !== undefined) say('Vertical alignment', patch.vAlign);
  if (patch.wrap !== undefined) {
    parts.push(
      patch.wrap === null ? 'Wrap follows the column' : patch.wrap ? 'Wrapped' : 'Unwrapped',
    );
  }
  return parts.length === 0 ? 'Appearance unchanged' : parts.join(', ');
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
  /**
   * MENU-03 / REF-05: the rows a column-scope write may touch. A column that is
   * not `entered` refuses outright (its cells are the engine's or the picker's);
   * a row that is read-only for its own reason (a pulled row, a split child, a
   * band) is left out and counted, so the announcement can say so.
   */
  const writableColumn = (
    tableId: Id,
    colId: Id,
  ): { column: ColumnRecord; rows: Id[]; skipped: number } | null => {
    const rec = record(tableId);
    const t = map(tableId);
    const column = rec?.columns.find((c) => c.id === colId);
    if (!editable() || rec === null || t === null || column === undefined) return null;
    if (column.source !== 'entered') {
      announce(`Column ${column.label} is read-only: ${readOnlyLabel(column.source)}`);
      return null;
    }
    const rows: Id[] = [];
    let skipped = 0;
    for (const rowId of rec.rows) {
      if (cellReadOnlyReason(t, rowId, colId) === null) rows.push(rowId);
      else skipped += 1;
    }
    return { column, rows, skipped };
  };
  /** A rename refusal: said once here (unless `said` is null), then shown by the field. */
  const refused = (reason: string, said: string | null = reason): RenameResult => {
    if (said !== null) announce(said);
    return { ok: false, reason };
  };
  const skippedNote = (skipped: number): string =>
    skipped === 0 ? '' : `; ${String(skipped)} read-only ${skipped === 1 ? 'row' : 'rows'} skipped`;

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
    appendRowWith(tableId, values) {
      const rec = record(tableId);
      if (!editable() || rec === null) return null;
      const entered = new Set(rec.columns.filter((c) => c.source === 'entered').map((c) => c.id));
      const allowed = Object.fromEntries(
        Object.entries(values).filter(([colId]) => entered.has(colId)),
      );
      const id = appendRowWithValues(gd, tableId, allowed);
      if (id === null) return null;
      const first = rec.columns.find((c) => !c.hidden && allowed[c.id] !== undefined)?.id;
      const colId = firstVisibleColumn(rec, first);
      if (colId !== null) select({ tableId, rowId: id, colId });
      const count = Object.keys(allowed).length;
      announce(`Added a row with ${String(count)} ${count === 1 ? 'value' : 'values'}`);
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
    deleteTable(tableId) {
      const before = record(tableId);
      if (!editable() || before === null) return null;
      const pairs = new Set(graphsBoundTo(gd, tableId).map((g) => g.pairId));
      if (deleteTableWithGraphs(gd, tableId) === null) return null;
      dispatch({ type: 'tableGone', tableId });
      return { title: before.title, graphs: pairs.size };
    },
    renameColumn(tableId, colId, label) {
      const before = record(tableId);
      const column = before?.columns.find((c) => c.id === colId);
      if (!editable()) return refused(VIEW_ONLY_REASON);
      if (before === null || column === undefined) return refused('The column is gone');
      const lineage = columnRenameReason(column);
      if (lineage !== undefined) {
        return refused(sentence(lineage), `Column ${column.label} keeps its name: ${lineage}`);
      }
      const next = label.trim();
      if (next === '') return refused(EMPTY_COLUMN_NAME_REASON, null);
      if (next === column.label) return OK;
      const taken = duplicateColumnLabel(before, colId, next);
      if (taken !== null) return refused(`Another column is already named ${taken.label}`);
      if (!renameColumnMutation(gd, tableId, colId, next)) return refused('The column is gone');
      announce(`Renamed column ${column.label} to ${next}`);
      return OK;
    },
    setTableTitle(tableId, title) {
      const before = record(tableId);
      if (!editable()) return refused(VIEW_ONLY_REASON);
      if (before === null) return refused('The table is gone');
      const next = title.trim();
      if (next === '') return refused(EMPTY_TABLE_TITLE_REASON, null);
      if (next === before.title) return OK;
      const taken = duplicateTableTitle(gd, tableId, next);
      if (taken !== null) return refused(`Another table is already named ${taken.title}`);
      if (!setTableTitleMutation(gd, tableId, next)) return refused('The table is gone');
      announce(`Renamed table ${before.title} to ${next}`);
      return OK;
    },
    hideColumn(tableId, colId) {
      const before = record(tableId);
      const table = map(tableId);
      if (!editable() || before === null || table === null) return false;
      const index = before.columns.findIndex((c) => c.id === colId);
      if (index < 0 || before.columns[index]?.hidden === true) return false;
      // ADR-052: the outline drawn in this column — the table's default or a row's own —
      // falls back once it is hidden; say where it went. Names are read before the write:
      // a hidden column has no grid letter.
      const outlineBefore = tableOutline(table, before);
      const carriedOutline =
        outlineBefore.column === colId || outlineBefore.rows.some((r) => r.column === colId);
      const from = columnName(before, colId);
      hideColumnMutation(gd, tableId, colId);
      reselectAfterColumn(tableId, before, index);
      const hid = `Hid column ${from}`;
      const after = record(tableId);
      if (carriedOutline && after !== null) {
        const to = columnName(after, tableOutline(table, after).column);
        announce(`${hid}. Outline column ${from} is hidden; showing the outline in ${to}`);
      } else {
        announce(hid);
      }
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
      announce(
        wrap === null
          ? `Column ${column.label} follows the table's wrap`
          : wrap
            ? `Wrapped column ${column.label}`
            : `Unwrapped column ${column.label}`,
      );
      return true;
    },
    setRowWrap(tableId, rowId, wrap) {
      const rec = record(tableId);
      const t = map(tableId);
      if (!editable() || rec === null || t === null || !rec.rows.includes(rowId)) return false;
      setRowWrapMutation(gd, tableId, rowId, wrap);
      const name = rowName(t, rec, rowId);
      announce(
        wrap === null
          ? `${name} follows its columns' wrap`
          : wrap
            ? `${name} wrapped`
            : `${name} unwrapped`,
      );
      return true;
    },
    setRowsWrap(tableId, rowIds, wrap) {
      const rec = record(tableId);
      if (!editable() || rec === null) return false;
      const known = rowIds.filter((id) => rec.rows.includes(id));
      if (known.length === 0) return false;
      gd.doc.transact(() => {
        for (const rowId of known) setRowWrapMutation(gd, tableId, rowId, wrap);
      }, gd.origin);
      const n = String(known.length);
      announce(
        wrap === null
          ? `${n} rows follow their columns' wrap`
          : wrap
            ? `${n} rows wrapped`
            : `${n} rows unwrapped`,
      );
      return true;
    },
    setTableWrap(tableId, wrap) {
      const rec = record(tableId);
      if (!editable() || rec === null) return false;
      setTableLookMutation(gd, tableId, { wrap });
      announce(wrap ? `${rec.title}: text wraps in cells` : `${rec.title}: text clips in cells`);
      return true;
    },
    setColumnWidth(tableId, colId, units) {
      const column = record(tableId)?.columns.find((c) => c.id === colId);
      if (!editable() || column === undefined || !Number.isFinite(units)) return null;
      const width = setColumnWidthMutation(gd, tableId, colId, units);
      announce(`${column.label} is ${String(width)} ${width === 1 ? 'unit' : 'units'} wide`);
      return width;
    },
    setColumnWidths(tableId, widths) {
      const rec = record(tableId);
      if (!editable() || rec === null || widths.length === 0) return null;
      if (widths.some((w) => !Number.isFinite(w.units))) return null;
      const known = widths.filter((w) => rec.columns.some((c) => c.id === w.colId));
      if (known.length === 0) return null;
      const stored = setColumnWidthsMutation(gd, tableId, known);
      if (known.length === 1) {
        const column = rec.columns.find((c) => c.id === known[0]?.colId);
        announce(`${column?.label ?? 'The column'} is ${units(stored[0] ?? 1, 'wide')}`);
      } else {
        const same = stored.every((w) => w === stored[0]);
        announce(
          same
            ? `${String(known.length)} columns are ${units(stored[0] ?? 1, 'wide')}`
            : `${String(known.length)} columns resized to ${stored.map(String).join(', ')} units`,
        );
      }
      return stored;
    },
    setRowHeights(tableId, heights) {
      const rec = record(tableId);
      const t = map(tableId);
      if (!editable() || rec === null || t === null || heights.length === 0) return null;
      if (heights.some((h) => !Number.isFinite(h.units))) return null;
      const known = heights.filter((h) => rec.rows.includes(h.rowId));
      if (known.length === 0) return null;
      const stored = setRowHeightsMutation(gd, tableId, known, 'manual');
      if (known.length === 1) {
        announce(`${rowName(t, rec, known[0]?.rowId ?? '')} is ${units(stored[0] ?? 1, 'tall')}`);
      } else {
        const same = stored.every((h) => h === stored[0]);
        announce(
          same
            ? `${String(known.length)} rows are ${units(stored[0] ?? 1, 'tall')}`
            : `${String(known.length)} rows resized to ${stored.map(String).join(', ')} units`,
        );
      }
      return stored;
    },
    scaleTable(tableId, options) {
      const rec = record(tableId);
      const t = map(tableId);
      if (!editable() || rec === null || t === null) return null;
      const widths = scaleTableMutation(gd, tableId, options);
      const total = widths.reduce((a, b) => a + b, 0);
      const height = rowHeights(t).reduce((a, b) => a + b, 0);
      announce(
        `${rec.title} is ${units(total, 'wide')}${
          options.heightUnits === undefined ? '' : `, rows ${units(height, 'tall')} together`
        }`,
      );
      return widths;
    },
    distributeEvenly(tableId, axis, only) {
      const rec = record(tableId);
      if (!editable() || rec === null) return null;
      const sizes = distributeEvenlyMutation(gd, tableId, axis, only);
      if (sizes.length === 0) return sizes;
      const what = axis === 'row' ? 'rows' : 'columns';
      const same = sizes.every((s) => s === sizes[0]);
      announce(
        same
          ? `${String(sizes.length)} ${what} are ${units(sizes[0] ?? 1, axis === 'row' ? 'tall' : 'wide')}`
          : `${String(sizes.length)} ${what} distributed: ${sizes.map(String).join(', ')} units`,
      );
      return sizes;
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
    setOutlineColumn(tableId, colId) {
      const rec = record(tableId);
      const table = map(tableId);
      if (!editable() || rec === null || table === null) return false;
      if (rec.outlineColumn === colId) return false;
      if (!setOutlineColumnMutation(gd, tableId, colId)) return false;
      const after = record(tableId);
      if (after === null) return false;
      announce(
        colId === null
          ? 'Outline column: the first visible column'
          : `Outline column: ${columnName(after, colId)}`,
      );
      return true;
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
    clearColumn(tableId, colId) {
      const scope = writableColumn(tableId, colId);
      if (scope === null) return null;
      let cleared = 0;
      gd.doc.transact(() => {
        for (const rowId of scope.rows) {
          if (clearCellText(gd, tableId, rowId, colId)) cleared += 1;
        }
      }, gd.origin);
      announce(
        `Cleared column ${scope.column.label}: ${String(cleared)} ${cleared === 1 ? 'cell' : 'cells'}${skippedNote(scope.skipped)}`,
      );
      return cleared;
    },
    fillColumn(tableId, colId, values, options) {
      const scope = writableColumn(tableId, colId);
      if (scope === null) return null;
      if (values.length === 0) {
        announce('Nothing to paste');
        return 0;
      }
      const plain = options?.plain === true;
      const index = workbookIndexFor(gd.doc);
      let written = 0;
      gd.doc.transact(() => {
        scope.rows.forEach((rowId, i) => {
          // One value fills the column; several fill rows top to bottom and stop.
          const value = values.length === 1 ? values[0] : values[i];
          if (value === undefined) return;
          const formula = isFormulaInput(value.text);
          let ok: boolean;
          if (formula || value.text === '') {
            // A formula is a plain string bound to ids (PRD §20), never a fragment.
            ok = commitCellText(gd, tableId, rowId, colId, value.text, { index });
          } else if (plain) {
            // Match style: an unmarked document, so a cell that held marks loses them.
            ok = setCellRich(gd, tableId, rowId, colId, richFromText(value.text));
          } else if (value.rich !== null && plainText(value.rich) === value.text) {
            ok = setCellRich(gd, tableId, rowId, colId, value.rich);
          } else {
            ok = commitCellText(gd, tableId, rowId, colId, value.text, { index });
          }
          if (ok) written += 1;
        });
      }, gd.origin);
      announce(
        `Pasted${plain ? ' plain text' : ''} into column ${scope.column.label}: ${String(written)} ${written === 1 ? 'cell' : 'cells'}${skippedNote(scope.skipped)}`,
      );
      return written;
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
    nestRow(tableId, rowId, colId) {
      const table = map(tableId);
      if (!editable() || table === null) return false;
      const depth = nestRowMutation(gd, tableId, rowId, colId);
      if (depth === null) {
        announce('Cannot nest deeper than one level under the row above');
        return false;
      }
      // ADR-052: say where the outline landed — the row's column after the write.
      const after = tableById(gd, tableId);
      const column = rowOutline(table, rowId)?.column ?? null;
      const where = after === null || column === null ? '' : ` in ${columnName(after, column)}`;
      announce(`Nested to level ${String(depth + 1)}${where}`);
      return true;
    },
    promoteRow(tableId, rowId, colId) {
      if (!editable() || record(tableId) === null) return false;
      const depth = promoteRowMutation(gd, tableId, rowId, colId);
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

    // --- appearance ---------------------------------------------------------

    setTableLook(tableId, patch) {
      const rec = record(tableId);
      if (!editable() || rec === null) return false;
      const written = setTableLookMutation(gd, tableId, patch);
      if (written.length === 0) return false;
      const labels = Array.from(new Set(written.map((key) => LOOK_LABELS[key])));
      announce(`${rec.title}: ${labels.join(', ')} updated`);
      return true;
    },
    fitColumns(tableId, widths) {
      const rec = record(tableId);
      if (!editable() || rec === null || widths.length === 0) return false;
      gd.doc.transact(() => {
        for (const w of widths) setColumnWidthMutation(gd, tableId, w.colId, w.units);
      }, gd.origin);
      announce(
        `Fitted ${String(widths.length)} ${widths.length === 1 ? 'column' : 'columns'} to content`,
      );
      return true;
    },
    fitRows(tableId, rows) {
      const rec = record(tableId);
      const t = map(tableId);
      if (!editable() || rec === null || t === null || rows.length === 0) return false;
      const stored = setRowHeightsMutation(gd, tableId, rows, 'fit');
      if (rows.length === 1) {
        announce(
          `${rowName(t, rec, rows[0]?.rowId ?? '')} fits its content: ${units(stored[0] ?? 1, 'tall')}`,
        );
      } else {
        const tall = stored.filter((h) => h > 1).length;
        announce(
          tall === 0
            ? `${String(rows.length)} rows fit their content on one unit`
            : `${String(rows.length)} rows fit their content; ${String(tall)} ${tall === 1 ? 'is' : 'are'} taller than one unit`,
        );
      }
      return true;
    },
    setColumnAppearance(tableId, colId, patch) {
      const rec = record(tableId);
      const column = rec?.columns.find((c) => c.id === colId);
      if (!editable() || rec === null || column === undefined) return false;
      // INSP-06 / GRID-09 / ADR-049: a size whose line box needs more than one row grows the
      // rows through the editing replica's auto-height, in the same undo step; every size on
      // the scale can be chosen (ADR-034's Indic refusal is gone).
      setColumnAppearance(gd, tableId, colId, patch);
      announce(`${describePatch(patch)} for column ${column.label}`);
      return true;
    },
    setCellAppearance(cell, patch) {
      const t = map(cell.tableId);
      if (!editable() || t === null) return false;
      setCellAppearance(gd, cell.tableId, cell.rowId, cell.colId, patch);
      announce(
        patch === null
          ? `${addressOf(cell)} follows its column again`
          : `${describePatch(patch)} for ${addressOf(cell)}`,
      );
      return true;
    },
    moveRule(tableId, colId, ruleId, direction) {
      if (!editable() || record(tableId) === null) return false;
      const ok = moveColumnRule(gd, tableId, colId, ruleId, direction);
      if (ok) announce(direction === 'up' ? 'Rule moved up' : 'Rule moved down');
      return ok;
    },
    addRule(tableId, colId, rule) {
      const column = record(tableId)?.columns.find((c) => c.id === colId);
      if (!editable() || column === undefined) return null;
      const created = addColumnRule(gd, tableId, colId, rule);
      announce(`Rule added to column ${column.label}`);
      return created;
    },
    updateRule(tableId, colId, ruleId, patch) {
      if (!editable() || record(tableId) === null) return false;
      const ok = updateColumnRule(gd, tableId, colId, ruleId, patch);
      if (ok) announce('Rule updated');
      return ok;
    },
    removeRule(tableId, colId, ruleId) {
      if (!editable() || record(tableId) === null) return false;
      const ok = removeColumnRule(gd, tableId, colId, ruleId);
      if (ok) announce('Rule removed');
      return ok;
    },
    mergeCells(cell, extent) {
      if (!editable() || map(cell.tableId) === null) return false;
      const refusal = mergeCellsMutation(gd, cell.tableId, cell.rowId, cell.colId, extent);
      if (refusal !== null) {
        announce(
          refusal === 'past-edge'
            ? 'Cannot merge past the edge of the table'
            : refusal === 'overlaps'
              ? 'Cannot merge over another merged cell'
              : 'That cell is not in the table',
        );
        return false;
      }
      announce(
        extent.rows === 1 && extent.cols === 1
          ? `${addressOf(cell)} unmerged`
          : `${addressOf(cell)} spans ${String(extent.rows)} ${extent.rows === 1 ? 'row' : 'rows'} and ${String(extent.cols)} ${extent.cols === 1 ? 'column' : 'columns'}; every address stays`,
      );
      return true;
    },
    mergeRight(cell) {
      const t = map(cell.tableId);
      if (!editable() || t === null) return false;
      const span = spanAt(t, cell.rowId, cell.colId);
      return commands.mergeCells(cell, { rows: span?.rows ?? 1, cols: (span?.cols ?? 1) + 1 });
    },
    mergeDown(cell) {
      const t = map(cell.tableId);
      if (!editable() || t === null) return false;
      const span = spanAt(t, cell.rowId, cell.colId);
      return commands.mergeCells(cell, { rows: (span?.rows ?? 1) + 1, cols: span?.cols ?? 1 });
    },
    unmergeCells(cell) {
      const t = map(cell.tableId);
      if (!editable() || t === null) return false;
      const anchor = spanAt(t, cell.rowId, cell.colId) ?? spanCovering(t, cell.rowId, cell.colId);
      if (!unmergeCellsMutation(gd, cell.tableId, cell.rowId, cell.colId)) return false;
      if (anchor !== null)
        select({ tableId: cell.tableId, rowId: anchor.rowId, colId: anchor.colId });
      announce(`${addressOf(cell)} unmerged; the cells it covered are back`);
      return true;
    },
    restack(tableId, move) {
      const rec = record(tableId);
      if (!editable() || rec === null) return false;
      const to = restack(gd, tableId, move);
      if (to === null) {
        announce(
          move === 'back' || move === 'backward' ? 'Already at the back' : 'Already at the front',
        );
        return false;
      }
      announce(`${rec.title} moved ${STACKING_LABELS[move].toLowerCase()}`);
      return true;
    },
    setTablePinned(tableId, pinned) {
      const rec = record(tableId);
      if (!editable() || rec === null) return false;
      setTablePinned(gd, tableId, pinned);
      announce(pinned ? `${rec.title} pinned to the viewport` : `${rec.title} unpinned`);
      return true;
    },
    layoutSheet(sheetId, layout) {
      if (!editable()) return false;
      const moved = layoutSheet(gd, sheetId, layout);
      if (moved.length === 0) return false;
      announce(
        `${CANVAS_LAYOUT_LABELS[layout]}: ${String(moved.length)} ${moved.length === 1 ? 'table' : 'tables'} placed; addresses follow their tables`,
      );
      return true;
    },
    setSheetEdgesShown(sheetId, shown) {
      if (!editable()) return false;
      const ok = setSheetEdgesShown(gd, sheetId, shown);
      if (ok) announce(shown ? 'DAG edges shown' : 'DAG edges hidden');
      return ok;
    },
  };
  return settled(commands, deps.settle);
}
