/**
 * The format in force for one cell, for the grid to hand to `CellContent`
 * and `RichCellEditor`. Reads the Yjs table directly (React never owns a
 * copy); the caller's `useYVersion(table)` is what triggers a re-render when
 * a column format or a cell override changes.
 */
import { useMemo } from 'react';
import {
  effectiveCellFormat,
  isFormatLocale,
  type CellFormat,
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
    () => ({ format: effectiveCellFormat(table, rowId, colId), locale: toFormatLocale(locale) }),
    // `version` is the change signal; it is not read.
    [table, rowId, colId, locale, version],
  );
}
