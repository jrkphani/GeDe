/**
 * Context-menu entries (MENU-01..04), built as data so the same list serves
 * the pointer, the keyboard and the tests. Order and grouping follow desktop
 * spreadsheets, separators between kinds (MENU-01). A command that cannot
 * run is present and disabled with its reason (MENU-02) — including the
 * ones other Wave 2 work fills in:
 *
 *   slot: sort       → sort ascending/descending/options, quick filter/options
 *   slot: hierarchy  → add / remove / configure category
 *   slot: graph      → "Graph this table"
 */
import {
  cellAddress,
  cellKey,
  cellsMap,
  graphById,
  graphsInPair,
  isFormula,
  isLastSheet,
  isSheetLocked,
  listSections,
  lockReasonOfTable,
  sectionLockReason,
  mergeRoom,
  outlineColumnId,
  spanAt,
  setRangeColumn,
  spanCovering,
  splitOffer,
  tableById,
  tableMap,
  effectiveWrap,
  type GedeDoc,
  type GraphKind,
  type Id,
} from '@gede/core';
import type { MenuEntry } from '@gede/ui';

import { peekEngine } from '../../../doc/engine.js';
import { LABELS } from '../../../doc/shortcuts.js';
import { translate, type MessageKey, type MessageParams } from '../../../i18n/index.js';
import { activeLocale } from '../../../locale.js';
import { toFormatLocale } from '../cell/useCellFormat.js';
import type { GraphsActions } from '../graph/use-graphs.js';
import {
  columnRenameReason,
  readOnlyLabel,
  rowDeleteReason,
  type GridCommands,
} from '../grid/commands.js';
import type { RenameTarget } from '../grid/rename.js';
import type { CellClipboard } from '../keys/clipboard.js';
import { RENAME_KEYS, SHEET_KEYS } from '../keys/shortcut-map.js';
import { TRACKED } from '../inspector/controls.js';
import { fillColumnReason } from '../sets/set-tables.js';
import { LAST_SHEET_REASON } from '../sheets.js';
import {
  canMeasure,
  canvasMeasure,
  fitColumnsToContent,
  fitRowsToContent,
} from '../style/index.js';

const tm = (key: MessageKey, params?: MessageParams) => translate(activeLocale(), key, params);

export type MenuTarget =
  | { kind: 'cell'; tableId: Id; rowId: Id; colId: Id }
  | { kind: 'column'; tableId: Id; colId: Id }
  | { kind: 'table'; tableId: Id }
  /** ADR-047: a graph half — collapse or expand it, delete it or its pair. */
  | { kind: 'graph'; graphId: Id; pairId: Id }
  | { kind: 'sheet'; sheetId: Id }
  /** SET-17: a section's heading. */
  | { kind: 'section'; sheetId: Id; sectionId: Id }
  | { kind: 'canvas' };

/** What the other Wave 2 PRs mount; each `undefined` leaves its commands disabled with a reason. */
export interface MenuSlots {
  sort?:
    | {
        sortAscending: (tableId: Id, colId: Id) => void;
        sortDescending: (tableId: Id, colId: Id) => void;
        showSortOptions: (tableId: Id) => void;
        quickFilter: (tableId: Id, colId: Id) => void;
        showFilterOptions: (tableId: Id) => void;
      }
    | undefined;
  hierarchy?:
    | {
        isCategory: (tableId: Id, colId: Id) => boolean;
        addCategory: (tableId: Id, colId: Id) => void;
        removeCategory: (tableId: Id, colId: Id) => void;
        showCategoryOptions: (tableId: Id) => void;
      }
    | undefined;
  graph?: { graphTable: (tableId: Id) => void } | undefined;
}

export interface MenuContext {
  gd: GedeDoc;
  editable: boolean;
  commands: GridCommands;
  clipboard: CellClipboard;
  /** The selected cell, so a column or table menu can tell whether its table is already selected. */
  selectedCell: { tableId: Id; rowId: Id; colId: Id } | null;
  canvas: {
    addTable: () => void;
    /** GRAPH-01: the empty-sheet menu's Graph and Shaped table entries. */
    addGraph?: (() => void) | undefined;
    addShapedTable?: (() => void) | undefined;
    fit: () => void;
    actualSize: () => void;
  };
  /** The strip's + (`add`) and the tab's own commands (ADR-048). */
  sheets: {
    add: () => void;
    rename: (sheetId: Id) => void;
    remove: (sheetId: Id) => void;
  };
  /** KEYS-03 ⌘A / KEYS-08: the cell menu's "Select the table" (ADR-042). */
  selectTable?: ((tableId: Id) => void) | undefined;
  /**
   * ADR-051: open the inline name field on a table title or a column header —
   * the pointer route to Rename table and Rename column, whose home is the
   * Table tab. Absent where nothing can be written (phone, view-only).
   */
  rename?: ((target: RenameTarget) => void) | undefined;
  /**
   * ADR-047 / KEYS-08: ⌫'s pointer route on a table — the table, its cells and
   * its graph pairs go as one undo step; the shell moves focus afterwards.
   */
  deleteTable?: ((tableId: Id) => void) | undefined;
  /** SET-17, SET-18: Add section, Rename section…, Lock and Unlock. Absent where nothing can be written. */
  sections?:
    | {
        /** The sheet shown. */
        sheetId: Id | null;
        add: () => void;
        rename: (sheetId: Id, sectionId: Id) => void;
        setLocked: (sheetId: Id, sectionId: Id, locked: boolean) => void;
        setSheetLocked: (sheetId: Id, locked: boolean) => void;
      }
    | undefined;
  /** SET-10: open Fill column with formula… on a column. Absent where nothing can be written. */
  fillColumn?: ((tableId: Id, colId: Id) => void) | undefined;
  /** ADR-047: the graph menu's commands (the Graph tab is their home). */
  graphs?: Pick<GraphsActions, 'select' | 'remove' | 'removeHalf' | 'setCollapsed'> | undefined;
  slots?: MenuSlots | undefined;
}

