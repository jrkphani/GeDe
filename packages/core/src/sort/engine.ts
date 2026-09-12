/**
 * The message-shaped view engine (PRD §20: fuzzy and regex matching off the
 * main thread). One request in, one response out, ids matched by the client;
 * `apps/web/src/workers/sort.worker.ts` is the plumbing, and the main-thread
 * fallback there calls `handleViewRequest` directly. Never throws: a
 * malformed request is an `ok: false` response.
 *
 * `buildProjectionInput` is the other half: it reads a table's texts off the
 * Yjs document (main thread, cheap) into the plain object the engine takes,
 * sending only the columns the view reads.
 */
import type { CellValue } from '../formula/evaluate.js';
import { cellFormatFor } from '../format/column.js';
import { isFormatKind, readFormatOpts, type CellFormat } from '../format/types.js';
import { canonicalNumber } from '../format/value.js';
import {
  cellFormatMap,
  cellsMap,
  columnsArray,
  columnRecord,
  fragmentText,
  isFormula,
  rowsArray,
  type ColumnRecord,
  type TableMap,
} from '../doc/schema.js';
import { splitCellKey, type CellKey, type Id } from '../ids.js';
import { projectTableView } from './project.js';
import {
  isEmptyFilter,
  isFacetKind,
  isSortMode,
  type ProjectionColumn,
  type ProjectionInput,
  type ProjectionRow,
  type TableViewState,
  type ViewProjection,
} from './types.js';

export interface ViewRequest {
  readonly id: number;
  readonly tableId: Id;
  readonly input: ProjectionInput;
}

export type ViewResponse =
  | {
      readonly id: number;
      readonly tableId: Id;
      readonly ok: true;
      readonly projection: ViewProjection;
    }
  | { readonly id: number; readonly tableId: Id; readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCellFormat(value: unknown): value is CellFormat {
  return isRecord(value) && isFormatKind(value.kind) && isRecord(value.opts);
}

function isView(value: unknown): value is TableViewState {
  if (!isRecord(value)) return false;
  const { sortBy, filter, groupBy } = value;
  if (
    sortBy !== null &&
    !(isRecord(sortBy) && typeof sortBy.colId === 'string' && isSortMode(sortBy.mode))
  )
    return false;
  if (
    filter !== null &&
    !(
      isRecord(filter) &&
      (filter.colId === null || typeof filter.colId === 'string') &&
      typeof filter.text === 'string' &&
      typeof filter.fuzzy === 'boolean' &&
      (filter.facet === null || isFacetKind(filter.facet))
    )
  )
    return false;
  return groupBy === null || typeof groupBy === 'string';
}

function isProjectionRow(value: unknown): value is ProjectionRow {
  return (
    isRecord(value) &&
    typeof value.rowId === 'string' &&
    isRecord(value.cells) &&
    typeof value.empty === 'boolean' &&
    (value.formats === undefined || isRecord(value.formats))
  );
}

function isProjectionColumn(value: unknown): value is ProjectionColumn {
  return isRecord(value) && typeof value.id === 'string' && isCellFormat(value.format);
}

/** Runtime guard for a message arriving at the Worker. */
export function isViewRequest(value: unknown): value is ViewRequest {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'number' || typeof value.tableId !== 'string') return false;
  const input = value.input;
  return (
    isRecord(input) &&
    Array.isArray(input.columns) &&
    input.columns.every(isProjectionColumn) &&
    Array.isArray(input.rows) &&
    input.rows.every(isProjectionRow) &&
    isView(input.view) &&
    typeof input.locale === 'string'
  );
}

/** Run one request. */
export function handleViewRequest(request: ViewRequest): ViewResponse {
  try {
    return {
      id: request.id,
      tableId: request.tableId,
      ok: true,
      projection: projectTableView(request.input),
    };
  } catch (error) {
    return {
      id: request.id,
      tableId: request.tableId,
      ok: false,
      error: error instanceof Error ? error.message : 'projection failed',
    };
  }
}

