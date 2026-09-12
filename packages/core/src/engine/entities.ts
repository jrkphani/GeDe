/**
 * The workbook entity index (FX-04, REF-01, PRD §13 "every addressable entity
 * in the workbook as a dotted path qualified by parent row").
 *
 *   @Table.Row            → the row's first cell (its label)
 *   @Table.Parent.Child   → a nested row, qualified by its outline ancestors
 *   @Table.Row.Column     → the cell in that column
 *
 * Rows are labelled by their first-column text. Lookups are case-insensitive;
 * a segment holding a space, dot or quote is quoted when the path is written
 * back (`@"Everest trek".Row`).
 */
import { cellKey, type CellKey, type Id } from '../ids.js';
import { entityKey } from './sheet-index.js';
import { workbookCellId, type EntityEntry, type TableStructure } from './types.js';

const PLAIN_SEGMENT = /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u;

export function formatEntitySegment(segment: string): string {
  if (PLAIN_SEGMENT.test(segment)) return segment;
  return `"${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatEntityPath(path: readonly string[]): string {
  return `@${path.map(formatEntitySegment).join('.')}`;
}

export interface EntityIndex {
  /** `entityKey(path)` → entry. */
  readonly byKey: ReadonlyMap<string, EntityEntry>;
  /** Every entry in workbook order (tables by id, rows in order, row before its columns). */
  readonly entries: readonly EntityEntry[];
}

/**
 * Build the index. `textOf` reads a cell's plain text (a formula cell has no
 * label and yields ''); rows without a label are unaddressable but still
 * qualify their children.
 */
export function buildEntityIndex(
  tables: Iterable<TableStructure>,
  textOf: (tableId: Id, key: CellKey) => string,
): EntityIndex {
  const byKey = new Map<string, EntityEntry>();
  const entries: EntityEntry[] = [];
  const add = (path: readonly string[], tableId: Id, key: CellKey): void => {
    const entry: EntityEntry = {
      path,
      text: formatEntityPath(path),
      cellId: workbookCellId(tableId, key),
      tableId,
    };
    const k = entityKey(path);
    // First definition wins; a duplicate label is not addressable twice.
    if (!byKey.has(k)) byKey.set(k, entry);
    entries.push(entry);
  };
  const sorted = [...tables].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const table of sorted) {
    const first = table.columns[0];
    if (first === undefined || table.title.trim() === '') continue;
    // Ancestor labels by depth; a row at depth d is qualified by the stack below d.
    const ancestors: string[] = [];
    table.rows.forEach((rowId, r) => {
      const depth = table.rowDepths[r] ?? 0;
      ancestors.length = Math.min(ancestors.length, depth);
      const label = textOf(table.id, cellKey(rowId, first.id)).trim();
      const path = [table.title, ...ancestors, label];
      if (label !== '') {
        add(path, table.id, cellKey(rowId, first.id));
        for (const column of table.columns.slice(1)) {
          if (column.label.trim() === '') continue;
          add([...path, column.label], table.id, cellKey(rowId, column.id));
        }
      }
      ancestors.length = depth;
      ancestors.push(label);
    });
  }
  return { byKey, entries };
}

/**
 * Entries for the `@` popover: those whose written path starts with what was
 * typed, then those whose last segment contains it (case-insensitive).
 */
export function searchEntities(
  index: EntityIndex,
  query: string,
  limit = 8,
): readonly EntityEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return index.entries.slice(0, limit);
  const prefix: EntityEntry[] = [];
  const contains: EntityEntry[] = [];
  for (const e of index.entries) {
    const plain = e.path.join('.').toLowerCase();
    const written = e.text.slice(1).toLowerCase();
    if (plain.startsWith(q) || written.startsWith(q)) prefix.push(e);
    else if ((e.path[e.path.length - 1] ?? '').toLowerCase().includes(q)) contains.push(e);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}
