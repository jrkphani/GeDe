/**
 * The workbook entity index (FX-04, REF-01, PRD §13 "every addressable entity
 * in the workbook as a dotted path qualified by parent row").
 *
 *   @Table.Row            → the row's label cell
 *   @Table.Parent.Child   → a nested row, qualified by its outline ancestors
 *   @Table.Row.Column     → the cell in that column
 *
 * A row is labelled by the text of its outline column — the column its
 * outline is drawn in (ADR-052), the first visible column by default — and,
 * when that cell is blank, by the first visible column that has text
 * (ADR-054), so a row whose first cell is empty is still addressable. Every
 * other column of the row is an entry too, carrying the cell's text as its
 * `value` so the `@` picker can offer "Priya" wherever Priya is written, not
 * only where she is a row label. A column with a blank label is spelled by
 * its grid letter. Lookups are case-insensitive; a segment holding a space,
 * dot or quote is quoted when the path is written back (`@"Everest trek".Row`).
 */
import { columnLetter } from '../address.js';
import { cellKey, splitCellKey, type CellKey, type Id } from '../ids.js';
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

/** Reads a cell's plain text; a formula cell has no label and yields ''. */
export type TextReader = (tableId: Id, key: CellKey) => string;

/**
 * The column that labels row `r` and its text (ADR-054): the row's outline
 * column when its cell has text, else the first visible column with text,
 * else the outline column with an empty label (the row is unaddressable but
 * still qualifies its children). Null when the table has no column at all.
 */
export function rowLabelOf(
  table: TableStructure,
  r: number,
  textOf: TextReader,
): { readonly colId: Id; readonly label: string } | null {
  const rowId = table.rows[r];
  if (rowId === undefined) return null;
  const outline = table.rowOutlineColumns[r] ?? table.columns[0]?.id ?? null;
  if (outline === null) return null;
  const outlineLabel = textOf(table.id, cellKey(rowId, outline)).trim();
  if (outlineLabel !== '') return { colId: outline, label: outlineLabel };
  for (const column of table.columns) {
    if (column.width === 0 || column.id === outline) continue;
    const label = textOf(table.id, cellKey(rowId, column.id)).trim();
    if (label !== '') return { colId: column.id, label };
  }
  return { colId: outline, label: '' };
}

/**
 * Whether a change to this cell can re-spell the row's `@` path (ADR-054):
 * the cell is in the row's outline column, or that column's cell is blank so
 * the label falls back to another column. A superset, cheap to decide; the
 * index is rebuilt lazily either way.
 */
export function cellMayRelabel(
  table: TableStructure,
  key: CellKey,
  textOf: TextReader,
  /** Row id → ordinal, when the caller asks for many cells of one table. */
  rowOrdinals?: ReadonlyMap<Id, number>,
): boolean {
  const { rowId, colId } = splitCellKey(key);
  const r = rowOrdinals === undefined ? table.rows.indexOf(rowId) : (rowOrdinals.get(rowId) ?? -1);
  if (r < 0) return false;
  const outline = table.rowOutlineColumns[r] ?? table.columns[0]?.id ?? null;
  if (outline === null) return false;
  if (colId === outline) return true;
  return textOf(table.id, cellKey(rowId, outline)).trim() === '';
}

/**
 * The segment a column is written as in a path (ADR-054): its label, or its
 * grid letter when the label is blank — the letter the column's cells carry
 * in their A1 address, so `@Table.Row.C` names what the grid shows as C.
 */
export function columnSegment(table: TableStructure, colId: Id): string | null {
  let visibleIndex = 0;
  for (const column of table.columns) {
    if (column.id === colId) {
      const label = column.label.trim();
      if (label !== '') return label;
      return column.width === 0 ? null : columnLetter(table.gridCol + visibleIndex);
    }
    if (column.width > 0) visibleIndex += 1;
  }
  return null;
}

/**
 * Build the index. `textOf` reads a cell's plain text (a formula cell has no
 * label and yields ''); rows without a label are unaddressable but still
 * qualify their children.
 */
