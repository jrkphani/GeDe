import { cellAddress, rowMeta, tableRecord, type TableMap } from '@gede/core';

import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import type { Selection } from '../selection.js';

/** A selected object that is not a table (INSP-08: a graph): its name and what the head says of it. */
export interface HeadObject {
  readonly label: string;
  readonly facts?: readonly string[] | undefined;
}

/**
 * INSP-03: the head of the rail always states the selected object — its
 * title, the A1 address when a cell is selected, row and column counts, how
 * many columns are derived, and the grouping in force (the viewer's own,
 * ADR-026) — or, for a graph, its kind, source and dimensions.
 */
export function InspectorHead({
  table,
  selection,
  object,
  groupedBy,
}: {
  table: TableMap | null;
  selection: Selection | null;
  /** Stated in place of "Nothing selected" when the selection is not a table. */
  object?: HeadObject | undefined;
  /** The label of the column the viewer groups the table by, or null (INSP-03 "grouping"). */
  groupedBy?: string | null | undefined;
}) {
  if (table === null || selection === null) {
    return (
      <div className="gd-inspector__selected" data-testid="inspector-selected">
        {object === undefined ? (
          <p className="gd-inspector__none">Nothing selected</p>
        ) : (
          <>
            <p className="gd-inspector__object">{object.label}</p>
            {object.facts !== undefined && object.facts.length > 0 && (
              <p className="gd-inspector__counts">{object.facts.join(' · ')}</p>
            )}
          </>
        )}
      </div>
    );
  }
  const record = tableRecord(table);
  const address = selection.cell
    ? cellAddress(table, selection.cell.rowId, selection.cell.colId)
    : null;
  const locale = activeLocale();
  const n = (value: number) => formatNumber(locale, value);
  const derived = record.columns.filter((c) => c.source !== 'entered').length;
  const bands = record.rows.filter((rowId) => rowMeta(table, rowId).group).length;
  const facts = [
    `${n(record.rows.length)} ${record.rows.length === 1 ? 'row' : 'rows'}`,
    `${n(record.columns.length)} ${record.columns.length === 1 ? 'column' : 'columns'}`,
  ];
  if (derived > 0) facts.push(`${n(derived)} derived`);
  if (bands > 0) facts.push(`${n(bands)} ${bands === 1 ? 'category band' : 'category bands'}`);
  if (groupedBy !== null && groupedBy !== undefined) facts.push(`grouped by ${groupedBy}`);
  return (
    <div className="gd-inspector__selected" data-testid="inspector-selected">
      <p className="gd-inspector__object">{record.title}</p>
      {address !== null && (
        <p className="gd-mono gd-inspector__address" aria-label={`Address ${address}`}>
          {address}
        </p>
      )}
      <p className="gd-inspector__counts">{facts.join(' · ')}</p>
    </div>
  );
}
