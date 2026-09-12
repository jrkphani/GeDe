/**
 * `useCellDisplay(table, key)` — what a formula cell shows (FX-07): the
 * evaluated value rendered under the cell's own format (PRD §22 "the result
 * cell takes the operands' format": a Sum in a Currency column reads
 * `SGD 2,554.50` with the column's decimals, right-aligned; an Automatic
 * column keeps the inferred rendering), the expression projected to today's
 * addresses (PRD §20: ids stored, A1 shown), the reference badge and any
 * error. Subscribes to that cell's engine result and to the workbook's
 * shape; the caller re-renders it when the cell's own text or format changes
 * (TableView already watches its table).
 */
import {
  AUTO_FORMAT,
  cellErrorLabel,
  cellErrorMessage,
  cellsMap,
  effectiveCellFormat,
  fragmentText,
  isFormula,
  isFormatLocale,
  readString,
  renderValue,
  splitCellKey,
  workbookCellId,
  type CellFormat,
  type CellKey,
  type CellResult,
  type CellValue,
  type ResolvedOperand,
  type TableMap,
} from '@gede/core';

import { useCellResult } from '../../../doc/engine.js';
import { useWorkbookIndexVersion } from '../../../doc/workbook-index.js';
import { formatDate, formatNumber } from '../../../intl.js';
import { useLocale, type Locale } from '../../../locale.js';
import { docOf, projectSource } from './workbook.js';

export interface CellDisplay {
  readonly isFormula: boolean;
  /** Text to render: the cell's text, or the formula's value (empty while pending or in error). */
  readonly value: string;
  /** Numbers and amounts right (FMT-02, FMT-03); text, dates and errors left. */
  readonly align: 'left' | 'right';
  /**
   * The expression as the person reads it today (`=Sum(B5:B6)`), for the
   * secondary line and for re-opening the editor (FX-07); null for text cells.
   */
  readonly formula: string | null;
  /** Icon + text, never hue alone (A11Y-04). */
  readonly error: { readonly label: string; readonly message: string } | null;
  /** Badge text for a formula cell (`ƒ`, or `ƒ3` with the reference count); null otherwise. */
  readonly badge: string | null;
  readonly operands: readonly ResolvedOperand[];
  /** True until the Worker has answered for this exact source. */
  readonly pending: boolean;
  /** How many operands follow an address rather than a cell (PRD §20); the badge says so. */
  readonly positional: number;
}

const TEXT_DISPLAY = (value: string): CellDisplay => ({
  isFormula: false,
  value,
  align: 'left',
  formula: null,
  error: null,
  badge: null,
  operands: [],
  pending: false,
  positional: 0,
});

/** Automatic: the inferred rendering — a number groups to at most 6 places, an amount goes through Intl. */
export function formatCellValue(locale: Locale, value: CellValue): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'number':
      return formatNumber(locale, value.value, { maximumFractionDigits: 6 });
    case 'currency':
      try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: value.code }).format(
          value.value,
        );
      } catch {
        return `${value.code} ${formatNumber(locale, value.value, { maximumFractionDigits: 2 })}`;
      }
    case 'date':
      return formatDate(locale, value.iso);
    case 'blank':
      return '';
    case 'list':
      return value.items.map((item) => formatCellValue(locale, item)).join(', ');
    case 'error':
      return cellErrorLabel(value.error);
  }
}

export function badgeFor(operands: readonly ResolvedOperand[]): string {
  return operands.length === 0 ? 'ƒ' : `ƒ${String(operands.length)}`;
}

/**
 * A result rendered for the cell it sits in (PRD §22 "the result cell takes
 * the operands' format"; FMT-02, FMT-03, FMT-04): under an explicit format
 * the value goes through the same `renderValue` a typed cell does — a
 * Number column's decimals and grouping, a Currency column's accounting
 * parentheses, a Date column's pattern — and right-aligns when numeric.
 * Under Automatic the inferred rendering stands. Lists and errors are text.
 */
export function renderResult(
  locale: Locale,
  value: CellValue,
  format: CellFormat,
): { readonly text: string; readonly align: 'left' | 'right' } {
  const numeric = value.kind === 'number' || value.kind === 'currency';
  if (format.kind === 'auto' || value.kind === 'list' || value.kind === 'error') {
    return { text: formatCellValue(locale, value), align: numeric ? 'right' : 'left' };
  }
  const rendered = renderValue(value, format, isFormatLocale(locale) ? locale : undefined);
  return { text: rendered.text, align: rendered.align };
}

/**
 * The display for a stored source and its (possibly stale) result. A result
 * for a different source — the person just committed a new formula and the
 * Worker has not answered yet — is pending, never a value under the wrong
 * expression. `format` is the cell's effective format (column, or its own
 * override); Automatic when the caller has none.
 */
export function displayOf(
  locale: Locale,
  source: string,
  shown: string,
  result: CellResult | undefined,
  format: CellFormat = AUTO_FORMAT,
): CellDisplay {
  if (result?.source !== source) {
    return {
      isFormula: true,
      value: '',
      align: 'left',
      formula: shown,
      error: null,
      badge: 'ƒ',
      operands: [],
      pending: true,
      positional: 0,
    };
  }
  const error =
    result.error === null
      ? null
      : { label: cellErrorLabel(result.error), message: cellErrorMessage(result.error) };
  const rendered =
    result.value === null || error !== null
      ? { text: '', align: 'left' as const }
      : renderResult(locale, result.value, format);
  return {
    isFormula: true,
    value: rendered.text,
    align: rendered.align,
    formula: shown,
    error,
    badge: badgeFor(result.operands),
    operands: result.operands,
    pending: false,
    positional: result.operands.filter((o) => !o.anchored).length,
  };
}

/**
 * Contract for the grid editor: pass the table map and the cell key. The map
 * carries both the document (engine lookup) and the table id (cell identity).
 * `format` is the cell's effective format when the caller already resolved
 * it (the grid does, per column); otherwise it is read from the table here.
 */
export function useCellDisplay(table: TableMap, key: CellKey, format?: CellFormat): CellDisplay {
  const doc = docOf(table);
  useWorkbookIndexVersion(doc);
  const [locale] = useLocale();
  const content = cellsMap(table).get(key);
  const cellId = workbookCellId(readString(table, 'id'), key);
  const result = useCellResult(doc, cellId);
  if (content === undefined) return TEXT_DISPLAY('');
  if (!isFormula(content)) return TEXT_DISPLAY(fragmentText(content));
  const { rowId, colId } = splitCellKey(key);
  const effective = format ?? effectiveCellFormat(table, rowId, colId);
  return displayOf(locale, content, projectSource(doc, content), result, effective);
}
