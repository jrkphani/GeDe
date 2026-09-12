/**
 * `useCellDisplay(table, key)` — what a cell shows (FX-07). For a formula
 * cell: the evaluated value formatted for the active locale, the expression
 * for the secondary line, the reference badge and any error; for a text
 * cell: its text. Subscribes to exactly that cell's engine result.
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
  type OperandOutline,
  type TableMap,
} from '@gede/core';

import { useCellResult } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { formatDate, formatNumber } from '../../../intl.js';
import { useLocale, type Locale } from '../../../locale.js';

export interface CellDisplay {
  readonly isFormula: boolean;
  /** Text to render: the cell's text, or the formula's value (empty while pending or in error). */
  readonly value: string;
  /** The expression for the secondary line and for re-opening the editor (FX-07); null for text cells. */
  readonly formula: string | null;
  /** Icon + text, never hue alone (A11Y-04). */
  readonly error: { readonly label: string; readonly message: string } | null;
  /** Badge text for a formula cell (`ƒ`, or `ƒ3` with the reference count); null otherwise. */
  readonly badge: string | null;
  readonly operands: readonly OperandOutline[];
  /** True until the Worker has answered for this formula. */
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

export function badgeFor(operands: readonly OperandOutline[]): string {
  return operands.length === 0 ? 'ƒ' : `ƒ${String(operands.length)}`;
}

export function displayOf(
  locale: Locale,
  source: string,
  result: CellResult | undefined,
): CellDisplay {
  if (result === undefined) {
    return {
      isFormula: true,
      value: '',
      formula: source,
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
    formula: source,
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
  useYVersion(table);
  const [locale] = useLocale();
  const content = cellsMap(table).get(key);
  const cellId = workbookCellId(readString(table, 'id'), key);
  const result = useCellResult(table.doc ?? raiseNoDoc(), cellId);
  if (content === undefined) return TEXT_DISPLAY('');
  if (!isFormula(content)) return TEXT_DISPLAY(fragmentText(content));
  return displayOf(locale, content, result);
}

function raiseNoDoc(): never {
  throw new Error('useCellDisplay needs a table that is integrated into a Y.Doc');
}
