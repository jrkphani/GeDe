/**
 * Parsing typed text into numbers, currencies and dates (FMT-01..04).
 *
 * Parsing is deliberately locale-neutral: digits are ASCII, the decimal
 * separator is `.` and grouping is `,` in groups of two or three (so
 * `12,34,567` from an Indian keyboard and `1,234,567` both parse). Rendering
 * is where the locale comes in (`render.ts`). A parser returns `null` rather
 * than guessing; the caller decides whether that is "text" (Automatic) or
 * "invalid" (an explicit format, FMT-05).
 */
import { DEFAULT_CURRENCY, type CurrencyCode } from './types.js';

export interface ParsedNumber {
  readonly value: number;
  /** The code the text named (`USD 12`, `₹12`, `S$12`), or null when it named none. */
  readonly currency: CurrencyCode | null;
  /** True for a bare `$`, which SGD and USD share; the column decides. */
  readonly dollar: boolean;
  /** True when the text carried any currency symbol or code at all. */
  readonly monetary: boolean;
}

const SYMBOL_TO_CODE: Readonly<Record<string, CurrencyCode | null>> = {
  S$: 'SGD',
  US$: 'USD',
  RM: 'MYR',
  Rp: 'IDR',
  '₱': 'PHP',
  '₹': 'INR',
  $: null,
  SGD: 'SGD',
  MYR: 'MYR',
  PHP: 'PHP',
  IDR: 'IDR',
  USD: 'USD',
  INR: 'INR',
};

const LEADING_CURRENCY = /^(S\$|US\$|RM|Rp|₱|₹|\$|SGD|MYR|PHP|IDR|USD|INR)\s*/;
const TRAILING_CURRENCY = /\s*(SGD|MYR|PHP|IDR|USD|INR)$/;
const MAGNITUDE = /^(?:\d+|\d{1,3}(?:,\d{2,3})+)(?:\.\d+)?$|^\.\d+$/;
const SIGN = /^[-−]/;

/**
 * `1,234.5`, `(1,234.50)`, `-12`, `S$1,250`, `USD 300`, `45 INR`, `₹12,34,567`.
 * Accounting parentheses mean negative (FMT-03). Percentages, exponents and
 * locale digits are not numbers here.
 */
export function parseNumber(raw: string): ParsedNumber | null {
  let s = raw.trim().replace(/[\u00a0\u202f]/g, ' ');
  if (s === '') return null;
  let negative = false;
  const parens = /^\((.*)\)$/.exec(s);
  if (parens !== null) {
    negative = true;
    s = (parens[1] ?? '').trim();
  }
  if (SIGN.test(s)) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  let symbol: string | null = null;
  const lead = LEADING_CURRENCY.exec(s);
  if (lead !== null) {
    symbol = lead[1] ?? null;
    s = s.slice(lead[0].length);
  } else {
    const trail = TRAILING_CURRENCY.exec(s);
    if (trail !== null) {
      symbol = trail[1] ?? null;
      s = s.slice(0, trail.index);
    }
  }
  // `$-12`: the sign may follow the symbol.
  if (SIGN.test(s)) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  if (!MAGNITUDE.test(s)) return null;
  const value = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const currency = symbol === null ? null : (SYMBOL_TO_CODE[symbol] ?? null);
  return {
    value: negative ? -value : value,
    currency,
    dollar: symbol === '$',
    monetary: symbol !== null,
  };
}

/** Resolve a parsed number's currency against the column's (FMT-03). */
export function currencyOf(
  parsed: ParsedNumber,
  columnCurrency: CurrencyCode | undefined,
): CurrencyCode {
  if (parsed.currency !== null) return parsed.currency;
  if (parsed.dollar) {
    return columnCurrency === 'USD' || columnCurrency === 'SGD' ? columnCurrency : DEFAULT_CURRENCY;
  }
  return columnCurrency ?? DEFAULT_CURRENCY;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** A calendar date with no time or zone; what a spreadsheet date is. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function civil(year: number, month: number, day: number): CivilDate | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function fullYear(text: string): number {
  const y = Number(text);
  return text.length === 2 ? 2000 + y : y;
}

const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const D_MON_Y = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/;

/**
 * `D/M/Y` (day first in every locale — the keyboards of PRD §23 all type it
 * that way), `Y-M-D`, and `D MMM YYYY` so a rendered default pattern parses
 * back (FMT-04). Two-digit years are 20xx. Impossible dates are null.
 */
export function parseDate(raw: string): CivilDate | null {
  const s = raw.trim();
  let m = DMY.exec(s);
  if (m !== null) return civil(fullYear(m[3] ?? ''), Number(m[2]), Number(m[1]));
  m = YMD.exec(s);
  if (m !== null) return civil(Number(m[1]), Number(m[2]), Number(m[3]));
  m = D_MON_Y.exec(s);
  if (m !== null) {
    const month = MONTHS.indexOf((m[2] ?? '').slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
    return civil(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** `YYYY-MM-DD`, the stored form of a date (FMT-02's "stored value" for dates). */
export function isoDate(d: CivilDate): string {
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

/** Days since 1970-01-01 (UTC), for chronological comparison (FMT-04). */
export function epochDay(d: CivilDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/** Chronological order regardless of display pattern (FMT-04). */
export function compareDates(a: CivilDate, b: CivilDate): number {
  return epochDay(a) - epochDay(b);
}

/** Chronological order of two ISO date strings; a malformed string sorts last. */
export function compareIsoDates(a: string, b: string): number {
  const da = parseDate(a);
  const db = parseDate(b);
  if (da === null || db === null) return da === null ? (db === null ? 0 : 1) : -1;
  return compareDates(da, db);
}
