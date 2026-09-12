/**
 * The matcher (FIND-04, FIND-05): runs a parsed query over snapshot entries
 * and returns ranked matches. Pure and synchronous, so the Worker and the
 * main-thread fallback share it.
 *
 * Ranking: cells first, then graphs, then library documents (each a group of
 * its own in the result list); within a group exact hits before fuzzy ones
 * (by distance), then document order — sheet, table (ULIDs sort by
 * creation), row, column. Stepping with ⌘G therefore walks the canvas in
 * reading order and never jumps between a near miss and an exact hit.
 */
import { approximateFind, type Found } from './distance.js';
import { foldGraphemes } from './graphemes.js';
import { parseQuery, type FormatKind, type ParsedQuery } from './query.js';
import type { CellEntry, SearchEntry, SearchField, SearchText } from './snapshot.js';

/** FIND-05: at most two edits; short needles get less so "ab" does not match everything. */
export const MAX_EDIT_DISTANCE = 2;

export function fuzzyBudget(needleClusters: number): number {
  if (needleClusters <= 2) return 0;
  if (needleClusters <= 5) return 1;
  return MAX_EDIT_DISTANCE;
}

export interface SearchOptions {
  /** FIND-05: on by default. */
  readonly fuzzy: boolean;
  /** Gear: search formula expressions and reference paths. */
  readonly formulas: boolean;
  /** Gear: include library document names. */
  readonly documents: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  fuzzy: true,
  formulas: true,
  documents: true,
};

export type MatchTarget =
  | {
      readonly kind: 'cell';
      readonly sheetId: string;
      readonly sheetOrdinal: number;
      readonly tableId: string;
      readonly tableTitle: string;
      readonly rowId: string;
      readonly colId: string;
      readonly rowIndex: number;
      readonly colIndex: number;
      readonly colLabel: string;
      readonly format: FormatKind;
    }
  | {
      readonly kind: 'graph';
      readonly sheetId: string;
      readonly sheetOrdinal: number;
      readonly graphId: string;
      readonly title: string;
    }
  | { readonly kind: 'document'; readonly docId: string; readonly title: string };

export interface SearchMatch {
  /** `${entryId}#${field}` — stable while the entry's text is unchanged. */
  readonly id: string;
  readonly entryId: string;
  readonly field: SearchField;
  /** The text that matched, as stored. */
  readonly text: string;
  readonly distance: number;
  /** Grapheme offsets of the matched span in `text`; equal when the whole entry matched by operator alone. */
  readonly start: number;
  readonly end: number;
  /** FIND-08: never rewritten by Replace. */
  readonly readOnly: boolean;
  readonly target: MatchTarget;
}

const FIELD_ORDER: Record<SearchField, number> = {
  value: 0,
  formula: 1,
  reference: 2,
  dimension: 3,
  name: 4,
};
const KIND_ORDER = { cell: 0, graph: 1, document: 2 } as const;

function targetOf(entry: SearchEntry): MatchTarget {
  switch (entry.kind) {
    case 'cell':
      return {
        kind: 'cell',
        sheetId: entry.sheetId,
        sheetOrdinal: entry.sheetOrdinal,
        tableId: entry.tableId,
        tableTitle: entry.tableTitle,
        rowId: entry.rowId,
        colId: entry.colId,
        rowIndex: entry.rowIndex,
        colIndex: entry.colIndex,
        colLabel: entry.colLabel,
        format: entry.format,
      };
    case 'graph':
      return {
        kind: 'graph',
        sheetId: entry.sheetId,
        sheetOrdinal: entry.sheetOrdinal,
        graphId: entry.graphId,
        title: entry.title,
      };
    case 'document':
      return { kind: 'document', docId: entry.docId, title: entry.title };
  }
}

/** Column labels repeat across every row of a table: fold each label once per query. */
function columnMatcher(columns: readonly (readonly string[])[], budget: number) {
  const cache = new Map<string, boolean>();
  return (entry: CellEntry): boolean => {
    const hit = cache.get(entry.colLabel);
    if (hit !== undefined) return hit;
    const label = foldGraphemes(entry.colLabel);
    const matches = columns.some((needle) => approximateFind(label, needle, budget) !== null);
    cache.set(entry.colLabel, matches);
    return matches;
  };
}

