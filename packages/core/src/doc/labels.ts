/**
 * Lineage labels and name uniqueness (ADR-051). A pulled column is
 * labelled `↰ Table · Column` (REF-02) and a mapping column `↔ Table ·
 * Column` (REF-03) — spellings of another table's title and column label,
 * so a rename of either has to re-spell them wherever they are; and a
 * column's label is unique in its table, a table's title in the workbook,
 * because an `@` path names by label and a duplicate would reach only the
 * first (REF-01). Doc-layer, so `setTableTitle` can refresh what names the
 * table without reaching up into `ref/`.
 */
import {
  columnsArray,
  readColumnSource,
  readLinkSpec,
  readPullSpec,
  readString,
  tableRecord,
  type ColumnRecord,
  type GedeDoc,
  type LinkSpec,
  type PullSpec,
  type TableRecord,
} from './schema.js';
import type { Id } from '../ids.js';

/** `↰ Table · Column` — how the receiving column names its source (PRD §14). */
export function pullLabel(gd: GedeDoc, spec: PullSpec): string {
  const table = gd.tables.get(spec.tableId);
  const record = table === undefined ? null : tableRecord(table);
  const column = record?.columns.find((c) => c.id === spec.colId);
  return `↰ ${record?.title ?? '#REF'} · ${column?.label ?? '#REF'}`;
}

/** `↔ Table · Column` — how a mapping column names its target (PRD §14). */
export function mappingLabel(gd: GedeDoc, link: LinkSpec): string {
  const table = gd.tables.get(link.tableId);
  const record = table === undefined ? null : tableRecord(table);
  const column = record?.columns.find((c) => c.id === link.colId);
  return `↔ ${record?.title ?? '#REF'} · ${column?.label ?? '#REF'}`;
}

/**
 * Re-spell every pulled and mapping label, in every table, whose spec names
 * `tableId` (and, when given, `colId`). Runs inside the caller's transaction
 * so a rename and what it re-spells are one undo step. Idempotent; returns
 * how many labels changed.
 */
export function refreshLineageLabelsInTransaction(gd: GedeDoc, tableId: Id, colId?: Id): number {
  let changed = 0;
  for (const table of gd.tables.values()) {
    for (const column of columnsArray(table).toArray()) {
      const source = readColumnSource(column);
      let label: string | null = null;
      if (source === 'pulled') {
        const spec = readPullSpec(column.get('pull'));
        if (
          spec !== null &&
          spec.tableId === tableId &&
          (colId === undefined || spec.colId === colId)
        )
          label = pullLabel(gd, spec);
      } else if (source === 'linked') {
        const link = readLinkSpec(column.get('link'));
        if (
          link !== null &&
          link.tableId === tableId &&
          (colId === undefined || link.colId === colId)
        )
          label = mappingLabel(gd, link);
      }
      if (label !== null && readString(column, 'label') !== label) {
        column.set('label', label);
        changed += 1;
      }
    }
  }
  return changed;
}

/** Names compare trimmed and case-insensitively: "Owner" and " owner " are one name. */
export function sameName(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0;
}

/** The other column of `record` already named `label`, or null (ADR-051). */
export function duplicateColumnLabel(
  record: TableRecord,
  colId: Id,
  label: string,
): ColumnRecord | null {
  return record.columns.find((c) => c.id !== colId && sameName(c.label, label)) ?? null;
}

/** The other table of the workbook already titled `title`, or null (ADR-051). */
export function duplicateTableTitle(gd: GedeDoc, tableId: Id, title: string): TableRecord | null {
  for (const table of gd.tables.values()) {
    const record = tableRecord(table);
    if (record.id !== tableId && sameName(record.title, title)) return record;
  }
  return null;
}
