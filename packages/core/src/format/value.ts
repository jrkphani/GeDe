/**
 * From a cell's text to a typed value under a format (FMT-01, FMT-05), and
 * from a typed value to the text a cell shows (FMT-02..04, I18N-04).
 *
 * The typed value is the formula engine's `CellValue`, so a Resolver can hand
 * `resolveValue(...)` straight to `evaluate`. `invalid` is the one extra
 * state: text that does not parse under an explicit format. It is never
 * coerced to zero; `toCellValue` maps it to `blank` so aggregation skips it,
 * and the renderer tints the cell and shows the glyph (FMT-05, A11Y-04).
 */
import type { CellValue } from '../formula/evaluate.js';
import { currencyOf, isoDate, parseDate, parseNumber, type CivilDate } from './parse.js';
import {
  DEFAULT_CURRENCY,
  DEFAULT_DATE_PATTERN,
  DEFAULT_FORMAT_LOCALE,
  MAX_DECIMALS,
  type CellFormat,
  type DatePattern,
  type FormatLocale,
  type FormatOpts,
} from './types.js';

export type InvalidKind = 'number' | 'currency' | 'date';

export type FormattedValue =
  | Exclude<CellValue, { kind: 'error' }>
  | { readonly kind: 'invalid'; readonly text: string; readonly expected: InvalidKind };

/** Parse text under a format. Automatic infers and never fails; explicit formats can (FMT-05). */
export function resolveValue(text: string, format: CellFormat): FormattedValue {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'blank' };
  switch (format.kind) {
    case 'text':
      return { kind: 'text', text };
    case 'number': {
      const n = parseNumber(trimmed);
      return n === null
        ? { kind: 'invalid', text, expected: 'number' }
        : { kind: 'number', value: n.value };
    }
    case 'currency': {
      const n = parseNumber(trimmed);
      return n === null
        ? { kind: 'invalid', text, expected: 'currency' }
        : { kind: 'currency', value: n.value, code: currencyOf(n, format.opts.currency) };
    }
    case 'date': {
      const d = parseDate(trimmed);
      return d === null
        ? { kind: 'invalid', text, expected: 'date' }
        : { kind: 'date', iso: isoDate(d) };
    }
    case 'auto': {
      const n = parseNumber(trimmed);
      if (n !== null) {
        return n.monetary
          ? { kind: 'currency', value: n.value, code: currencyOf(n, format.opts.currency) }
          : { kind: 'number', value: n.value };
      }
      const d = parseDate(trimmed);
      if (d !== null) return { kind: 'date', iso: isoDate(d) };
      return { kind: 'text', text };
    }
  }
}

/** The formula engine's view: invalid cells are blank (excluded, FMT-05), everything else as is. */
export function toCellValue(value: FormattedValue): CellValue {
  return value.kind === 'invalid' ? { kind: 'blank' } : value;
}

/**
 * A number as plain decimal digits — never `1e+21`, which `parseNumber` would
 * refuse on the next render and flip a committed cell to invalid.
 */
export function canonicalNumber(value: number): string {
  const plain = String(value);
  if (!/e/i.test(plain)) return plain;
  if (Number.isInteger(value)) return BigInt(value).toString();
  // A fractional value with an exponent is tiny (|v| < 1e-6): spell it out and trim the zeros.
  return value.toFixed(20).replace(/\.?0+$/, '');
}

/**
 * The text to store for a commit under a format (FMT-02 "the stored value is
 * the parsed number"): a canonical decimal for numbers and currencies, ISO
 * for dates, so a later format or locale change re-renders without
 * re-typing. Automatic and Text never rewrite what was typed (FMT-01), and
 * neither does an invalid value (FMT-05).
 */
export function canonicalText(text: string, format: CellFormat): string {
  if (format.kind === 'auto' || format.kind === 'text') return text;
  const value = resolveValue(text, format);
  switch (value.kind) {
    case 'number':
      return canonicalNumber(value.value);
    case 'currency':
      return value.code === (format.opts.currency ?? DEFAULT_CURRENCY)
        ? canonicalNumber(value.value)
        : `${canonicalNumber(value.value)} ${value.code}`;
    case 'date':
      return value.iso;
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Rendering (I18N-04)
// ---------------------------------------------------------------------------

export interface Rendered {
  readonly text: string;
  /** Numbers and currencies right-align (FMT-02, FMT-03); text and dates left. */
  readonly align: 'left' | 'right';
  /** FMT-05: tint plus a warning glyph; the text shown is what was typed. */
  readonly invalid: boolean;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function numberFormatter(
  locale: FormatLocale,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = numberFormatters.get(key);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, options);
    numberFormatters.set(key, f);
  }
  return f;
}

function dateFormatter(
  locale: FormatLocale,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = dateFormatters.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    dateFormatters.set(key, f);
  }
  return f;
}

function fractionDigits(
  opts: FormatOpts,
): Pick<Intl.NumberFormatOptions, 'minimumFractionDigits' | 'maximumFractionDigits'> {
  if (opts.decimals === undefined)
    return { minimumFractionDigits: 0, maximumFractionDigits: MAX_DECIMALS };
  return { minimumFractionDigits: opts.decimals, maximumFractionDigits: opts.decimals };
}

