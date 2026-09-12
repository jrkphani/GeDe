/**
 * `useCellDisplay(table, key)` — what a formula cell shows (FX-07): the
 * evaluated value formatted for the active locale, the expression projected
 * to today's addresses (PRD §20: ids stored, A1 shown), the reference badge
 * and any error. Subscribes to that cell's engine result and to the
 * workbook's shape; the caller re-renders it when the cell's own text changes
 * (TableView already watches its table).
 */
import {
  cellErrorLabel,
  cellErrorMessage,
  cellsMap,
  fragmentText,
  isFormula,
  readString,
  workbookCellId,
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
}

const TEXT_DISPLAY = (value: string): CellDisplay => ({
  isFormula: false,
  value,
  formula: null,
  error: null,
  badge: null,
  operands: [],
  pending: false,
});

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
    case 'error':
      return cellErrorLabel(value.error);
  }
}

export function badgeFor(operands: readonly ResolvedOperand[]): string {
  return operands.length === 0 ? 'ƒ' : `ƒ${String(operands.length)}`;
}

/**
 * The display for a stored source and its (possibly stale) result. A result
 * for a different source — the person just committed a new formula and the
 * Worker has not answered yet — is pending, never a value under the wrong
 * expression.
 */
export function displayOf(
  locale: Locale,
  source: string,
  shown: string,
  result: CellResult | undefined,
): CellDisplay {
  if (result?.source !== source) {
    return {
      isFormula: true,
      value: '',
      formula: shown,
      error: null,
      badge: 'ƒ',
      operands: [],
      pending: true,
    };
  }
  const error =
    result.error === null
      ? null
      : { label: cellErrorLabel(result.error), message: cellErrorMessage(result.error) };
  return {
    isFormula: true,
    value: result.value === null || error !== null ? '' : formatCellValue(locale, result.value),
    formula: shown,
    error,
    badge: badgeFor(result.operands),
    operands: result.operands,
    pending: false,
  };
}

/**
 * Contract for the grid editor: pass the table map and the cell key. The map
 * carries both the document (engine lookup) and the table id (cell identity).
 */
export function useCellDisplay(table: TableMap, key: CellKey): CellDisplay {
  const doc = docOf(table);
  useWorkbookIndexVersion(doc);
  const [locale] = useLocale();
  const content = cellsMap(table).get(key);
  const cellId = workbookCellId(readString(table, 'id'), key);
  const result = useCellResult(doc, cellId);
  if (content === undefined) return TEXT_DISPLAY('');
  if (!isFormula(content)) return TEXT_DISPLAY(fragmentText(content));
  return displayOf(locale, content, projectSource(doc, content), result);
}