const SORT_SOON = 'arrives with the sort and filter release';
const CATEGORY_SOON = 'arrives with the hierarchy release';
const GRAPH_SOON = TRACKED.graph;
const VIEW_ONLY = 'you have view-only access';

/**
 * SET-02: Split into rows, for a simple set's or a family's range cell — the menu route to
 * the offer a comma value raises, so the split stays reachable after the toast has gone.
 * Disabled with its reason when the cell holds one element or cannot be written.
 */
function splitEntries(ctx: MenuContext, tableId: Id, rowId: Id, colId: Id): MenuEntry[] {
  const record = tableById(ctx.gd, tableId);
  if (record === null || (record.kind !== 'simple' && record.kind !== 'family')) return [];
  if (setRangeColumn(record) !== colId) return [];
  const locale = activeLocale();
  const t = (key: MessageKey) => translate(locale, key);
  const readOnly = ctx.commands.readOnlyReason({ tableId, rowId, colId });
  const table = tableMap(ctx.gd, tableId);
  const formula = table !== null && isFormula(cellsMap(table).get(cellKey(rowId, colId)));
  return [
    {
      kind: 'item',
      id: 'split-rows',
      label: t('set.split.action'),
      disabledReason: !ctx.editable
        ? VIEW_ONLY
        : readOnly !== null
          ? translate(locale, 'cell.readOnly', { reason: readOnlyLabel(readOnly) })
          : formula
            ? t('set.split.formula')
            : splitOffer(ctx.gd, tableId, rowId, colId) === null
              ? t('set.split.single')
              : undefined,
      onSelect: () => {
        ctx.commands.splitIntoRows({ tableId, rowId, colId });
      },
    },
  ];
}

function sep(id: string): MenuEntry {
  return { kind: 'separator', id };
}

function clipboardEntries(ctx: MenuContext, cell: MenuTarget & { kind: 'cell' }): MenuEntry[] {
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const table = tableMap(ctx.gd, cell.tableId);
  const readOnly = table === null ? null : ctx.commands.readOnlyReason(cell);
  const locked = readOnly === null ? undefined : `${readOnly} cells are read-only`;
  return [
    {
      kind: 'item',
      id: 'cut',
      label: tm('menu.cut'),
      shortcut: LABELS.cut,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        void ctx.clipboard.cut();
      },
    },
    {
      kind: 'item',
      id: 'copy',
      label: tm('menu.copy'),
      shortcut: LABELS.copy,
      onSelect: () => {
        void ctx.clipboard.copy();
      },
    },
    {
      kind: 'item',
      id: 'copy-snapshot',
      label: tm('menu.copySnapshot'),
      onSelect: () => {
        void ctx.clipboard.copySnapshot();
      },
    },
    {
      kind: 'item',
      id: 'paste',
      label: tm('menu.paste'),
      shortcut: LABELS.paste,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        void ctx.clipboard.paste();
      },
    },
    {
      kind: 'item',
      id: 'paste-match',
      label: tm('menu.pasteAndMatchStyle'),
      shortcut: LABELS.pasteMatchStyle,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        void ctx.clipboard.pasteMatchStyle();
      },
    },
    {
      kind: 'item',
      id: 'clear',
      label: tm('menu.clearAll'),
      shortcut: LABELS.clear,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        ctx.commands.clearCell(cell);
      },
    },
  ];
}

/**
 * MENU-03 / REF-05 / INSP-10: the column menu's clipboard group acts on the
 * column the menu was opened on — every cell of it, one undo step — never on
 * the selected cell (#123). Each label says so. A derived, linked or pulled
 * column takes no write and says why; Copy still works (it reads what the
 * column shows).
 */
function columnClipboardEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'column' },
): MenuEntry[] {
  const column = ctx.clipboard.column;
  const scope = { tableId: target.tableId, colId: target.colId };
  const cut = column.reason(scope, 'cut');
  const paste = column.reason(scope, 'paste');
  return [
    {
      kind: 'item',
      id: 'cut',
      label: tm('menu.cutColumn'),
      disabledReason: cut,
      onSelect: () => {
        void column.cut(scope);
      },
    },
    {
      kind: 'item',
      id: 'copy',
      label: tm('menu.copyColumn'),
      disabledReason: column.reason(scope, 'copy'),
      onSelect: () => {
        void column.copy(scope);
      },
    },
    {
      kind: 'item',
      id: 'copy-snapshot',
      label: tm('menu.copyColumnSnapshot'),
      disabledReason: column.reason(scope, 'copy'),
      onSelect: () => {
        void column.copySnapshot(scope);
      },
    },
    {
      kind: 'item',
      id: 'paste',
      label: tm('menu.pasteIntoColumn'),
      disabledReason: paste,
      onSelect: () => {
        void column.paste(scope);
      },
    },
    {
      kind: 'item',
      id: 'paste-match',
      label: tm('menu.pasteIntoColumnAndMatchStyle'),
      disabledReason: paste,
      onSelect: () => {
        void column.pasteMatchStyle(scope);
      },
    },
    {
      kind: 'item',
      id: 'clear',
      label: tm('menu.clearColumn'),
      disabledReason: cut,
      onSelect: () => {
        column.clear(scope);
      },
    },
  ];
}

