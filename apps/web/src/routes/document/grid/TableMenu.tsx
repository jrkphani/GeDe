import { rowMeta, tableById, tableMap, WRAPPED_ROW_HEIGHT, type GedeDoc } from '@gede/core';
import { Button, Menu, type MenuEntry } from '@gede/ui';

import { LABELS } from '../../../doc/shortcuts.js';
import type { CellSelection, Selection } from '../../../doc/selection.js';
import { useYVersion } from '../../../doc/use-y.js';
import type { GridCommands } from './commands.js';

export interface TableMenuProps {
  gd: GedeDoc;
  selection: Selection | null;
  editable: boolean;
  commands: GridCommands;
}

/** Frozen-column choices offered: none, or one to three (never every column). */
export function frozenOptions(columnCount: number): number[] {
  const out = [0];
  for (let n = 1; n <= Math.min(3, Math.max(0, columnCount - 1)); n += 1) out.push(n);
  return out;
}

/**
 * The Table menu in the toolbar (GRID-02, GRID-07..11, KEYS-06, A11Y-01): every
 * structural command has a keyboard-reachable home here, beside its shortcut
 * where one exists. Commands that need a cell are present but disabled with
 * the reason (MENU-02). Built on the Radix menu from `@gede/ui`.
 */
export function TableMenu({ gd, selection, editable, commands }: TableMenuProps) {
  useYVersion(gd.tables);
  const record = selection === null ? null : tableById(gd, selection.tableId);
  const cell: CellSelection | null =
    selection?.cell && record !== null ? { tableId: record.id, ...selection.cell } : null;
  const column = cell === null ? null : (record?.columns.find((c) => c.id === cell.colId) ?? null);
  const viewOnly = editable ? undefined : 'you have view-only access';
  const needsTable = viewOnly ?? (record === null ? 'select a table first' : undefined);
  const needsCell = needsTable ?? (cell === null ? 'select a cell first' : undefined);
  const hiddenCount = record?.columns.filter((c) => c.hidden).length ?? 0;
  const tableId = record?.id ?? '';
  const columnId = column?.id ?? '';
  const rowId = cell?.rowId ?? '';

  const entries: MenuEntry[] = [
    {
      kind: 'item',
      id: 'row-above',
      label: 'Insert row above',
      disabledReason: needsCell,
      onSelect: () => {
        commands.insertRowAbove(tableId, rowId);
      },
    },
    {
      kind: 'item',
      id: 'row-below',
      label: 'Insert row below',
      shortcut: LABELS.addRow,
      disabledReason: needsTable,
      onSelect: () => {
        commands.insertRowBelow(tableId, cell?.rowId);
      },
    },
    {
      kind: 'item',
      id: 'row-delete',
      label: 'Delete row',
      danger: true,
      disabledReason: needsCell,
      onSelect: () => {
        commands.deleteRow(tableId, rowId);
      },
    },
    {
      kind: 'check',
      id: 'row-wrap',
      label: 'Wrap row',
      checked: cell !== null && rowIsWrapped(gd, cell),
      disabledReason: needsCell,
      onCheckedChange: (checked) => {
        commands.setRowWrap(tableId, rowId, checked);
      },
    },
    { kind: 'separator', id: 's1' },
    {
      kind: 'item',
      id: 'col-before',
      label: 'Insert column before',
      disabledReason: needsCell,
      onSelect: () => {
        commands.insertColumnBefore(tableId, columnId);
      },
    },
    {
      kind: 'item',
      id: 'col-after',
      label: 'Insert column after',
      shortcut: LABELS.addColumn,
      disabledReason: needsTable,
      onSelect: () => {
        commands.insertColumnAfter(tableId, column?.id);
      },
    },
    {
      kind: 'item',
      id: 'col-delete',
      label: 'Delete column',
      danger: true,
      disabledReason: needsCell,
      onSelect: () => {
        commands.deleteColumn(tableId, columnId);
      },
    },
    {
      kind: 'item',
      id: 'col-hide',
      label: 'Hide column',
      disabledReason: needsCell,
      onSelect: () => {
        commands.hideColumn(tableId, columnId);
      },
    },
    {
      kind: 'item',
      id: 'col-unhide',
      label:
        hiddenCount === 0
          ? 'Unhide columns'
          : `Unhide ${String(hiddenCount)} ${hiddenCount === 1 ? 'column' : 'columns'}`,
      disabledReason: needsTable ?? (hiddenCount === 0 ? 'no hidden columns' : undefined),
      onSelect: () => {
        commands.unhideAllColumns(tableId);
      },
    },
    {
      kind: 'item',
      id: 'col-widen',
      label: 'Widen column',
      disabledReason: needsCell,
      onSelect: () => {
        commands.setColumnWidth(tableId, columnId, (column?.width ?? 1) + 1);
      },
    },
    {
      kind: 'item',
      id: 'col-narrow',
      label: 'Narrow column',
      disabledReason:
        needsCell ?? ((column?.width ?? 1) <= 1 ? 'already one unit wide' : undefined),
      onSelect: () => {
        commands.setColumnWidth(tableId, columnId, (column?.width ?? 1) - 1);
      },
    },
    {
      kind: 'check',
      id: 'col-wrap',
      label: 'Wrap column text',
      checked: column?.wrap === true,
      disabledReason: needsCell,
      onCheckedChange: (checked) => {
        commands.setColumnWrap(tableId, columnId, checked);
      },
    },
    { kind: 'separator', id: 's2' },
    {
      kind: 'radio',
      id: 'freeze',
      label: 'Frozen columns',
      value: String(record?.frozenColumns ?? 0),
      onValueChange: (value) => {
        commands.setFrozenColumns(tableId, Number(value));
      },
      options: frozenOptions(record?.columns.length ?? 0).map((n) => ({
        value: String(n),
        label: n === 0 ? 'None' : `${String(n)} ${n === 1 ? 'column' : 'columns'}`,
        disabledReason: needsTable,
      })),
    },
    { kind: 'separator', id: 's3' },
    {
      kind: 'check',
      id: 'header',
      label: 'Header row',
      checked: record?.headerRows === 1,
      disabledReason: needsTable,
      onCheckedChange: (checked) => {
        commands.setHeaderRows(tableId, checked ? 1 : 0);
      },
    },
    {
      kind: 'check',
      id: 'footer',
      label: 'Footer',
      checked: record?.footerRows === 1,
      disabledReason: needsTable,
      onCheckedChange: (checked) => {
        commands.setFooterRows(tableId, checked ? 1 : 0);
      },
    },
  ];

  return (
    <Menu
      label="Table"
      align="start"
      entries={entries}
      trigger={
        <Button size="sm" variant="ghost" className="gd-tool gd-tool--text" aria-label="Table menu">
          Table
        </Button>
      }
    />
  );
}

function rowIsWrapped(gd: GedeDoc, cell: CellSelection): boolean {
  const map = tableMap(gd, cell.tableId);
  return map !== null && rowMeta(map, cell.rowId).height === WRAPPED_ROW_HEIGHT;
}