export function buildEntityIndex(
  tables: Iterable<TableStructure>,
  textOf: TextReader,
): EntityIndex {
  const byKey = new Map<string, EntityEntry>();
  const entries: EntityEntry[] = [];
  const add = (
    path: readonly string[],
    tableId: Id,
    key: CellKey,
    value: string,
    column: string | null,
  ): void => {
    const entry: EntityEntry = {
      path,
      text: formatEntityPath(path),
      cellId: workbookCellId(tableId, key),
      tableId,
      value,
      column,
    };
    const k = entityKey(path);
    // First definition wins; a duplicate label is not addressable twice.
    if (!byKey.has(k)) byKey.set(k, entry);
    entries.push(entry);
  };
  const sorted = [...tables].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const table of sorted) {
    if (table.columns.length === 0 || table.title.trim() === '') continue;
    const segments = new Map<Id, string | null>(
      table.columns.map((c) => [c.id, columnSegment(table, c.id)]),
    );
    // Ancestor labels by depth; a row at depth d is qualified by the stack below d.
    const ancestors: string[] = [];
    table.rows.forEach((rowId, r) => {
      const depth = table.rowDepths[r] ?? 0;
      ancestors.length = Math.min(ancestors.length, depth);
      const labelled = rowLabelOf(table, r, textOf);
      const label = labelled?.label ?? '';
      const path = [table.title, ...ancestors, label];
      if (labelled !== null && label !== '') {
        add(path, table.id, cellKey(rowId, labelled.colId), label, null);
        for (const column of table.columns) {
          if (column.id === labelled.colId) continue;
          const segment = segments.get(column.id) ?? null;
          if (segment === null) continue;
          const key = cellKey(rowId, column.id);
          add([...path, segment], table.id, key, textOf(table.id, key).trim(), segment);
        }
      }
      ancestors.length = depth;
      ancestors.push(label);
    });
  }
  return { byKey, entries };
}

export interface EntitySearchOptions {
  /** How many entries to return; the rest are counted in `more`. */
  readonly limit?: number | undefined;
  /** The table being edited: its entries rank first within each match tier. */
  readonly tableId?: Id | null | undefined;
}

export interface EntitySearch {
  readonly entries: readonly EntityEntry[];
  /** Matches beyond `limit`, so the picker can say "n more — keep typing". */
  readonly more: number;
}

const DEFAULT_ENTITY_LIMIT = 8;

/**
 * What is typed, ready to compare: trimmed, lower-cased, and with an opening
 * quote on the last segment dropped — `Table."In pr` and `"In pr` both mean
 * the segment "In pr…", which the written path spells quoted and the value
 * spells plain (ADR-054).
 */
function normaliseQuery(query: string): string {
  const q = query.trim().toLowerCase();
  // The last segment starts after the last `.` outside quotes.
  let start = 0;
  let quoted = false;
  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '.' && !quoted) start = i + 1;
  }
  return q[start] === '"' ? q.slice(0, start) + q.slice(start + 1) : q;
}

/**
 * Entries for the `@` popover (ADR-054): those whose written path or whose
 * value starts with what was typed, then those whose last segment or value
 * contains it (case-insensitive); within each tier the table being edited
 * comes first, then the rest in workbook order. A blank value never matches;
 * such a cell is still found by its path. An empty query lists everything in
 * the same order, rows before their columns.
 */
export function searchEntities(
  index: EntityIndex,
  query: string,
  options: EntitySearchOptions = {},
): EntitySearch {
  const limit = options.limit ?? DEFAULT_ENTITY_LIMIT;
  const here = options.tableId ?? null;
  const q = normaliseQuery(query);
  // Four tiers: prefix in this table, prefix elsewhere, contains here, contains elsewhere.
  const tiers: [EntityEntry[], EntityEntry[], EntityEntry[], EntityEntry[]] = [[], [], [], []];
  for (const e of index.entries) {
    let tier: 0 | 2 | null;
    if (q === '') {
      tier = 0;
    } else {
      const plain = e.path.join('.').toLowerCase();
      const written = e.text.slice(1).toLowerCase();
      const value = e.value.toLowerCase();
      if (plain.startsWith(q) || written.startsWith(q) || (value !== '' && value.startsWith(q))) {
        tier = 0;
      } else if (
        (e.path[e.path.length - 1] ?? '').toLowerCase().includes(q) ||
        (value !== '' && value.includes(q))
      ) {
        tier = 2;
      } else {
        tier = null;
      }
    }
    if (tier === null) continue;
    tiers[here !== null && e.tableId === here ? tier : ((tier + 1) as 1 | 3)].push(e);
  }
  const all = tiers.flat();
  return { entries: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