function sortFilterEntries(ctx: MenuContext, tableId: Id, colId: Id | null): MenuEntry[] {
  const sort = ctx.slots?.sort;
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const soon = sort === undefined ? SORT_SOON : undefined;
  const needsColumn = colId === null ? 'open the column menu to filter by it' : undefined;
  const out: MenuEntry[] = [];
  if (colId !== null) {
    out.push(
      {
        kind: 'item',
        id: 'sort-asc',
        label: tm('menu.sortAscending'),
        disabledReason: viewOnly ?? soon,
        onSelect: () => {
          sort?.sortAscending(tableId, colId);
        },
      },
      {
        kind: 'item',
        id: 'sort-desc',
        label: tm('menu.sortDescending'),
        disabledReason: viewOnly ?? soon,
        onSelect: () => {
          sort?.sortDescending(tableId, colId);
        },
      },
    );
  }
  out.push(
    {
      kind: 'item',
      id: 'sort-options',
      label: tm('menu.showSortOptions'),
      disabledReason: soon,
      onSelect: () => {
        sort?.showSortOptions(tableId);
      },
    },
    sep('s-filter'),
    {
      kind: 'item',
      id: 'quick-filter',
      label: tm('menu.quickFilter'),
      disabledReason: soon ?? needsColumn,
      onSelect: () => {
        if (colId !== null) sort?.quickFilter(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'filter-options',
      label: tm('menu.showFilterOptions'),
      disabledReason: soon,
      onSelect: () => {
        sort?.showFilterOptions(tableId);
      },
    },
  );
  return out;
}

function categoryEntries(ctx: MenuContext, tableId: Id, colId: Id | null, label: string) {
  const hier = ctx.slots?.hierarchy;
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const soon = hier === undefined ? CATEGORY_SOON : undefined;
  const out: MenuEntry[] = [];
  if (colId !== null) {
    const isCategory = hier?.isCategory(tableId, colId) === true;
    out.push(
      {
        kind: 'item',
        id: 'category-add',
        label: tm('menu.addCategoryForLabel', { label }),
        disabledReason: viewOnly ?? soon ?? (isCategory ? 'already a category' : undefined),
        onSelect: () => {
          hier?.addCategory(tableId, colId);
        },
      },
      {
        kind: 'item',
        id: 'category-remove',
        label: tm('menu.removeLabelCategory', { label }),
        disabledReason: viewOnly ?? soon ?? (isCategory ? undefined : 'not a category'),
        onSelect: () => {
          hier?.removeCategory(tableId, colId);
        },
      },
    );
  }
  out.push({
    kind: 'item',
    id: 'category-options',
    label: tm('menu.showCategoryOptions'),
    disabledReason: soon,
    onSelect: () => {
      hier?.showCategoryOptions(tableId);
    },
  });
  return out;
}

function graphEntry(ctx: MenuContext, tableId: Id): MenuEntry {
  return {
    kind: 'item',
    id: 'graph',
    label: tm('menu.graphThisTable'),
    disabledReason: ctx.slots?.graph === undefined ? GRAPH_SOON : undefined,
    onSelect: () => {
      ctx.slots?.graph?.graphTable(tableId);
    },
  };
}

/** MENU-04: the cell menu. */
/**
 * INSP-04 / MENU-03: fit one column's width to its widest cell, snapped to
 * whole units — the column menu's item, and (ADR-051) the cell menu's, so
 * the column can be fitted with the header row hidden (GRID-11) and no
 * column menu to open. Where no 2D canvas exists the item says so (MENU-02),
 * as the inspector's buttons do.
 */
function fitColumnEntry(ctx: MenuContext, tableId: Id, colId: Id, label: string): MenuEntry {
  const { gd, commands } = ctx;
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  return {
    kind: 'item',
    id: 'col-fit',
    label,
    disabledReason:
      viewOnly ?? (canMeasure() ? undefined : 'text cannot be measured in this browser'),
    onSelect: () => {
      const measure = canvasMeasure();
      const table = tableMap(gd, tableId);
      const record = tableById(gd, tableId);
      if (measure === null || table === null || record === null) return;
      const engine = peekEngine(gd.doc);
      commands.fitColumns(
        tableId,
        fitColumnsToContent(table, record, {
          locale: toFormatLocale(activeLocale()),
          measure,
          cellValue: (cellId) => engine?.result(cellId)?.value ?? undefined,
          only: [colId],
        }),
      );
    },
  };
}

export function cellMenuEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'cell' },
): MenuEntry[] {
  const { gd, commands } = ctx;
  const { tableId, rowId, colId } = target;
  const record = tableById(gd, tableId);
  const table = tableMap(gd, tableId);
  if (record === null || table === null) return [];
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const column = record.columns.find((c) => c.id === colId) ?? null;
  const columnIndex = record.columns.findIndex((c) => c.id === colId);
  const visibleBefore = record.columns.filter((c, i) => !c.hidden && i <= columnIndex).length;
  const frozenThrough = record.frozenColumns >= visibleBefore && visibleBefore > 0;
  const canFreeze = visibleBefore < record.columns.filter((c) => !c.hidden).length;
  const address = cellAddress(table, rowId, colId) ?? 'the cell';
  // ADR-049 / Numbers N8: the cell's Wrap Text — checked when the cell wraps, whichever
  // scope decides it; a change writes the cell's own override (a route to the Text tab at cell scope).
  const cellWraps = effectiveWrap(table, column, rowId, record.look.wrap);
  const span = spanAt(table, rowId, colId);
  const covered = spanCovering(table, rowId, colId);
  const room = mergeRoom(record, rowId, colId);
  return [
    graphEntry(ctx, tableId),
    sep('s-freeze'),
    {
      kind: 'check',
      id: 'freeze-rows',
      label: tm('menu.freezeHeaderRow'),
      checked: record.headerRows === 1,
      disabledReason: viewOnly,
      onCheckedChange: (on) => {
        commands.setHeaderRows(tableId, on ? 1 : 0);
      },
    },
    {
      kind: 'check',
      id: 'freeze-columns',
      label: tm('menu.freezeColumnsThroughLabel', { label: column?.label ?? address }),
      checked: frozenThrough,
      disabledReason:
        viewOnly ?? (canFreeze ? undefined : 'freezing every column would leave nothing to scroll'),
      onCheckedChange: (on) => {
        commands.setFrozenColumns(tableId, on ? visibleBefore : 0);
      },
    },
    sep('s-insert'),
    {
      kind: 'item',
      id: 'row-above',
      label: tm('menu.addRowAbove'),
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertRowAbove(tableId, rowId);
      },
    },
    {
      kind: 'item',
      id: 'row-below',
      label: tm('menu.addRowBelow'),
      shortcut: LABELS.addRow,
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertRowBelow(tableId, rowId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-before',
      label: tm('menu.addColumnBefore'),
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnBefore(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-after',
      label: tm('menu.addColumnAfter'),
      shortcut: LABELS.addColumn,
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnAfter(tableId, colId);
      },
    },
    ...splitEntries(ctx, tableId, rowId, colId),
    sep('s-delete'),
    {
      kind: 'item',
      id: 'row-delete',
      label: tm('menu.deleteRow'),
      danger: true,
      disabledReason:
        viewOnly ??
        rowDeleteReason(gd, tableId, rowId) ??
        (record.rows.length <= 1 ? 'a table keeps at least one row' : undefined),
      onSelect: () => {
        commands.deleteRow(tableId, rowId);
      },
    },
    {
      kind: 'item',
      id: 'col-delete',
      label: tm('menu.deleteColumn'),
      danger: true,
      disabledReason:
        viewOnly ?? (record.columns.length <= 1 ? 'a table keeps at least one column' : undefined),
      onSelect: () => {
        commands.deleteColumn(tableId, colId);
      },
    },
    sep('s-sort'),
    ...sortFilterEntries(ctx, tableId, null),
    sep('s-category'),
    ...categoryEntries(ctx, tableId, null, column?.label ?? ''),
    sep('s-merge'),
    // MENU-04: merge controls. A merge is a visual span from this cell (the covered cells keep
    // their addresses and data); with one cell selected the span grows a column or a row at a time.
    {
      kind: 'item',
      id: 'merge-right',
      label: tm('menu.mergeWithCellToTheRight'),
      disabledReason:
        viewOnly ??
        (covered !== null
          ? 'this cell is inside a merged cell'
          : room !== null && (span?.cols ?? 1) >= room.cols
            ? 'no column to the right'
            : undefined),
      onSelect: () => {
        commands.mergeRight({ tableId, rowId, colId });
      },
    },
    {
      kind: 'item',
      id: 'merge-down',
      label: tm('menu.mergeWithCellBelow'),
      disabledReason:
        viewOnly ??
        (covered !== null
          ? 'this cell is inside a merged cell'
          : room !== null && (span?.rows ?? 1) >= room.rows
            ? 'no row below'
            : undefined),
      onSelect: () => {
        commands.mergeDown({ tableId, rowId, colId });
      },
    },
    {
      kind: 'item',
      id: 'unmerge',
      label: tm('menu.unmergeCells'),
      disabledReason:
        viewOnly ?? (span === null && covered === null ? 'the cell is not merged' : undefined),
      onSelect: () => {
        commands.unmergeCells({ tableId, rowId, colId });
      },
    },
    sep('s-clipboard'),
    ...clipboardEntries(ctx, target),
    {
      // KEYS-08: ⌘A's pointer route. ⌘A selects the table — the object — since the grid has
      // no range selection (ADR-042).
      kind: 'item',
      id: 'select-all',
      label: tm('menu.selectTheTable'),
      shortcut: LABELS.selectAll,
      disabledReason: ctx.selectTable === undefined ? 'select a cell first' : undefined,
      onSelect: () => {
        ctx.selectTable?.(tableId);
      },
    },
    sep('s-wrap'),
    {
      kind: 'check',
      id: 'wrap',
      // MENU-04 / ADR-049 (Numbers N8): checked when this cell wraps (cell > row > column >
      // table). A change writes the cell's own override, so the item's state always answers
      // the click and no other cell moves; the Text tab says which scope decides it.
      label: tm('menu.wrapText'),
      checked: cellWraps,
      disabledReason: viewOnly,
      onCheckedChange: (on) => {
        commands.setCellAppearance({ tableId, rowId, colId }, { wrap: on });
      },
    },
    {
      kind: 'item',
      id: 'row-fit',
      label: tm('menu.fitRowHeightToContent'),
      // #167 criterion 5: the row's fit, from the cell's menu (GeDe has no row menu). Where
      // no 2D canvas exists the item says so (MENU-02), as the inspector's buttons do.
      disabledReason:
        viewOnly ?? (canMeasure() ? undefined : 'text cannot be measured in this browser'),
      onSelect: () => {
        const measure = canvasMeasure();
        if (measure === null) return;
        const engine = peekEngine(gd.doc);
        commands.fitRows(
          tableId,
          fitRowsToContent(table, record, {
            locale: toFormatLocale(activeLocale()),
            measure,
            cellValue: (cellId) => engine?.result(cellId)?.value ?? undefined,
            only: [rowId],
          }),
        );
      },
    },
    fitColumnEntry(ctx, tableId, colId, tm('menu.fitColumnWidthToContent')),
  ];
}

