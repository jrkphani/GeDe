/**
 * Sort, filter and grouping — a table's *view* state (SORT-01..06, PRD §9,
 * §15). Presentation only: none of it moves a row in `rows`, so no A1 address
 * and no row id ever changes because of it (non-negotiable 3, HIER-09).
 *
 * Per viewer, never document state (ADR-026): `apps/web/src/doc/view-state.ts`
 * keeps one `TableViewState` per (user, document, table) on the device, and
 * the hierarchy layer reads `groupBy` from there for HIER-08. This module
 * holds the shape, its validation and the pure projection; the document layer
 * knows nothing of it.
 */
import type { CellFormat } from '../format/types.js';
import type { Id } from '../ids.js';

/** SORT-01: the six header-menu entries; None is the absence of `sortBy`. */
export const SORT_MODES = ['az', 'za', 'chars', 'words', 'freq'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export const SORT_MODE_LABELS: Readonly<Record<SortMode, string>> = {
  az: 'A–Z',
  za: 'Z–A',
  chars: 'Chars',
  words: 'Words',
  freq: 'Freq',
};

export interface SortBy {
  readonly colId: Id;
  readonly mode: SortMode;
}

/** SORT-04: the entity facets, each a Smart Chip pattern (`text/chips.ts`). */
export const FACET_KINDS = ['country', 'company', 'email', 'date', 'currency'] as const;
export type FacetKind = (typeof FACET_KINDS)[number];

export const FACET_LABELS: Readonly<Record<FacetKind, string>> = {
  country: 'Country',
  company: 'Company',
  email: 'Email',
  date: 'Date',
  currency: 'Currency',
};

export interface TableFilter {
  /** The column the contains filter and facet read; null means any column. */
  readonly colId: Id | null;
  /** The contains text; '' when only a facet is set. */
  readonly text: string;
  /** SORT-03: tolerate up to two edits, counted in grapheme clusters. */
  readonly fuzzy: boolean;
  readonly facet: FacetKind | null;
}

export interface TableViewState {
  readonly sortBy: SortBy | null;
  readonly filter: TableFilter | null;
  readonly groupBy: Id | null;
}

export const EMPTY_VIEW: TableViewState = { sortBy: null, filter: null, groupBy: null };

export function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && (SORT_MODES as readonly string[]).includes(value);
}

export function isFacetKind(value: unknown): value is FacetKind {
  return typeof value === 'string' && (FACET_KINDS as readonly string[]).includes(value);
}

/** True when the filter would keep every row: nothing to match against. */
export function isEmptyFilter(filter: TableFilter | null): filter is null {
  return filter === null || (filter.text.trim() === '' && filter.facet === null);
}

export function isViewActive(view: TableViewState): boolean {
  return view.sortBy !== null || !isEmptyFilter(view.filter) || view.groupBy !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate a stored view (persisted JSON, or one written by an older build)
 * against the columns a table has now: a sort or grouping on a column that
 * no longer exists reads as none, a filter scoped to one falls back to every
 * column, and an empty filter reads as none. Pass `{ has: () => true }` to
 * check the shape alone (a store that does not know the table's columns).
 */
export function normaliseTableView(
  value: unknown,
  columnIds: Pick<ReadonlySet<Id>, 'has'>,
): TableViewState {
  if (!isRecord(value)) return EMPTY_VIEW;
  let sortBy: SortBy | null = null;
  const s = value.sortBy;
  if (isRecord(s) && typeof s.colId === 'string' && isSortMode(s.mode) && columnIds.has(s.colId)) {
    sortBy = { colId: s.colId, mode: s.mode };
  }
  let filter: TableFilter | null = null;
  const f = value.filter;
  if (isRecord(f)) {
    const colId = typeof f.colId === 'string' && columnIds.has(f.colId) ? f.colId : null;
    const candidate: TableFilter = {
      colId,
      text: typeof f.text === 'string' ? f.text : '',
      fuzzy: f.fuzzy === true,
      facet: isFacetKind(f.facet) ? f.facet : null,
    };
    filter = isEmptyFilter(candidate) ? null : candidate;
  }
  const g = value.groupBy;
  const groupBy = typeof g === 'string' && columnIds.has(g) ? g : null;
  return { sortBy, filter, groupBy };
}

// ---------------------------------------------------------------------------
// Projection input and output: plain objects, so the Worker boundary is the
// same shape as a direct call (`project.ts`).
// ---------------------------------------------------------------------------

export interface ProjectionColumn {
  readonly id: Id;
  /** The column's format (FMT-01): A–Z on a Number or Date column orders by value, not text. */
  readonly format: CellFormat;
}

export interface ProjectionRow {
  readonly rowId: Id;
  /** Plain text per column id; absent means the cell is empty. */
  readonly cells: Readonly<Record<Id, string>>;
  /** Per-cell format overrides (FMT-01), only where one exists. */
  readonly formats?: Readonly<Record<Id, CellFormat>> | undefined;
  /** True when no cell in the row (any column) has content. */
  readonly empty: boolean;
}

export interface ProjectionInput {
  readonly columns: readonly ProjectionColumn[];
  /** Rows in document order — the order `rows` stores, so addresses are untouched. */
  readonly rows: readonly ProjectionRow[];
  readonly view: TableViewState;
  /** SORT-02: the active locale's collation. */
  readonly locale: string;
}

export interface Band {
  /** Stable per value, so collapse state survives a re-sort: `value:<text>`. */
  readonly key: string;
  /** The grouped column's text; '' for rows whose grouped cell is blank. */
  readonly value: string;
  readonly rowIds: readonly Id[];
}

export interface ViewProjection {
  /** Visible rows in view order: filtered, then sorted, then grouped (SORT-05). */
  readonly rowIds: readonly Id[];
  /** Present only when `groupBy` is set: bands in view order, followed by `loose`. */
  readonly bands: readonly Band[] | null;
  /** Under grouping, entirely empty rows stay ungrouped after the bands. */
  readonly loose: readonly Id[];
  /** Rows the filter removed, in document order. */
  readonly hiddenRowIds: readonly Id[];
}
