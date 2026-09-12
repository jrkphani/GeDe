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
  rowMeta,
  tableById,
  tableMap,
  WRAPPED_ROW_HEIGHT,
  type GedeDoc,
  type Id,
} from '@gede/core';
import type { MenuEntry } from '@gede/ui';

import { LABELS } from '../../../doc/shortcuts.js';
import type { GridCommands } from '../grid/commands.js';
import type { CellClipboard } from '../keys/clipboard.js';
import { TRACKED } from '../inspector/controls.js';

export type MenuTarget =
  | { kind: 'cell'; tableId: Id; rowId: Id; colId: Id }
  | { kind: 'column'; tableId: Id; colId: Id }
  | { kind: 'table'; tableId: Id }
  | { kind: 'sheet'; sheetId: Id }
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
  /** The selected cell's address, for clipboard reasons. */
  selectedCell: { tableId: Id; rowId: Id; colId: Id } | null;
  canvas: {
    addTable: () => void;
    /** GRAPH-01: the empty-sheet menu's Graph and Shaped table entries. */
    addGraph?: (() => void) | undefined;
    addShapedTable?: (() => void) | undefined;
    fit: () => void;
    actualSize: () => void;
  };
  sheets: {
    add: () => void;
  };
  slots?: MenuSlots | undefined;
}

const SORT_SOON = 'arrives with the sort and filter release';
const CATEGORY_SOON = 'arrives with the hierarchy release';
const GRAPH_SOON = TRACKED.graph;
const VIEW_ONLY = 'you have view-only access';

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
      label: 'Cut',
      shortcut: LABELS.cut,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        void ctx.clipboard.cut();
      },
    },
    {
      kind: 'item',
      id: 'copy',
      label: 'Copy',
      shortcut: LABELS.copy,
      onSelect: () => {
        void ctx.clipboard.copy();
      },
    },
    {
      kind: 'item',
      id: 'copy-snapshot',
      label: 'Copy snapshot',
      onSelect: () => {
        void ctx.clipboard.copySnapshot();
      },
    },
    {
      kind: 'item',
      id: 'paste',
      label: 'Paste',
      shortcut: LABELS.paste,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        void ctx.clipboard.paste();
      },
    },
    {
      kind: 'item',
      id: 'paste-match',
      label: 'Paste and match style',
      shortcut: LABELS.pasteMatchStyle,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        void ctx.clipboard.pasteMatchStyle();
      },
    },
    {
      kind: 'item',
      id: 'clear',
      label: 'Clear all',
      shortcut: LABELS.clear,
      disabledReason: viewOnly ?? locked,
      onSelect: () => {
        ctx.commands.clearCell(cell);
      },
    },
  ];
}