/** Numbers through `Intl.NumberFormat`; Indian locales group lakh/crore on their own (I18N-04). */
export function formatNumber(value: number, opts: FormatOpts, locale: FormatLocale): string {
  return numberFormatter(locale, {
    ...fractionDigits(opts),
    useGrouping: opts.grouping ?? true,
    signDisplay: 'auto',
  }).format(value);
}

/** Indian locales group lakh/crore (I18N-04). */
export function isIndianLocale(locale: FormatLocale): boolean {
  return locale.endsWith('-IN');
}

/**
 * ICU's currency patterns for `en-IN`, `ta-IN` and `te-IN` group INR by
 * thousands while their decimal patterns group lakh/crore. Splice the decimal
 * formatter's integer digits into the currency formatter's parts so a
 * currency in an Indian locale reads `₹12,34,567.89` (I18N-04).
 */
function regroupIndian(
  parts: readonly Intl.NumberFormatPart[],
  digits: readonly Intl.NumberFormatPart[],
): string {
  const integer = digits.filter((p) => p.type === 'integer' || p.type === 'group');
  let spliced = false;
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === 'integer' || part.type === 'group') {
      if (!spliced) {
        out.push(...integer.map((p) => p.value));
        spliced = true;
      }
      continue;
    }
    out.push(part.value);
  }
  return out.join('');
}

/**
 * Currency through `Intl`, negatives in accounting parentheses in every
 * locale (FMT-03). ICU carries the parenthesised pattern for only some
 * locales (hi-IN renders `-SGD 1,234.50` under `currencySign: 'accounting'`),
 * so the magnitude is formatted and wrapped here.
 */
export function formatCurrency(
  value: number,
  code: string,
  opts: FormatOpts,
  locale: FormatLocale,
): string {
  const digits = opts.decimals === undefined ? {} : fractionDigits(opts);
  const grouping = opts.grouping ?? true;
  const magnitude = Math.abs(value);
  const currency = numberFormatter(locale, {
    style: 'currency',
    currency: code,
    useGrouping: grouping,
    ...digits,
  });
  let text: string;
  if (isIndianLocale(locale) && grouping) {
    const resolved = currency.resolvedOptions();
    const decimal = numberFormatter(locale, {
      useGrouping: true,
      minimumFractionDigits: resolved.minimumFractionDigits,
      maximumFractionDigits: resolved.maximumFractionDigits,
    });
    text = regroupIndian(currency.formatToParts(magnitude), decimal.formatToParts(magnitude));
  } else {
    text = currency.format(magnitude);
  }
  // `(₹0.00)` is not a negative amount: wrap only when the rounded magnitude is non-zero.
  const negative = value < 0 && /[1-9]/.test(text);
  return negative ? `(${text})` : text;
}

const DATE_OPTIONS: Readonly<
  Record<Exclude<DatePattern, 'YYYY-MM-DD' | 'DD/MM/YYYY'>, Intl.DateTimeFormatOptions>
> = {
  'D MMM YYYY': { day: 'numeric', month: 'short', year: 'numeric' },
  'MMM YYYY': { month: 'short', year: 'numeric' },
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Dates through `Intl.DateTimeFormat` in the locale's own order and month names (FMT-04, I18N-04). */
export function formatDate(date: CivilDate, pattern: DatePattern, locale: FormatLocale): string {
  if (pattern === 'YYYY-MM-DD') return isoDate(date);
  // The two numeric patterns render as their names promise in every locale (PRD §22 names
  // them); the month-name patterns go through Intl for the locale's order and month names.
  // PRD §23's en-US short date (M/D/Y) is not one of the §22 patterns — spec gap, issue #70.
  if (pattern === 'DD/MM/YYYY') {
    return `${pad2(date.day)}/${pad2(date.month)}/${String(date.year).padStart(4, '0')}`;
  }
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return dateFormatter(locale, DATE_OPTIONS[pattern]).format(at);
}

export function renderValue(
  value: FormattedValue,
  format: CellFormat,
  locale: FormatLocale = DEFAULT_FORMAT_LOCALE,
): Rendered {
  switch (value.kind) {
    case 'blank':
      return { text: '', align: 'left', invalid: false };
    case 'text':
      return { text: value.text, align: 'left', invalid: false };
    case 'number':
      return {
        text: formatNumber(value.value, format.opts, locale),
        align: 'right',
        invalid: false,
      };
    case 'currency':
      return {
        text: formatCurrency(value.value, value.code, format.opts, locale),
        align: 'right',
        invalid: false,
      };
    case 'date': {
      const d = parseDate(value.iso);
      return {
        text:
          d === null
            ? value.iso
            : formatDate(d, format.opts.datePattern ?? DEFAULT_DATE_PATTERN, locale),
        align: 'left',
        invalid: false,
      };
    }
    case 'invalid':
      return { text: value.text, align: 'left', invalid: true };
  }
}

/**
 * One call for the renderer: text in, display out. Under Automatic the text
 * shows as typed — `2026` stays `2026`, `007` stays `007` — and only aligns
 * right when it parses as a number or an amount; grouping and decimals are
 * what an explicit Number or Currency format is for (FMT-01, FMT-02).
 */
export function renderText(text: string, format: CellFormat, locale?: FormatLocale): Rendered {
  const value = resolveValue(text, format);
  if (format.kind === 'auto') {
    const numeric = value.kind === 'number' || value.kind === 'currency';
    return { text, align: numeric ? 'right' : 'left', invalid: false };
  }
  return renderValue(value, format, locale);
}