/** The columns a view reads: the sort column, the group column, the filter's scope (or every column). */
export function columnsRead(
  view: TableViewState,
  columns: readonly ColumnRecord[],
): ColumnRecord[] {
  const wanted = new Set<Id>();
  if (view.sortBy !== null) wanted.add(view.sortBy.colId);
  if (view.groupBy !== null) wanted.add(view.groupBy);
  if (!isEmptyFilter(view.filter)) {
    if (view.filter.colId === null) for (const c of columns) wanted.add(c.id);
    else wanted.add(view.filter.colId);
  }
  return columns.filter((c) => wanted.has(c.id));
}

/**
 * The text a formula cell sorts, filters and facets by: its *evaluated* value
 * (SORT-04's use case is a derived column), spelled so the projection's
 * typed keys and the Smart Chip patterns read it — a plain decimal, an ISO
 * date, `CODE amount` for a currency. Pending, blank and error results are
 * blank, so a column still evaluating sorts as empty rather than as its
 * source text.
 */
export function evaluatedText(value: CellValue | null | undefined): string {
  if (value === null || value === undefined) return '';
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'number':
      return canonicalNumber(value.value);
    case 'currency':
      return `${value.code} ${canonicalNumber(value.value)}`;
    case 'date':
      return value.iso;
    case 'blank':
    case 'error':
      return '';
  }
}

export interface ProjectionInputOptions {
  /**
   * The evaluated value of a formula cell (FX-07), by cell key; `undefined`
   * while the engine has not answered. Without it a formula cell reads as its
   * source text, which is only right for tables with no formulas.
   */
  readonly cellValue?: ((key: CellKey) => CellValue | null | undefined) | undefined;
}

/**
 * Read a table into a `ProjectionInput`: document row order, plain text per
 * read column (a formula's evaluated value through `cellValue`), the row's
 * emptiness across *every* column, per-cell format overrides where they
 * exist. Hidden columns are still read — a sort on a hidden column is still
 * a sort.
 */
export function buildProjectionInput(
  table: TableMap,
  view: TableViewState,
  locale: string,
  options: ProjectionInputOptions = {},
): ProjectionInput {
  const columns = columnsArray(table).toArray().map(columnRecord);
  const read = columnsRead(view, columns);
  const readIds = new Set(read.map((c) => c.id));
  const texts = new Map<Id, Record<Id, string>>();
  const nonEmpty = new Set<Id>();
  cellsMap(table).forEach((content, key) => {
    const { rowId, colId } = splitCellKey(key);
    // A formula cell is content even while its value is pending or blank.
    if (isFormula(content)) nonEmpty.add(rowId);
    const text = isFormula(content)
      ? evaluatedText(options.cellValue?.(key as CellKey))
      : fragmentText(content);
    if (text === '') return;
    nonEmpty.add(rowId);
    if (!readIds.has(colId)) return;
    let row = texts.get(rowId);
    if (row === undefined) {
      row = {};
      texts.set(rowId, row);
    }
    row[colId] = text;
  });
  const overrides = cellFormatMap(table);
  const rows: ProjectionRow[] = rowsArray(table)
    .toArray()
    .map((rowId) => {
      const cells = texts.get(rowId) ?? {};
      let formats: Record<Id, CellFormat> | undefined;
      if (overrides !== null) {
        for (const column of read) {
          const entry = overrides.get(`${rowId}:${column.id}`);
          if (!isRecord(entry) || !isFormatKind(entry.format)) continue;
          formats ??= {};
          formats[column.id] = cellFormatFor(table, column, rowId);
        }
      }
      return formats === undefined
        ? { rowId, cells, empty: !nonEmpty.has(rowId) }
        : { rowId, cells, formats, empty: !nonEmpty.has(rowId) };
    });
  return {
    columns: read.map((c) => ({
      id: c.id,
      format: { kind: c.format, opts: readFormatOpts(c.formatOpts) },
    })),
    rows,
    view,
    locale,
  };
}