function sortFilterEntries(ctx: MenuContext, tableId: Id, colId: Id | null): MenuEntry[] {
  const sort = ctx.slots?.sort;
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  const soon = sort === undefined ? SORT_SOON : undefined;
  const needsColumn = colId === null ? 'open the column menu to sort by it' : undefined;
  const out: MenuEntry[] = [];
  if (colId !== null) {
    out.push(
      {
        kind: 'item',
        id: 'sort-asc',
        label: 'Sort ascending',
        disabledReason: viewOnly ?? soon,
        onSelect: () => {
          sort?.sortAscending(tableId, colId);
        },
      },
      {
        kind: 'item',
        id: 'sort-desc',
        label: 'Sort descending',
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
      label: 'Show sort options',
      disabledReason: soon,
      onSelect: () => {
        sort?.showSortOptions(tableId);
      },
    },
    sep('s-filter'),
    {
      kind: 'item',
      id: 'quick-filter',
      label: 'Quick filter…',
      disabledReason: soon ?? needsColumn,
      onSelect: () => {
        if (colId !== null) sort?.quickFilter(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'filter-options',
      label: 'Show filter options',
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
        label: `Add category for ${label}`,
        disabledReason: viewOnly ?? soon ?? (isCategory ? 'already a category' : undefined),
        onSelect: () => {
          hier?.addCategory(tableId, colId);
        },
      },
      {
        kind: 'item',
        id: 'category-remove',
        label: `Remove ${label} category`,
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
    label: 'Show category options',
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
    label: 'Graph this table',
    disabledReason: ctx.slots?.graph === undefined ? GRAPH_SOON : undefined,
    onSelect: () => {
      ctx.slots?.graph?.graphTable(tableId);
    },
  };
}

/** MENU-04: the cell menu. */
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
  const rowWrapped = rowMeta(table, rowId).height === WRAPPED_ROW_HEIGHT;
  return [
    graphEntry(ctx, tableId),
    sep('s-freeze'),
    {
      kind: 'check',
      id: 'freeze-rows',
      label: 'Freeze header row',
      checked: record.headerRows === 1,
      disabledReason: viewOnly,
      onCheckedChange: (on) => {
        commands.setHeaderRows(tableId, on ? 1 : 0);
      },
    },
    {
      kind: 'check',
      id: 'freeze-columns',
      label: `Freeze columns through ${column?.label ?? address}`,
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
      label: 'Add row above',
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertRowAbove(tableId, rowId);
      },
    },
    {
      kind: 'item',
      id: 'row-below',
      label: 'Add row below',
      shortcut: LABELS.addRow,
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertRowBelow(tableId, rowId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-before',
      label: 'Add column before',
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnBefore(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-after',
      label: 'Add column after',
      shortcut: LABELS.addColumn,
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnAfter(tableId, colId);
      },
    },
    sep('s-delete'),
    {
      kind: 'item',
      id: 'row-delete',
      label: 'Delete row',
      danger: true,
      disabledReason:
        viewOnly ?? (record.rows.length <= 1 ? 'a table keeps at least one row' : undefined),
      onSelect: () => {
        commands.deleteRow(tableId, rowId);
      },
    },
    {
      kind: 'item',
      id: 'col-delete',
      label: 'Delete column',
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
    {
      kind: 'item',
      id: 'merge',
      label: 'Merge cells',
      disabledReason: TRACKED.merge,
      onSelect: () => undefined,
    },
    {
      kind: 'item',
      id: 'unmerge',
      label: 'Unmerge cells',
      disabledReason: TRACKED.merge,
      onSelect: () => undefined,
    },
    sep('s-clipboard'),
    ...clipboardEntries(ctx, target),
    sep('s-wrap'),
    {
      kind: 'check',
      id: 'wrap',
      // MENU-04: the cell's wrap is its column's or its row's (GRID-09). On, it wraps the
      // column; off, it unwraps whichever is wrapping this cell — the row alone when only
      // the row is, both when both are — so the item's state always answers the click.
      label: column?.wrap === true ? 'Wrap text' : rowWrapped ? 'Wrap text (row)' : 'Wrap text',
      checked: column?.wrap === true || rowWrapped,
      disabledReason: viewOnly,
      onCheckedChange: (on) => {
        if (on) {
          commands.setColumnWrap(tableId, colId, true);
          return;
        }
        if (column?.wrap === true) commands.setColumnWrap(tableId, colId, false);
        if (rowWrapped) commands.setRowWrap(tableId, rowId, false);
      },
    },
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
  const selected = ctx.selectedCell;
  const cellHere: (MenuTarget & { kind: 'cell' }) | null =
    selected !== null && selected.tableId === tableId
      ? { kind: 'cell', tableId, rowId: selected.rowId, colId: selected.colId }
      : null;
  return [
    graphEntry(ctx, tableId),
    sep('s-freeze'),
    {
      kind: 'check',
      id: 'freeze-columns',
      label: `Freeze columns through ${column.label}`,
      checked: frozenThrough,
      disabledReason:
        viewOnly ?? (canFreeze ? undefined : 'freezing every column would leave nothing to scroll'),
      onCheckedChange: (on) => {
        commands.setFrozenColumns(tableId, on ? visibleBefore : 0);
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
      label: 'Add column before',
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnBefore(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-after',
      label: 'Add column after',
      shortcut: LABELS.addColumn,
      disabledReason: viewOnly,
      onSelect: () => {
        commands.insertColumnAfter(tableId, colId);
      },
    },
    sep('s-delete'),
    {
      kind: 'item',
      id: 'col-delete',
      label: 'Delete column',
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
      label: 'Hide column',
      disabledReason: viewOnly ?? (visibleCount <= 1 ? 'the last visible column stays' : undefined),
      onSelect: () => {
        commands.hideColumn(tableId, colId);
      },
    },
    {
      kind: 'item',
      id: 'col-fit',
      label: 'Fit width to content',
      disabledReason: TRACKED.tableAppearance,
      onSelect: () => undefined,
    },
    sep('s-clipboard'),
    ...(cellHere === null
      ? [
          {
            kind: 'item' as const,
            id: 'copy',
            label: 'Copy',
            shortcut: LABELS.copy,
            disabledReason: 'select a cell in this table first',
            onSelect: () => undefined,
          },
        ]
      : clipboardEntries(ctx, cellHere)),
    sep('s-wrap'),
    {
      kind: 'check',
      id: 'wrap',
      label: 'Wrap text',
      checked: column.wrap,
      disabledReason: viewOnly,
      onCheckedChange: (on) => {
        commands.setColumnWrap(tableId, colId, on);
      },
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
      label: 'Add row',
      shortcut: LABELS.addRow,
      disabledReason: viewOnly,
      onSelect: () => {
        ctx.commands.insertRowBelow(target.tableId);
      },
    },
    {
      kind: 'item',
      id: 'col-append',
      label: 'Add column',
      shortcut: LABELS.addColumn,
      disabledReason: viewOnly,
      onSelect: () => {
        ctx.commands.insertColumnAfter(target.tableId);
      },
    },
    sep('s-view'),
    {
      kind: 'item',
      id: 'fit',
      label: 'Fit to canvas',
      shortcut: LABELS.fit,
      onSelect: ctx.canvas.fit,
    },
  ];
}

/** Empty canvas: place a table here, view commands. */
export function canvasMenuEntries(ctx: MenuContext): MenuEntry[] {
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  return [
    {
      kind: 'item',
      id: 'add-table',
      label: 'Add table here',
      disabledReason: viewOnly,
      onSelect: ctx.canvas.addTable,
    },
    {
      kind: 'item',
      id: 'add-shaped-table',
      label: 'Add shaped table here',
      disabledReason:
        viewOnly ?? (ctx.canvas.addShapedTable === undefined ? GRAPH_SOON : undefined),
      onSelect: () => {
        ctx.canvas.addShapedTable?.();
      },
    },
    {
      kind: 'item',
      id: 'add-graph',
      label: 'Add graph here',
      disabledReason: viewOnly ?? (ctx.canvas.addGraph === undefined ? GRAPH_SOON : undefined),
      onSelect: () => {
        ctx.canvas.addGraph?.();
      },
    },
    sep('s-view'),
    {
      kind: 'item',
      id: 'fit',
      label: 'Fit to canvas',
      shortcut: LABELS.fit,
      onSelect: ctx.canvas.fit,
    },
    {
      kind: 'item',
      id: 'actual',
      label: 'Actual size',
      shortcut: LABELS.actualSize,
      onSelect: ctx.canvas.actualSize,
    },
  ];
}

/** The sheet-tab menu (DOC-03): what the strip's trailing + does. Rename and delete have no requirement yet. */
export function sheetMenuEntries(ctx: MenuContext): MenuEntry[] {
  const viewOnly = ctx.editable ? undefined : VIEW_ONLY;
  return [
    {
      kind: 'item',
      id: 'sheet-add',
      label: 'Add sheet',
      disabledReason: viewOnly,
      onSelect: ctx.sheets.add,
    },
  ];
}

export function menuEntriesFor(ctx: MenuContext, target: MenuTarget): MenuEntry[] {
  switch (target.kind) {
    case 'cell':
      return cellMenuEntries(ctx, target);
    case 'column':
      return columnMenuEntries(ctx, target);
    case 'table':
      return tableMenuEntries(ctx, target);
    case 'sheet':
      return sheetMenuEntries(ctx);
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
    case 'sheet':
      return 'Sheet menu';
    case 'canvas':
      return 'Canvas menu';
  }
}