function searchable(field: SearchField, options: SearchOptions): boolean {
  if (field === 'formula' || field === 'reference') return options.formulas;
  return true;
}

function bestText(
  texts: readonly SearchText[],
  needle: readonly string[],
  budget: number,
  options: SearchOptions,
): { text: SearchText; found: Found } | null {
  let best: { text: SearchText; found: Found } | null = null;
  for (const t of texts) {
    if (!searchable(t.field, options)) continue;
    const found = approximateFind(t.folded, needle, budget);
    if (found === null) continue;
    if (
      best === null ||
      found.distance < best.found.distance ||
      (found.distance === best.found.distance &&
        FIELD_ORDER[t.field] < FIELD_ORDER[best.text.field])
    ) {
      best = { text: t, found };
    }
    if (best.found.distance === 0 && best.text.field === 'value') break;
  }
  return best;
}

function compare(a: SearchMatch, b: SearchMatch): number {
  const ka = KIND_ORDER[a.target.kind];
  const kb = KIND_ORDER[b.target.kind];
  if (ka !== kb) return ka - kb;
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.target.kind === 'cell' && b.target.kind === 'cell') {
    return (
      a.target.sheetOrdinal - b.target.sheetOrdinal ||
      (a.target.tableId < b.target.tableId ? -1 : a.target.tableId > b.target.tableId ? 1 : 0) ||
      a.target.rowIndex - b.target.rowIndex ||
      a.target.colIndex - b.target.colIndex ||
      FIELD_ORDER[a.field] - FIELD_ORDER[b.field]
    );
  }
  if (a.target.kind === 'graph' && b.target.kind === 'graph') {
    return (
      a.target.sheetOrdinal - b.target.sheetOrdinal ||
      (a.target.graphId < b.target.graphId ? -1 : a.target.graphId > b.target.graphId ? 1 : 0)
    );
  }
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** Run `query` over `entries`. An empty query yields no matches. */
export function search(
  entries: Iterable<SearchEntry>,
  query: string | ParsedQuery,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): SearchMatch[] {
  const q = typeof query === 'string' ? parseQuery(query) : query;
  const needle = foldGraphemes(q.phrase);
  const hasPhrase = needle.length > 0;
  const hasOperators = q.columns.length > 0 || q.formats.length > 0;
  if (!hasPhrase && !hasOperators) return [];
  const budget = options.fuzzy ? fuzzyBudget(needle.length) : 0;
  const inColumn = columnMatcher(q.columns.map(foldGraphemes), options.fuzzy ? 1 : 0);
  const out: SearchMatch[] = [];
  for (const entry of entries) {
    if (entry.kind === 'document' && !options.documents) continue;
    if (hasOperators) {
      // Operators name columns and formats: only cells have them.
      if (entry.kind !== 'cell') continue;
      if (q.columns.length > 0 && !inColumn(entry)) continue;
      if (q.formats.length > 0 && !q.formats.includes(entry.format)) continue;
    }
    if (!hasPhrase) {
      const first = entry.texts.find((t) => searchable(t.field, options));
      if (first === undefined) continue;
      out.push({
        id: `${entry.id}#${first.field}`,
        entryId: entry.id,
        field: first.field,
        text: first.text,
        distance: 0,
        start: 0,
        end: 0,
        readOnly: entry.readOnly,
        target: targetOf(entry),
      });
      continue;
    }
    const best = bestText(entry.texts, needle, budget, options);
    if (best === null) continue;
    out.push({
      id: `${entry.id}#${best.text.field}`,
      entryId: entry.id,
      field: best.text.field,
      text: best.text.text,
      distance: best.found.distance,
      start: best.found.start,
      end: best.found.end,
      readOnly: entry.readOnly,
      target: targetOf(entry),
    });
  }
  return out.sort(compare);
}