/** MENU-03: the column (header) menu. */
export function columnMenuEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'column' },
): MenuEntry[] {
  const { gd, commands } = ctx;
  const { tableId, colId } = target;
  const record = tableById(gd, tableId);
  if (record === null) return [];
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const column = record.columns.find((c) => c.id === colId);
  if (column === undefined) return [];
  const columnIndex = record.columns.indexOf(column);
  const visibleBefore = record.columns.filter((c, i) => !c.hidden && i <= columnIndex).length;
  const visibleCount = record.columns.filter((c) => !c.hidden).length;
  const frozenThrough = record.frozenColumns >= visibleBefore;
  const canFreeze = visibleBefore < visibleCount;
  return [
    graphEntry(ctx, tableId),
    sep('s-freeze'),
    {
      kind: 'check',
      id: 'freeze-columns',
      label: tm('menu.freezeColumnsThroughLabel', { label: column.label }),
      checked: frozenThrough,
      disabledReason:
        viewOnly ?? (canFreeze ? undefined : 'freezing every column would leave nothing to scroll'),
      onCheckedChange: (on) => {
        commands.setFrozenColumns(tableId, on ? visibleBefore : 0);
      },
    },
    {
      // HIER-04 / ADR-052: the table's default outline column; off returns to the first visible
      // column, so on the implicit first visible column there is nothing to uncheck.
      kind: 'check',
      id: 'outline-column',
      label: tm('menu.useAsOutlineColumn'),
      checked: outlineColumnId(record) === colId,
      disabledReason:
        viewOnly ??
        (record.outlineColumn === null && outlineColumnId(record) === colId
          ? 'Already the first visible column'
          : undefined),
      onCheckedChange: (on) => {
        commands.setOutlineColumn(tableId, on ? colId : null);
      },
    },
    sep('s-sort'),
    ...sortFilterEntries(ctx, tableId, colId),
    sep('s-category'),
    ...categoryEntries(ctx, tableId, colId, column.label),
    sep('s-insert'),
    {
      kind: 'item',
      id: 'col-before',
      label: tm('menu.addColumnBefore'),
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnBefore(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-after',
      label: tm('menu.addColumnAfter'),
      shortcut: LABELS.addColumn,
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnAfter(tableId, colId);
      },
    },
    {
      // ADR-051 / MENU-03: the route to the header's inline name field (the Table tab's Name
      // field is the home). A column whose label is its lineage says why (MENU-02).
      kind: 'item',
      id: 'col-rename',
      label: tm('menu.renameColumn'),
      shortcut: RENAME_KEYS.rename,
      disabledReason:
        viewOnly ?? (ctx.rename === undefined ? VIEW_ONLY : columnRenameReason(column)),
      onSelect: () => {
        ctx.rename?.({ kind: 'column', tableId, colId });
      },
    },
    {
      // SET-10 / MENU-03 (ADR-056): the one route to a computed column, on an empty column.
      kind: 'item',
      id: 'col-fill',
      label: translate(activeLocale(), 'fill.menu'),
      disabledReason:
        viewOnly ??
        (ctx.fillColumn === undefined ? VIEW_ONLY : fillColumnReason(gd, tableId, colId)),
      onSelect: () => {
        ctx.fillColumn?.(tableId, colId);
      },
    },
    sep('s-delete'),
    {
      kind: 'item',
      id: 'col-delete',
      label: tm('menu.deleteColumn'),
      danger: true,
      disabledReason:
        viewOnly ?? (record.columns.length <= 1 ? 'a table keeps at least one column' : undefined),
      onSelect: () => {
        commands.deleteColumn(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-hide',
      label: tm('menu.hideColumn'),
      disabledReason: viewOnly ?? (visibleCount <= 1 ? 'the last visible column stays' : undefined),
      onSelect: () => {
        commands.hideColumn(tableId, colId);
      },
    },
    fitColumnEntry(ctx, tableId, colId, tm('menu.fitWidthToContent')),
    sep('s-clipboard'),
    ...columnClipboardEntries(ctx, target),
    sep('s-wrap'),
    {
      kind: 'check',
      id: 'wrap',
      // ADR-049: the column's scope — checked when the column wraps by its own key or the
      // table's default; a change writes the column's key.
      label: tm('menu.wrapText'),
      checked: column.wrap ?? record.look.wrap,
      disabledReason: viewOnly,
      onCheckedChange: (on) => {
        commands.setColumnWrap(tableId, colId, on);
      },
    },
  ];
}

/** ADR-047: what the delete items call a half. */
function halfLabel(kind: GraphKind): string {
  return tm(kind === 'ring' ? 'menu.deleteRing' : 'menu.deleteCoverage');
}

/**
 * ADR-047: the graph half's menu — a route to the Graph tab's collapse and
 * delete controls (DOC-02, ADR-041): collapse or expand this half; delete this
 * half or the pair; Fit and Actual size (MENU-01 order, MENU-02 reasons).
 */
export function graphMenuEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'graph' },
): MenuEntry[] {
  const graph = graphById(ctx.gd, target.graphId);
  if (graph === null) return [];
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const soon = ctx.graphs === undefined ? GRAPH_SOON : undefined;
  const other = graphsInPair(ctx.gd, graph.pairId).find((g) => g.id !== graph.id);
  return [
    {
      kind: 'item',
      id: 'collapse',
      label: tm(graph.collapsed ? 'menu.expand' : 'menu.collapse'),
      shortcut: graph.collapsed ? LABELS.expand : LABELS.collapse,
      disabledReason: viewOnly ?? soon,
      onSelect: () => {
        ctx.graphs?.setCollapsed(graph.id, !graph.collapsed);
      },
    },
    sep('s-delete'),
    {
      kind: 'item',
      id: 'delete-half',
      label: halfLabel(graph.kind),
      shortcut: LABELS.clear,
      danger: true,
      disabledReason: viewOnly ?? soon,
      onSelect: () => {
        ctx.graphs?.removeHalf(graph.pairId, graph.kind);
      },
    },
    {
      kind: 'item',
      id: 'delete-pair',
      label: tm('menu.deleteGraphPair'),
      danger: true,
      disabledReason:
        viewOnly ?? soon ?? (other === undefined ? 'this is the only half left' : undefined),
      onSelect: () => {
        ctx.graphs?.remove(graph.pairId);
      },
    },
    sep('s-view'),
    {
      kind: 'item',
      id: 'fit',
      label: tm('menu.fitToCanvas'),
      shortcut: LABELS.fit,
      onSelect: ctx.canvas.fit,
    },
    {
      kind: 'item',
      id: 'actual',
      label: tm('menu.actualSize'),
      shortcut: LABELS.actualSize,
      onSelect: ctx.canvas.actualSize,
    },
  ];
}

