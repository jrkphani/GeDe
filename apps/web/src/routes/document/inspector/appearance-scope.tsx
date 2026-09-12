/**
 * INSP-10 for appearance: fill, border, typography and alignment act on the
 * whole column by default, or on the selected cell as an override. The
 * scope is chosen once per tab, stated in a sentence before any control is
 * used, and every write goes through `GridCommands` — one transaction and
 * one undo step per change (INSP-12, KEYS-03).
 */
import { useState, type ReactNode } from 'react';
import { SegmentedControl } from '@gede/ui';
import {
  cellAddress,
  cellAppearanceOverride,
  countAppearanceOverrides,
  mergeAppearance,
  type Appearance,
  type AppearancePatch,
  type ColumnRecord,
  type TableMap,
  type TableRecord,
} from '@gede/core';

import type { GridCommands } from '../grid/commands.js';
import type { CellSelection } from '../selection.js';

export type AppearanceScopeKind = 'column' | 'cell';

export interface AppearanceScope {
  readonly scope: AppearanceScopeKind;
  readonly column: ColumnRecord | null;
  readonly cell: CellSelection | null;
  readonly address: string | null;
  /** What the controls show: the column's appearance, or the cell's effective one under cell scope. */
  readonly effective: Appearance;
  /** The cell's own override, or null when it follows the column. */
  readonly override: Appearance | null;
  /** Why the controls are disabled, or undefined when they can write. */
  readonly disabledReason: string | undefined;
  /** INSP-10: the sentence stating what a change will touch, before it is applied. */
  readonly sentence: string;
  /** The scope switch (Radix ToggleGroup). */
  readonly control: ReactNode;
  write(patch: AppearancePatch): void;
  /** Cell scope only: drop the override so the cell follows its column again. */
  clearOverride(): void;
}

export function useAppearanceScope(
  table: TableMap,
  record: TableRecord,
  cell: CellSelection | null,
  editable: boolean,
  commands: GridCommands,
  what: string,
): AppearanceScope {
  const [scope, setScope] = useState<AppearanceScopeKind>('column');
  const column = cell === null ? null : (record.columns.find((c) => c.id === cell.colId) ?? null);
  const address = cell === null ? null : cellAddress(table, cell.rowId, cell.colId);
  const viewOnly = editable ? undefined : 'you have view-only access';
  const disabledReason = viewOnly ?? (column === null ? 'select a cell first' : undefined);
  const override =
    cell === null || column === null ? null : cellAppearanceOverride(table, cell.rowId, column.id);
  const cellOnly = scope === 'cell';
  const effective: Appearance =
    column === null
      ? {}
      : cellOnly
        ? override === null
          ? column.appearance
          : mergeAppearance(column.appearance, override)
        : column.appearance;
  const overrides = column === null ? 0 : countAppearanceOverrides(table, column.id);
  const rows = record.rows.length;
  const sentence =
    column === null
      ? `Select a cell to set its column's ${what}.`
      : cellOnly
        ? `${capitalise(what)} applies to cell ${address ?? ''} only. Other cells in ${column.label} keep the column's.`
        : `${capitalise(what)} applies to ${column.label} for all ${String(rows)} ${rows === 1 ? 'row' : 'rows'}, and for rows added later.${
            overrides > 0
              ? ` ${String(overrides)} ${overrides === 1 ? 'cell with its own keeps it' : 'cells with their own keep them'}.`
              : ''
          }`;
  const control = (
    <SegmentedControl
      label="Scope"
      value={scope}
      onChange={setScope}
      disabled={disabledReason !== undefined}
      options={[
        { value: 'column', label: column === null ? 'Column' : `Column ${column.label}` },
        { value: 'cell', label: address === null ? 'Cell' : `Cell ${address}` },
      ]}
    />
  );
  return {
    scope,
    column,
    cell,
    address,
    effective,
    override,
    disabledReason,
    sentence,
    control,
    write: (patch) => {
      if (column === null || cell === null || disabledReason !== undefined) return;
      if (cellOnly) commands.setCellAppearance(cell, patch);
      else commands.setColumnAppearance(record.id, column.id, patch);
    },
    clearOverride: () => {
      if (cell === null || disabledReason !== undefined) return;
      commands.setCellAppearance(cell, null);
    },
  };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
