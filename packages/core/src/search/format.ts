/**
 * Resolved cell format for the `is:` operator (FIND-04, FMT-*).
 *
 * The column's stored `format` wins when it is one of the four kinds; an
 * `automatic` (or absent) column falls back to inference over the cell's
 * text, the same way the automatic format resolves at render time. Inference
 * is deliberately conservative: a value must look like a currency, date or
 * number in one of the supported locales to be called one; everything else
 * is text.
 */
import { isFormatKind, type FormatKind } from './query.js';

/** ISO 4217 codes the PRD names, plus the symbols they render with. */
const CURRENCY_CODES = /^(SGD|MYR|PHP|IDR|USD|INR|GBP|EUR|AUD|JPY|CNY|HKD)$/i;
const CURRENCY_SYMBOL = /^[$€£₹¥₱]|^(RM|Rp|S\$|US\$|A\$|HK\$)/;
/** Digits with optional grouping (Western or Indian) and decimals, optional sign. */
const NUMBER = /^[-+−]?(\d{1,3}([,\s]\d{2,3})*|\d+)(\.\d+)?%?$/;
const DEVANAGARI_OR_TAMIL_DIGITS = /^[-+−]?[०-९௦-௯]+([.,][०-९௦-௯]+)?$/;
/** ISO 8601, d/m/y or m/d/y with a four-digit year, and "12 Sep 2026" / "Sep 12, 2026". */
const DATE_ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[-+]\d{2}:?\d{2})?)?$/;
const DATE_SLASHED = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/;
const DATE_WORDED =
  /^(\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}|[A-Za-z]{3,9}\s+\d{4})$/;

function stripCurrency(text: string): string | null {
  const trimmed = text.trim();
  const symbol = CURRENCY_SYMBOL.exec(trimmed);
  if (symbol !== null) return trimmed.slice(symbol[0].length).trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    const [a, b] = parts;
    if (a !== undefined && b !== undefined) {
      if (CURRENCY_CODES.test(a)) return b;
      if (CURRENCY_CODES.test(b)) return a;
    }
  }
  return null;
}

function looksNumeric(text: string): boolean {
  return NUMBER.test(text) || DEVANAGARI_OR_TAMIL_DIGITS.test(text);
}

/** Infer the format of one cell's plain text. Empty text is text. */
export function inferFormat(text: string): FormatKind {
  const trimmed = text.trim();
  if (trimmed === '') return 'text';
  const amount = stripCurrency(trimmed);
  if (amount !== null && amount !== '' && looksNumeric(amount)) return 'currency';
  if (looksNumeric(trimmed)) return 'number';
  if (DATE_ISO.test(trimmed) || DATE_SLASHED.test(trimmed) || DATE_WORDED.test(trimmed)) {
    return 'date';
  }
  return 'text';
}

/**
 * The format the `is:` operator sees: the column's declared format when it is
 * explicit, else inference. `columnFormat` is whatever the column map stores
 * under `format` (the formats work stores `automatic | text | number |
 * currency | date`); anything unrecognised means automatic.
 */
export function resolveFormat(text: string, columnFormat: unknown): FormatKind {
  if (typeof columnFormat === 'string') {
    const kind = columnFormat.toLowerCase();
    if (isFormatKind(kind)) return kind;
  }
  return inferFormat(text);
}
