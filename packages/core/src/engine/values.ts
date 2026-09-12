/**
 * Automatic format inference (PRD §22 "Automatic: infers Number, Currency,
 * Date or Text; never rewrites stored text, only picks the numeric parse").
 *
 * Only an Automatic column is read this way. An explicit Number, Currency or
 * Date format reaches the engine with the table structure and is resolved by
 * `format/value.ts` (`cellValueOf`), so a formatted cell yields the value its
 * format parses and an unparsable one is excluded (FMT-02, FMT-03, FMT-05).
 */
import type { CellValue } from '../formula/evaluate.js';

/** Symbols the inference recognises, longest first so `S$` wins over `$`. */
const SYMBOLS: readonly (readonly [string, string])[] = [
  ['S$', 'SGD'],
  ['RM', 'MYR'],
  ['Rp', 'IDR'],
  ['₱', 'PHP'],
  ['₹', 'INR'],
  ['$', 'USD'],
  ['£', 'GBP'],
  ['€', 'EUR'],
];
const CODE_RE = /^[A-Z]{3}$/;
/** Digits with optional grouping (`1,234,567.89` or `12,34,567.89`), optional sign and percent. */
const NUMBER_RE = /^[+-]?(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d+)?%?$/;
const ISO_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

function parseNumber(text: string): number | null {
  if (!NUMBER_RE.test(text)) return null;
  const percent = text.endsWith('%');
  const n = Number(text.replace(/,/g, '').replace(/%$/, ''));
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

function currencyOf(text: string): { code: string; amount: string } | null {
  for (const [symbol, code] of SYMBOLS) {
    if (text.startsWith(symbol)) return { code, amount: text.slice(symbol.length).trim() };
    if (text.endsWith(symbol)) return { code, amount: text.slice(0, -symbol.length).trim() };
  }
  const lead = /^([A-Za-z]{3})\s+(.+)$/.exec(text);
  if (lead?.[1] !== undefined && lead[2] !== undefined && CODE_RE.test(lead[1].toUpperCase())) {
    return { code: lead[1].toUpperCase(), amount: lead[2] };
  }
  const trail = /^(.+?)\s+([A-Za-z]{3})$/.exec(text);
  if (trail?.[1] !== undefined && trail[2] !== undefined && CODE_RE.test(trail[2].toUpperCase())) {
    return { code: trail[2].toUpperCase(), amount: trail[1] };
  }
  return null;
}

/**
 * The value a text cell contributes to a formula. Numbers keep their spelling
 * in `text` so Concat echoes what was typed; blanks are `blank` (FX-02: zero
 * in a Sum); anything else is text.
 */
export function inferCellValue(raw: string): CellValue {
  const text = raw.trim();
  if (text === '') return { kind: 'blank' };
  const number = parseNumber(text);
  if (number !== null) return { kind: 'number', value: number, text: raw };
  const currency = currencyOf(text);
  if (currency !== null) {
    const amount = parseNumber(currency.amount);
    if (amount !== null) return { kind: 'currency', value: amount, code: currency.code, text: raw };
  }
  if (ISO_DATE_RE.test(text)) return { kind: 'date', iso: text, text: raw };
  return { kind: 'text', text: raw };
}
