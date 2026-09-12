/**
 * The projection (SORT-01..05): filter, then sort, then group — in that order,
 * so "the active order and predicate are preserved within each band" (PRD
 * §15). Pure and synchronous; the Worker (`engine.ts`) and any direct caller
 * share it. Rows go in as document order and come out as view order; row ids
 * are the only thing that moves, so addresses stay where they are.
 *
 * Rows with no content anywhere are never filtered out and never banded: a
 * row appended past the end of a filtered table stays visible to type into,
 * and an empty table grouped by a column does not become one "blank" band.
 */
import { AUTO_FORMAT, type CellFormat } from '../format/types.js';
import { approximateFind } from '../search/distance.js';
import { foldGraphemes } from '../search/graphemes.js';
import { fuzzyBudget } from '../search/matcher.js';
import { chipRegExp } from '../text/chips.js';
import type { Id } from '../ids.js';
import {
  charCount,
  createCollator,
  createComparator,
  freqKey,
  sortKey,
  wordCount,
  type Comparable,
} from './collate.js';
import {
  isEmptyFilter,
  type Band,
  type ProjectionInput,
  type ProjectionRow,
  type ViewProjection,
} from './types.js';

/** The band key for a grouped value; stable across re-sorts so collapse state follows the value. */
export function bandKey(value: string): string {
  return `value:${value}`;
}

function cellFormat(
  row: ProjectionRow,
  colId: Id,
  columnFormats: ReadonlyMap<Id, CellFormat>,
): CellFormat {
  return row.formats?.[colId] ?? columnFormats.get(colId) ?? AUTO_FORMAT;
}

function scopedTexts(row: ProjectionRow, scope: readonly Id[]): string[] {
  const out: string[] = [];
  for (const colId of scope) {
    const text = row.cells[colId];
    if (text !== undefined && text !== '') out.push(text);
  }
  return out;
}

/** True when the row passes the filter (SORT-01 contains, SORT-03 fuzzy, SORT-04 facet). */
function keep(
  row: ProjectionRow,
  scope: readonly Id[],
  needle: readonly string[],
  budget: number,
  facet: RegExp | null,
): boolean {
  const texts = scopedTexts(row, scope);
  if (needle.length > 0) {
    const hit = texts.some((t) => approximateFind(foldGraphemes(t), needle, budget) !== null);
    if (!hit) return false;
  }
  if (facet !== null) {
    const hit = texts.some((t) => facet.test(t));
    if (!hit) return false;
  }
  return true;
}

export function projectTableView(input: ProjectionInput): ViewProjection {
  const { view, locale } = input;
  const columnIds = input.columns.map((c) => c.id);
  const columnFormats = new Map(input.columns.map((c) => [c.id, c.format]));

  // 1. Filter. Empty rows are exempt (see the module note).
  let rows: readonly ProjectionRow[] = input.rows;
  if (!isEmptyFilter(view.filter)) {
    const filter = view.filter;
    const scope = filter.colId === null ? columnIds : [filter.colId];
    const needle = foldGraphemes(filter.text.trim());
    const budget = filter.fuzzy ? fuzzyBudget(needle.length) : 0;
    const facet = filter.facet === null ? null : chipRegExp(filter.facet);
    rows = rows.filter((row) => row.empty || keep(row, scope, needle, budget, facet));
  }
  const kept = new Set(rows.map((r) => r.rowId));
  const hiddenRowIds = input.rows.filter((r) => !kept.has(r.rowId)).map((r) => r.rowId);

  // 2. Sort. Stable, so ties keep document order; blanks last in every mode.
  if (view.sortBy !== null) {
    const { colId, mode } = view.sortBy;
    const collator = createCollator(locale);
    const compare = createComparator(mode, collator);
    const freq = new Map<string, number>();
    if (mode === 'freq') {
      for (const row of rows) {
        const k = freqKey(row.cells[colId] ?? '');
        if (k !== '') freq.set(k, (freq.get(k) ?? 0) + 1);
      }
    }
    const keyed = rows.map((row): { row: ProjectionRow; c: Comparable } => {
      const text = row.cells[colId] ?? '';
      return {
        row,
        c: {
          key: sortKey(text, cellFormat(row, colId, columnFormats)),
          chars: mode === 'chars' ? charCount(text) : 0,
          words: mode === 'words' ? wordCount(text, locale) : 0,
          freq: mode === 'freq' ? (freq.get(freqKey(text)) ?? 0) : 0,
        },
      };
    });
    keyed.sort((a, b) => compare(a.c, b.c));
    rows = keyed.map((k) => k.row);
  }

  // 3. Group. Bands in order of first appearance, so the sort orders the bands too.
  if (view.groupBy === null) {
    return { rowIds: rows.map((r) => r.rowId), bands: null, loose: [], hiddenRowIds };
  }
  const groupBy = view.groupBy;
  const byValue = new Map<string, Id[]>();
  const loose: Id[] = [];
  for (const row of rows) {
    if (row.empty) {
      loose.push(row.rowId);
      continue;
    }
    const value = row.cells[groupBy] ?? '';
    const list = byValue.get(value);
    if (list === undefined) byValue.set(value, [row.rowId]);
    else list.push(row.rowId);
  }
  const bands: Band[] = [];
  const rowIds: Id[] = [];
  for (const [value, ids] of byValue) {
    bands.push({ key: bandKey(value), value, rowIds: ids });
    rowIds.push(...ids);
  }
  rowIds.push(...loose);
  return { rowIds, bands, loose, hiddenRowIds };
}
