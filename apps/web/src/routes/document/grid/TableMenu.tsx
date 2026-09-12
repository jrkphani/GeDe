import { tableById, type GedeDoc } from '@gede/core';
import { Button, Menu, type MenuEntry } from '@gede/ui';

import type { CellSelection, Selection } from '../../../doc/selection.js';
import { useYVersion } from '../../../doc/use-y.js';
import type { GridCommands } from './commands.js';

export interface TableMenuProps {
  gd: GedeDoc;
  selection: Selection | null;
  editable: boolean;
  commands: GridCommands;
}

/**
 * Frozen-column choices (GRID-10): none, or any count short of every column —
 * freezing them all would leave nothing to scroll. No other cap; the PRD sets none.
 */
export function frozenOptions(columnCount: number): number[] {
  const out = [0];
  for (let n = 1; n <= Math.max(0, columnCount - 1); n += 1) out.push(n);
  return out;
}

/**
 * The Table menu in the toolbar (GRID-02, GRID-07..08, A11Y-01): the home of
 * the structure commands no toolbar tool or inspector control carries —
 * insert above / before, delete, hide and unhide, widen and narrow. Add row
 * and Add column live in the toolbar, header, footer, frozen columns and wrap
 * in the Table and Text tabs (DOC-02, ADR-041); this menu does not repeat
 * them. Commands that need a cell are present but disabled with the reason
 * (MENU-02). Built on the Radix menu from `@gede/ui`.
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
      id: 'row-delete',
      label: 'Delete row',
      danger: true,
      disabledReason: needsCell,
      onSelect: () => {
        commands.deleteRow(tableId, rowId);
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
