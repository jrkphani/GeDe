/**
 * MENU-04 in the Cell tab: the merge controls, as a span from the selected
 * cell across rows and columns. A merge is presentation — the covered cells
 * keep their addresses and their data, hidden under the anchor the way a
 * hidden column's cells are (non-negotiable 3) — and unmerging shows them
 * again unchanged. The cell menu offers the same as "Merge with cell to the
 * right / below" and "Unmerge cells".
 */
import { mergeRoom, spanAt, spanCovering, tableRecord, type TableMap } from '@gede/core';

import type { GridCommands } from '../grid/commands.js';
import type { CellSelection } from '../selection.js';
import { ReasonedButton, Section, Stepper } from './controls.js';

export interface MergeSectionProps {
  table: TableMap;
  cell: CellSelection | null;
  disabledReason: string | undefined;
  commands: GridCommands;
}

export function MergeSection({ table, cell, disabledReason, commands }: MergeSectionProps) {
  const record = tableRecord(table);
  const anchor = cell === null ? null : spanAt(table, cell.rowId, cell.colId);
  const covering = cell === null ? null : spanCovering(table, cell.rowId, cell.colId);
  const room = cell === null ? null : mergeRoom(record, cell.rowId, cell.colId);
  const rows = anchor?.rows ?? 1;
  const cols = anchor?.cols ?? 1;
  const reason =
    disabledReason ?? (covering !== null ? 'this cell is inside a merged cell' : undefined);
  const merged = anchor !== null || covering !== null;
  const unmergeReason = disabledReason ?? (merged ? undefined : 'the cell is not merged');
  return (
    <Section
      label="merge"
      hint={
        cell === null
          ? 'Select a cell to merge from it.'
          : covering !== null
            ? 'This cell is covered by a merged cell; unmerge to reach it.'
            : 'A merged cell spans rows and columns from here. Covered cells keep their addresses and data.'
      }
    >
      <div className="gd-insp__stack">
        <Stepper
          label="Columns spanned"
          unit="columns"
          value={cols}
          min={1}
          max={room?.cols ?? 1}
          disabledReason={reason}
          decrementReason="one column is the cell itself"
          onChange={(next) => {
            if (cell !== null) commands.mergeCells(cell, { rows, cols: next });
          }}
        />
        <Stepper
          label="Rows spanned"
          unit="rows"
          value={rows}
          min={1}
          max={room?.rows ?? 1}
          disabledReason={reason}
          decrementReason="one row is the cell itself"
          onChange={(next) => {
            if (cell !== null) commands.mergeCells(cell, { rows: next, cols });
          }}
        />
        <ReasonedButton
          label="Unmerge cells"
          reason={unmergeReason}
          onClick={() => {
            if (cell !== null) commands.unmergeCells(cell);
          }}
        />
      </div>
    </Section>
  );
}
