/**
 * The format in force for one cell, for the grid to hand to `CellContent`
 * and `RichCellEditor`. Reads the Yjs table directly (React never owns a
 * copy); the caller's `useYVersion(table)` counter is what invalidates.
 *
 * Column records are resolved once per table per version and cached, so a
 * 10,000-cell table costs one `columnsArray` walk per change plus a map
 * lookup per cell — not an array copy per cell (PRD §20 16 ms budget).
 */
import { useMemo } from 'react';
import {
  cellFormatFor,
  columnsArray,
  columnRecord,
  isFormatLocale,
  type CellFormat,
  type ColumnRecord,
  type FormatLocale,
  type Id,
  type TableMap,
} from '@gede/core';

import { useLocale, type Locale } from '../../../locale.js';

export interface CellFormatContext {
  readonly format: CellFormat;
  readonly locale: FormatLocale;
}

/** `Locale` and `FormatLocale` are the same six strings; this is the typed bridge between the two modules. */
export function toFormatLocale(locale: Locale): FormatLocale {
  return isFormatLocale(locale) ? locale : 'en-US';
}

interface ColumnCache {
  version: number;
  columns: ReadonlyMap<Id, ColumnRecord>;
}

const cache = new WeakMap<TableMap, ColumnCache>();

/** The table's columns by id, resolved once per `version`. */
export function columnsOf(table: TableMap, version: number): ReadonlyMap<Id, ColumnRecord> {
  const hit = cache.get(table);
  if (hit?.version === version) return hit.columns;
  const columns = new Map<Id, ColumnRecord>();
  for (const map of columnsArray(table).toArray()) {
    const record = columnRecord(map);
    columns.set(record.id, record);
  }
  cache.set(table, { version, columns });
  return columns;
}

/** The effective format of one cell from the cached column record and its own override, if any. */
export function cellFormatAt(table: TableMap, rowId: Id, colId: Id, version: number): CellFormat {
  return cellFormatFor(table, columnsOf(table, version).get(colId) ?? null, rowId);
}

/**
 * @param version the table's `useYVersion` counter, so the memo refreshes with the document.
 */
export function useCellFormat(
  table: TableMap,
  rowId: Id,
  colId: Id,
  version: number,
): CellFormatContext {
  const [locale] = useLocale();
  return useMemo(
    () => ({ format: cellFormatAt(table, rowId, colId, version), locale: toFormatLocale(locale) }),
    [table, rowId, colId, locale, version],
  );
}
