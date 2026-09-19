/**
 * How a column is named to a person when a label is needed and the header may
 * be blank (ADR-052): its label, else the letter the grid draws over it — the
 * A1 letter of its first lattice column, which is what the header row shows
 * and what `@Table.Row.C` spells (ADR-054). One helper for the Table tab's
 * "Outline column" select, the hierarchy panel's "Outline in …" line and the
 * nest and hide announcements, so a blank column reads the same everywhere.
 */
import { columnLetter, columnWidths, type Id, type TableRecord } from '@gede/core';

/** The column's label, else its grid letter; null when the column is not in the table or is hidden. */
export function columnDisplayName(record: TableRecord, colId: Id): string | null {
  const index = record.columns.findIndex((c) => c.id === colId);
  const column = record.columns[index];
  if (column === undefined || column.hidden) return null;
  const label = column.label.trim();
  if (label !== '') return label;
  const before = columnWidths(record)
    .slice(0, index)
    .reduce((a, w) => a + w, 0);
  return columnLetter(record.gridCol + before);
}