/** The table title's menu: structure commands that need no cell. */
export function tableMenuEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'table' },
): MenuEntry[] {
  const record = tableById(ctx.gd, target.tableId);
  if (record === null) return [];
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  return [
    graphEntry(ctx, target.tableId),
    sep('s-insert'),
    {
      kind: 'item',
      id: 'row-append',
      label: tm('menu.addRow'),
      shortcut: LABELS.addRow,
      disabledReason: viewOnly,
      onSelect: () => {
        ctx.commands.insertRowBelow(target.tableId);
      },
    },
    {
      kind: 'item',
      id: 'col-append',
      label: tm('menu.addColumn'),
      shortcut: LABELS.addColumn,
      disabledReason: viewOnly,
      onSelect: () => {
        ctx.commands.insertColumnAfter(target.tableId);
      },
    },
    sep('s-rename'),
    {
      // ADR-051: the route to the title bar's inline field; the Table tab's Title text is the home.
      kind: 'item',
      id: 'table-rename',
      label: tm('menu.renameTable'),
      shortcut: RENAME_KEYS.rename,
      disabledReason: viewOnly ?? (ctx.rename === undefined ? VIEW_ONLY : undefined),
      onSelect: () => {
        ctx.rename?.({ kind: 'table', tableId: target.tableId });
      },
    },
    sep('s-delete'),
    {
      // ADR-047 / KEYS-08: ⌫'s pointer route; the Table menu in the toolbar is the home.
      kind: 'item',
      id: 'table-delete',
      label: tm('menu.deleteTable'),
      shortcut: LABELS.clear,
      danger: true,
      disabledReason:
        viewOnly ?? (ctx.deleteTable === undefined ? 'select a table first' : undefined),
      onSelect: () => {
        ctx.deleteTable?.(target.tableId);
      },
    },
    sep('s-view'),
    {
      kind: 'item',
      id: 'fit',
      label: tm('menu.fitToCanvas'),
      shortcut: LABELS.fit,
      onSelect: ctx.canvas.fit,
    },
  ];
}

