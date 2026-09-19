import { tableById, type GedeDoc, type Id } from '@gede/core';
import { Button, Menu, type MenuEntry } from '@gede/ui';

import { useRef } from 'react';

import type { CellSelection, Selection } from '../../../doc/selection.js';
import { LABELS } from '../../../doc/shortcuts.js';
import { useYVersion } from '../../../doc/use-y.js';
import { RENAME_KEYS } from '../keys/shortcut-map.js';
import type { GridCommands } from './commands.js';
import type { RenameTarget } from './rename.js';

export interface TableMenuProps {
  gd: GedeDoc;
  selection: Selection | null;
  editable: boolean;
  commands: GridCommands;
  /** ADR-047: Delete table's home is this menu; the shell deletes and moves focus. */
  onDeleteTable?: ((tableId: Id) => void) | undefined;
  /**
   * ADR-051: Rename table… opens the inline field on the selected table's
   * title bar, beside its chord (KEYS-08); the Table tab's Title text is the
   * property's home. Absent where nothing can be written.
   */
  onRename?: ((target: RenameTarget) => void) | undefined;
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
 * insert above / before, delete row, column and table (ADR-047), hide and
 * unhide, widen and narrow. Add row
 * and Add column live in the toolbar, header, footer, frozen columns and wrap
 * in the Table and Text tabs (DOC-02, ADR-041); this menu does not repeat
 * them. Commands that need a cell are present but disabled with the reason
 * (MENU-02). Built on the Radix menu from `@gede/ui`.
 */
export function TableMenu({
  gd,
  selection,
  editable,
  commands,
  onDeleteTable,
  onRename,
}: TableMenuProps) {
  useYVersion(gd.tables);
  // Set when Rename table… was chosen: the menu's close leaves focus on the inline field it
  // opened rather than returning it to the Table button (which would blur, and so close, it).
  const renameOnClose = useRef(false);
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
      id: 'table-rename',
      label: 'Rename table…',
      shortcut: RENAME_KEYS.rename,
      disabledReason: needsTable ?? (onRename === undefined ? 'select a table first' : undefined),
      onSelect: () => {
        renameOnClose.current = true;
        onRename?.({ kind: 'table', tableId });
      },
    },
    { kind: 'separator', id: 's0' },
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
    { kind: 'separator', id: 's2' },
    {
      // ADR-047: the table, its cells and meta, and its graph pairs — one undo step, no
      // dialog. ⌫ with the table selected and the table context menu are the routes.
      kind: 'item',
      id: 'table-delete',
      label: 'Delete table',
      shortcut: LABELS.clear,
      danger: true,
      disabledReason:
        needsTable ?? (onDeleteTable === undefined ? 'select a table first' : undefined),
      onSelect: () => {
        onDeleteTable?.(tableId);
      },
    },
  ];

  return (
    <Menu
      label="Table"
      align="start"
      entries={entries}
      onCloseAutoFocus={(event) => {
        if (!renameOnClose.current) return;
        renameOnClose.current = false;
        const field = document.querySelector<HTMLElement>('[data-table-rename]');
        if (field === null) return;
        event.preventDefault();
        field.focus();
      }}
      trigger={
        <Button size="sm" variant="ghost" className="gd-tool gd-tool--text" aria-label="Table menu">
          Table
        </Button>
      }
    />
  );
}
