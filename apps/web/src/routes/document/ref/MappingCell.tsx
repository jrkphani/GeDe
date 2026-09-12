import { cellText, distinctValues, openDocument, type LinkSpec, type TableMap } from '@gede/core';
import { Select } from '@gede/ui';
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';

import { useYVersion } from '../../../doc/use-y.js';
import { useLocale } from '../../../locale.js';
import { docOf } from '../formula/index.js';
import type { CellSelection } from '../selection.js';

/** What the grid's cell can ask of a mapping picker: open it (Enter on the armed cell). */
export interface MappingCellHandle {
  open(): void;
}

export interface MappingCellProps {
  table: TableMap;
  cell: CellSelection;
  link: LinkSpec;
  address: string | undefined;
  /** False renders the value only: a phone, a viewer, a pulled or split row (REF-05). */
  editable: boolean;
  /** The cell is the grid's armed cell: its trigger joins the Tab order. */
  active: boolean;
  /** The grid command that writes the pick (`GridCommands.pickMappingValue`): one undo step. */
  onPick: (value: string, locale: string) => boolean;
  ref?: Ref<MappingCellHandle> | undefined;
}

/**
 * A mapping column's cell (REF-03): a Radix Select over the target column's
 * distinct values, collated for the active locale. Picking writes the value
 * as the cell's text through `setMappingValue` — the one write path a linked
 * column has; typing is refused like any read-only cell. One pick is one
 * undo step (the command settles it). Without edit rights the value renders
 * as text with the `↔` badge. Reads go through the table's own document.
 */
export function MappingCell({
  table,
  cell,
  link,
  address,
  editable,
  active,
  onPick,
  ref,
}: MappingCellProps) {
  const gd = openDocument(docOf(table));
  const target = gd.tables.get(link.tableId) ?? null;
  const targetVersion = useYVersion(target);
  const [locale] = useLocale();
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (editable) setOpen(true);
      },
    }),
    [editable],
  );
  const value = cellText(table, cell.rowId, cell.colId);
  const options = useMemo(() => {
    const distinct = distinctValues(gd, link, locale);
    // A value picked earlier that the target no longer holds stays visible (and re-pickable
    // only from the target): the cell keeps what it says until someone changes it.
    if (value !== '' && !distinct.includes(value)) distinct.unshift(value);
    return distinct.map((v) => ({ value: v, label: v }));
    // targetVersion: the target column's cells changed.
  }, [gd, link, locale, value, targetVersion]);
  const label = `${address ?? 'Cell'} mapping`;
  if (!editable) {
    return (
      <span className="gd-mapping" data-testid="mapping-cell">
        <span className="gd-mapping__static">
          {value === '' ? <span className="gd-mapping__empty">—</span> : value}
          <span className="gd-ref__badge" aria-label="Mapping">
            ↔
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="gd-mapping" data-testid="mapping-cell" ref={host}>
      <Select
        label={label}
        hideLabel
        size="sm"
        value={value}
        options={options}
        placeholder=""
        clearLabel="Clear"
        emptyText="The target column has no values yet"
        open={open}
        onOpenChange={setOpen}
        triggerTabIndex={active ? 0 : -1}
        onValueChange={(next) => {
          onPick(next, locale);
        }}
        // The list closed (a pick or Escape): focus goes back to the grid's cell, not the
        // trigger, so ↑ ↓ Tab keep moving the selection (GRID-05) and Enter reopens the
        // picker. Radix's default would focus the trigger, whose own ↓ reopens the list
        // while the same keystroke bubbles to the cell and moves the selection too.
        onCloseAutoFocus={(event) => {
          const cell = host.current?.closest<HTMLElement>('[role="gridcell"]');
          if (cell === null || cell === undefined) return;
          event.preventDefault();
          cell.focus({ preventScroll: true });
        }}
      />
    </span>
  );
}