const lockText = (reason: 'sheet' | 'section'): string =>
  translate(activeLocale(), reason === 'sheet' ? 'readOnly.sheetLocked' : 'readOnly.sectionLocked');

/** SET-17: Add section, on the canvas menu; disabled with its reason on a locked sheet. */
function sectionAddEntries(ctx: MenuContext): MenuEntry[] {
  if (ctx.sections === undefined) return [];
  const { sheetId } = ctx.sections;
  return [
    sep('s-section'),
    {
      kind: 'item',
      id: 'section-add',
      label: translate(activeLocale(), 'section.add'),
      disabledReason:
        (ctx.editable ? undefined : VIEW_ONLY) ??
        (sheetId !== null && isSheetLocked(ctx.gd, sheetId) ? lockText('sheet') : undefined),
      onSelect: ctx.sections.add,
    },
  ];
}

/**
 * SET-17, SET-18: a section heading's menu — Rename section… and Lock section / Unlock
 * section. Rename is disabled with “the section is locked” or “the sheet is locked”; Unlock
 * is always available to anyone who can edit (SPEC §7 v1 default 5).
 */
export function sectionMenuEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'section' },
): MenuEntry[] {
  const section = listSections(ctx.gd, target.sheetId).find((s) => s.id === target.sectionId);
  if (section === undefined || ctx.sections === undefined) return [];
  const sections = ctx.sections;
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const lock = sectionLockReason(ctx.gd, target.sheetId, target.sectionId);
  const t = (key: MessageKey) => translate(activeLocale(), key);
  return [
    {
      kind: 'item',
      id: 'section-rename',
      label: t('section.rename'),
      disabledReason: viewOnly ?? (lock === null ? undefined : lockText(lock)),
      onSelect: () => {
        sections.rename(target.sheetId, target.sectionId);
      },
    },
    sep('s-lock'),
    {
      kind: 'item',
      id: 'section-lock',
      label: t(section.locked ? 'lock.sectionOff' : 'lock.section'),
      disabledReason: viewOnly,
      onSelect: () => {
        sections.setLocked(target.sheetId, target.sectionId, !section.locked);
      },
    },
  ];
}

/** Empty canvas: place a table here, view commands. */
export function canvasMenuEntries(ctx: MenuContext): MenuEntry[] {
  const sheetId = ctx.sections?.sheetId ?? null;
  const viewOnly = ctx.editable
    ? sheetId !== null && isSheetLocked(ctx.gd, sheetId)
      ? lockText('sheet')
      : undefined
    : VIEW_ONLY;
  return [
    {
      kind: 'item',
      id: 'add-table',
      label: tm('menu.addTableHere'),
      disabledReason: viewOnly,
      onSelect: ctx.canvas.addTable,
    },
    {
      kind: 'item',
      id: 'add-shaped-table',
      label: tm('menu.addShapedTableHere'),
      disabledReason:
        viewOnly ?? (ctx.canvas.addShapedTable === undefined ? GRAPH_SOON : undefined),
      onSelect: () => {
        ctx.canvas.addShapedTable?.();
      },
    },
    {
      kind: 'item',
      id: 'add-graph',
      label: tm('menu.addGraphHere'),
      disabledReason: viewOnly ?? (ctx.canvas.addGraph === undefined ? GRAPH_SOON : undefined),
      onSelect: () => {
        ctx.canvas.addGraph?.();
      },
    },
    ...sectionAddEntries(ctx),
    sep('s-view'),
    {
      kind: 'item',
      id: 'fit',
      label: tm('menu.fitToCanvas'),
      shortcut: LABELS.fit,
      onSelect: ctx.canvas.fit,
    },
    {
      kind: 'item',
      id: 'actual',
      label: tm('menu.actualSize'),
      shortcut: LABELS.actualSize,
      onSelect: ctx.canvas.actualSize,
    },
  ];
}

