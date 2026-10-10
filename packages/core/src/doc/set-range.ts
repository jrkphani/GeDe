/**
 * Which tables are sets and which of their columns is the set (SET-01, SET-02). Kept apart
 * from `set-table.ts` so the engine's table structure can name a set's range column without
 * importing the set-table writes (which reach the engine's commit path themselves).
 */
import type { Id } from '../ids.js';
import type { TableKind, TableRecord } from './schema.js';

/** SET-01: every kind but a plain table is a set table. */
export function isSetKind(kind: TableKind): boolean {
  return kind !== 'plain';
}

/**
 * SET-02: a set table's range column — the first column of a simple set or a family, the
 * first one-column computed column of a computed table. A product spread across columns
 * has no single range column, whatever its kind: a spread Filled into a set's first column
 * is a tuple's first member, not the set. Null for a plain table.
 */
export function setRangeColumn(record: TableRecord): Id | null {
  if (record.kind === 'plain') return null;
  if (record.kind === 'simple' || record.kind === 'family') {
    const first = record.columns[0];
    return first === undefined || first.computed?.shape === 'spread' ? null : first.id;
  }
  const computed = record.columns.filter((c) => c.computed !== null);
  if (computed.length === 0) return record.columns[0]?.id ?? null;
  return computed.find((c) => c.computed?.shape === 'column')?.id ?? null;
}

/** How a set table is named in an `@` reference (SET-06, REF-01): its title, trimmed, any case. */
export function setNameKey(title: string): string {
  return title.trim().normalize('NFC').toLowerCase();
}
