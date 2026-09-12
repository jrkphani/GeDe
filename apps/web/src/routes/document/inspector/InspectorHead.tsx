import { cellAddress, rowMeta, tableRecord, type TableMap } from '@gede/core';

import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import type { Selection } from '../selection.js';

/**
 * INSP-03: the head of the rail always states the selected object — its
 * title, the A1 address when a cell is selected, row and column counts, how
 * many columns are derived and how many category bands group the rows.
 */
export function InspectorHead({
  table,
  selection,
}: {
  table: TableMap | null;
  selection: Selection | null;
}) {
  if (table === null || selection === null) {
    return (
      <div className="gd-inspector__selected" data-testid="inspector-selected">
        <p className="gd-inspector__none">Nothing selected</p>
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