/**
 * The sheet tab's menu (DOC-03, ADR-048, #165): the home of Rename sheet and
 * Delete sheet — the tab is the only thing on screen that is the sheet — and
 * a route to Add sheet (the strip's + is its home). F2, ⌫ and double-click
 * are routes (KEYS-08). Desktop order with separators between kinds
 * (MENU-01); the last sheet's Delete is present and disabled with the reason
 * (MENU-02). The stubs of the first cut (#79) were removed as requirement-
 * less in 362b0e1; the owner's request is that requirement.
 */
export function sheetMenuEntries(
  ctx: MenuContext,
  target: MenuTarget & { kind: 'sheet' },
): MenuEntry[] {
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  return [
    {
      kind: 'item',
      id: 'sheet-add',
      label: tm('menu.addSheet'),
      disabledReason: viewOnly,
      onSelect: ctx.sheets.add,
    },
    sep('s-rename'),
    {
      kind: 'item',
      id: 'sheet-rename',
      label: tm('menu.renameSheet'),
      shortcut: SHEET_KEYS.rename,
      disabledReason: viewOnly,
      onSelect: () => {
        ctx.sheets.rename(target.sheetId);
      },
    },
    ...(ctx.sections === undefined
      ? []
      : [
          sep('s-lock'),
          {
            kind: 'item' as const,
            id: 'sheet-lock',
            label: translate(
              activeLocale(),
              isSheetLocked(ctx.gd, target.sheetId) ? 'lock.sheetOff' : 'lock.sheet',
            ),
            disabledReason: viewOnly,
            onSelect: () => {
              ctx.sections?.setSheetLocked(target.sheetId, !isSheetLocked(ctx.gd, target.sheetId));
            },
          },
        ]),
    sep('s-delete'),
    {
      kind: 'item',
      id: 'sheet-delete',
      label: tm('menu.deleteSheet'),
      shortcut: SHEET_KEYS.remove,
      danger: true,
      disabledReason:
        viewOnly ??
        (isSheetLocked(ctx.gd, target.sheetId) ? lockText('sheet') : undefined) ??
        (isLastSheet(ctx.gd) ? LAST_SHEET_REASON : undefined),
      onSelect: () => {
        ctx.sheets.remove(target.sheetId);
      },
    },
  ];
}

/**
 * SET-18: a table in a locked section or sheet reads as view-only for its menus — every
 * command that writes is disabled — but says why: “the section is locked”, “the sheet is
 * locked” in place of “you have view-only access”.
 */
function lockedEntries(ctx: MenuContext, build: (ctx: MenuContext) => MenuEntry[], tableId: Id) {
  const reason = ctx.editable ? lockReasonOfTable(ctx.gd, tableId) : null;
  if (reason === null) return build(ctx);
  const text = lockText(reason);
  const swap = (disabledReason: string | undefined) =>
    disabledReason === VIEW_ONLY ? text : disabledReason;
  return build({ ...ctx, editable: false }).map((entry): MenuEntry => {
    switch (entry.kind) {
      case 'item':
      case 'check':
        return { ...entry, disabledReason: swap(entry.disabledReason) };
      case 'radio':
        return {
          ...entry,
          options: entry.options.map((o) => ({ ...o, disabledReason: swap(o.disabledReason) })),
        };
      case 'separator':
        return entry;
    }
  });
}

export function menuEntriesFor(ctx: MenuContext, target: MenuTarget): MenuEntry[] {
  switch (target.kind) {
    case 'cell':
      return lockedEntries(ctx, (c) => cellMenuEntries(c, target), target.tableId);
    case 'column':
      return lockedEntries(ctx, (c) => columnMenuEntries(c, target), target.tableId);
    case 'table':
      return lockedEntries(ctx, (c) => tableMenuEntries(c, target), target.tableId);
    case 'graph':
      return graphMenuEntries(ctx, target);
    case 'sheet':
      return sheetMenuEntries(ctx, target);
    case 'section':
      return sectionMenuEntries(ctx, target);
    case 'canvas':
      return canvasMenuEntries(ctx);
  }
}

/** Accessible name for the open menu. */
export function menuLabelFor(target: MenuTarget): string {
  switch (target.kind) {
    case 'cell':
      return 'Cell menu';
    case 'column':
      return 'Column menu';
    case 'table':
      return 'Table menu';
    case 'graph':
      return 'Graph menu';
    case 'sheet':
      return 'Sheet menu';
    case 'section':
      return 'Section menu';
    case 'canvas':
      return 'Canvas menu';
  }
}
