/**
 * Column data formats (PRD §22, FMT-01..06): a per-column type system with a
 * per-cell override. The format decides how a cell's text is parsed and
 * rendered; the text itself stays what the person typed unless a format
 * explicitly canonicalises it (FMT-02).
 */
import type { TextPreset } from '../text/algebra.js';

export const FORMAT_KINDS = ['auto', 'text', 'number', 'currency', 'date'] as const;
export type FormatKind = (typeof FORMAT_KINDS)[number];

/** In the order the picker offers them: SGD default, then the rest (FMT-03). */
export const CURRENCY_CODES = ['SGD', 'MYR', 'PHP', 'IDR', 'USD', 'INR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];
export const DEFAULT_CURRENCY: CurrencyCode = 'SGD';

/** Date patterns (PRD §22): `D MMM YYYY` is the default. */
export const DATE_PATTERNS = ['D MMM YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMM YYYY'] as const;
export type DatePattern = (typeof DATE_PATTERNS)[number];
export const DEFAULT_DATE_PATTERN: DatePattern = 'D MMM YYYY';

export const MIN_DECIMALS = 0;
export const MAX_DECIMALS = 6;

/** Locales the app renders in (PRD §23). Mirrors `apps/web/src/locale.ts`; core cannot import it. */
export const FORMAT_LOCALES = ['en-US', 'en-GB', 'en-IN', 'ta-IN', 'hi-IN', 'te-IN'] as const;
export type FormatLocale = (typeof FORMAT_LOCALES)[number];
export const DEFAULT_FORMAT_LOCALE: FormatLocale = 'en-US';

export interface FormatOpts {
  /** Number and Currency: fixed decimal places 0–6. Unset: as typed, at most 6. */
  readonly decimals?: number;
  /** Number and Currency: thousands (or lakh/crore) grouping. Default true. */
  readonly grouping?: boolean;
  /** Currency: the code every cell in the column carries unless it names another. */
  readonly currency?: CurrencyCode;
  /** Date: display pattern. Default `D MMM YYYY`. */
  readonly datePattern?: DatePattern;
  /** Text: case preset applied at render time, never to the stored text. */
  readonly textCase?: TextPreset;
}

export interface CellFormat {
  readonly kind: FormatKind;
  readonly opts: FormatOpts;
}

export const AUTO_FORMAT: CellFormat = { kind: 'auto', opts: {} };

export function isFormatKind(value: unknown): value is FormatKind {
  return typeof value === 'string' && (FORMAT_KINDS as readonly string[]).includes(value);
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value);
}

export function isDatePattern(value: unknown): value is DatePattern {
  return typeof value === 'string' && (DATE_PATTERNS as readonly string[]).includes(value);
}

export function isFormatLocale(value: unknown): value is FormatLocale {
  return typeof value === 'string' && (FORMAT_LOCALES as readonly string[]).includes(value);
}

const TEXT_PRESETS: readonly string[] = ['titleCase', 'upper', 'lower', 'trimmed'];

/** Clamp to 0–6 whole places; anything else is "unset". */
export function clampDecimals(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, Math.round(value)));
}

/**
 * Guarded read of options from JSON (a Y.Map value, a message). Unknown keys
 * and off-vocabulary values are dropped so a newer client's options never
 * break an older reader.
 */
export function readFormatOpts(value: unknown): FormatOpts {
  if (typeof value !== 'object' || value === null) return {};
  const out: {
    decimals?: number;
    grouping?: boolean;
    currency?: CurrencyCode;
    datePattern?: DatePattern;
    textCase?: TextPreset;
  } = {};
  if ('decimals' in value) {
    const d = clampDecimals(value.decimals);
    if (d !== undefined) out.decimals = d;
  }
  if ('grouping' in value && typeof value.grouping === 'boolean') out.grouping = value.grouping;
  if ('currency' in value && isCurrencyCode(value.currency)) out.currency = value.currency;
  if ('datePattern' in value && isDatePattern(value.datePattern))
    out.datePattern = value.datePattern;
  if (
    'textCase' in value &&
    typeof value.textCase === 'string' &&
    TEXT_PRESETS.includes(value.textCase)
  ) {
    out.textCase = value.textCase as TextPreset;
  }
  return out;
}

export function cellFormat(kind: FormatKind, opts: FormatOpts = {}): CellFormat {
  return { kind, opts: readFormatOpts(opts) };
}
