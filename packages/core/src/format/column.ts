/**
 * Column scope (PRD §22 "Column scope", FMT-06): the format is set on the
 * column and inherited by every cell, present and future; a cell may
 * override it. `describeScope` is the sentence the inspector shows before a
 * change is applied.
 */
import {
  cellFormatMap,
  cellFormatOverride,
  columnsArray,
  columnRecord,
  readString,
  rowsArray,
  type ColumnRecord,
  type TableMap,
} from '../doc/schema.js';
import { cellKey, type Id } from '../ids.js';
import { AUTO_FORMAT, type CellFormat, type CurrencyCode, type FormatKind } from './types.js';

export function columnFormat(column: ColumnRecord): CellFormat {
  return { kind: column.format, opts: column.formatOpts };
}

export function columnById(table: TableMap, colId: Id): ColumnRecord | null {
  const map = columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
  return map === undefined ? null : columnRecord(map);
}

/**
 * The format in force for one cell: its own override, else its column's,
 * else Automatic. A row appended after the column was formatted has no
 * override, so it inherits (FMT-06) by construction.
 */
export function effectiveCellFormat(table: TableMap, rowId: Id, colId: Id): CellFormat {
  const column = columnById(table, colId);
  return cellFormatFor(table, column, rowId);
}

/**
 * The same, with the column already resolved. The grid resolves each column
 * once per render (`tableRecord`) and calls this per cell, so a 10,000-cell
 * table costs 10,000 map lookups per change, not 10,000 array copies.
 */
export function cellFormatFor(table: TableMap, column: ColumnRecord | null, rowId: Id): CellFormat {
  if (column === null) return AUTO_FORMAT;
  const override = cellFormatOverride(table, rowId, column.id);
  return override ?? columnFormat(column);
}

/** How many cells of a column carry their own override (the inspector names them). */
export function countOverrides(table: TableMap, colId: Id): number {
  const map = cellFormatMap(table);
  if (map === null) return 0;
  let n = 0;
  for (const rowId of rowsArray(table).toArray()) {
    if (map.get(cellKey(rowId, colId)) !== undefined) n += 1;
  }
  return n;
}

export const FORMAT_LABELS: Readonly<Record<FormatKind, string>> = {
  auto: 'Automatic',
  text: 'Text',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
};

export interface ScopeDescription {
  readonly columnLabel: string;
  readonly rowCount: number;
  readonly overrides: number;
  readonly to: FormatKind;
  readonly currency?: CurrencyCode;
  /** True when the change targets one cell rather than the column. */
  readonly cellOnly?: boolean;
  readonly address?: string;
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * FMT-06: the inspector states the scope before applying. Sentence case,
 * plain, specific; no exclamation marks (voice rules).
 */
export function describeScope(scope: ScopeDescription): string {
  const label =
    FORMAT_LABELS[scope.to] + (scope.currency === undefined ? '' : ` (${scope.currency})`);
  if (scope.cellOnly === true) {
    const where = scope.address === undefined ? 'this cell' : `cell ${scope.address}`;
    return `Formats ${where} as ${label}. Other cells in ${scope.columnLabel} keep the column format.`;
  }
  const rows = plural(scope.rowCount, 'row');
  const base = `Formats ${scope.columnLabel} as ${label} for all ${rows}, and for rows added later.`;
  if (scope.overrides === 0) return base;
  const kept =
    scope.overrides === 1
      ? '1 cell with its own format will keep it.'
      : `${String(scope.overrides)} cells with their own format will keep them.`;
  return `${base} ${kept}`;
}
