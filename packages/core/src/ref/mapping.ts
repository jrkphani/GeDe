/**
 * Mapping columns (REF-03, PRD §14 "a column bound to a target column
 * elsewhere; its cells become one-click pickers over the target's distinct
 * values — governed many-to-one mapping").
 *
 * The column map stores `source: 'linked'` and `link: { tableId, colId }`.
 * A cell's value is the picked text, stored as an ordinary text cell so it
 * syncs, undoes and searches like any other; only the picker writes it
 * (`setMappingValue`), and every other path treats the column as read-only
 * (REF-05). The picker's options are the target column's distinct values,
 * collated for the active locale.
 */
import { newColumn, setCellText } from '../doc/mutations.js';
import {
  cellText,
  columnsArray,
  readColumnSource,
  readLinkSpec,
  readString,
  tableRecord,
  type GedeDoc,
  type LinkSpec,
  type TableMap,
} from '../doc/schema.js';
import { isFormula, cellsMap } from '../doc/schema.js';
import { cellKey, type Id } from '../ids.js';

function transact<T>(gd: GedeDoc, fn: () => T): T {
  let out!: T;
  gd.doc.transact(() => {
    out = fn();
  }, gd.origin);
  return out;
}

function requireTable(gd: GedeDoc, tableId: Id): TableMap {
  const table = gd.tables.get(tableId);
  if (table === undefined) throw new RangeError(`no table ${tableId}`);
  return table;
}

// The label lives in the doc layer since ADR-051, so a table rename can re-spell it.
import { mappingLabel } from '../doc/labels.js';

export { mappingLabel };

/**
 * Add a mapping column bound to `link`, after `afterColId` (default: at the
 * end). Returns the new column id, or null when the target does not exist
 * or is a derived column (its values live in the engine, not the document).
 */
export function addMappingColumn(
  gd: GedeDoc,
  tableId: Id,
  link: LinkSpec,
  afterColId?: Id,
): Id | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const target = gd.tables.get(link.tableId);
    if (target === undefined) return null;
    const targetColumn = tableRecord(target).columns.find((c) => c.id === link.colId);
    // A derived column has no stored values to pick from (they are the engine's): refused.
    if (targetColumn?.derive !== null) return null;
    const columns = columnsArray(table);
    const { id, map } = newColumn(mappingLabel(gd, link));
    map.set('source', 'linked');
    map.set('link', { tableId: link.tableId, colId: link.colId });
    const after =
      afterColId === undefined
        ? -1
        : columns.toArray().findIndex((c) => readString(c, 'id') === afterColId);
    columns.insert(after < 0 ? columns.length : after + 1, [map]);
    return id;
  });
}

/** The link a column carries, or null when it is not a mapping column. */
export function mappingOf(table: TableMap, colId: Id): LinkSpec | null {
  const column = columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
  if (column === undefined || readColumnSource(column) !== 'linked') return null;
  return readLinkSpec(column.get('link'));
}

/**
 * The distinct values of a column, trimmed, first spelling wins
 * case-insensitively, collated for `locale` (I18N: `Intl.Collator`, never a
 * code-point sort). Formula cells contribute nothing — their values live in
 * the engine, and a picker offers what a person can type back.
 */
export function distinctValues(gd: GedeDoc, link: LinkSpec, locale?: string): string[] {
  const table = gd.tables.get(link.tableId);
  if (table === undefined) return [];
  const record = tableRecord(table);
  if (!record.columns.some((c) => c.id === link.colId)) return [];
  const cells = cellsMap(table);
  const seen = new Map<string, string>();
  for (const rowId of record.rows) {
    const content = cells.get(cellKey(rowId, link.colId));
    if (content === undefined || isFormula(content)) continue;
    const text = cellText(table, rowId, link.colId).trim();
    if (text === '') continue;
    const key = text.toLocaleLowerCase(locale);
    if (!seen.has(key)) seen.set(key, text);
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...seen.values()].sort((a, b) => collator.compare(a, b));
}

/**
 * The picker's write: store `value` (or clear with '') in a mapping cell.
 * Refuses a value that is not one of the target's distinct values, so the
 * mapping stays governed (REF-03). One transaction, one undo step.
 */
export function setMappingValue(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  value: string,
  locale?: string,
): boolean {
  const table = gd.tables.get(tableId);
  if (table === undefined) return false;
  const link = mappingOf(table, colId);
  if (link === null) return false;
  if (value !== '' && !distinctValues(gd, link, locale).includes(value)) return false;
  return setCellText(gd, tableId, rowId, colId, value);
}
