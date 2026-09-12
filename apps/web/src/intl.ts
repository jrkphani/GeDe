/**
 * I18N-04 / I18N-05: every number, date and comparison the chrome shows goes
 * through `Intl` for the active locale. Nothing here formats by hand.
 */
import type { Locale } from './locale.js';

/** Indian locales group digits as lakh and crore (12,34,567), not thousands. */
export function isIndianLocale(locale: Locale): boolean {
  return locale.endsWith('-IN');
}

/**
 * Integer/decimal formatting. `Intl.NumberFormat` already applies the
 * lakh/crore grouping for `*-IN` locales; this helper exists so the grouping
 * choice is named and tested, and so callers never reach for `toLocaleString`
 * with an implicit locale.
 */
export function formatNumber(
  locale: Locale,
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export type DateStyle = 'long' | 'numeric';

/**
 * Dates through `Intl.DateTimeFormat`. `numeric` is the short form used below
 * 900 px (LIB-10). Day/month order follows the locale: 9/12/26 in en-US,
 * 12/9/26 in en-GB and en-IN.
 */
export function formatDate(locale: Locale, iso: string, style: DateStyle = 'long'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions =
    style === 'numeric'
      ? { year: '2-digit', month: 'numeric', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}

/** Time of day, for rows dated today. */
export function formatTime(locale: Locale, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
}

export function formatBytes(locale: Locale, bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[i] ?? 'byte',
    unitDisplay: 'short',
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(value);
}

/** Collation for names: case-insensitive, numeric-aware ("Plan 2" before "Plan 10"). */
export function collator(locale: Locale): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
}

export type RecencyBucket = 'today' | 'yesterday' | 'this-week' | 'this-month' | 'earlier';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** LIB-01: Recents groups rows by how recently they changed, in the viewer's local time. */
export function recencyBucket(iso: string, now: number = Date.now()): RecencyBucket {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'earlier';
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - DAY_MS) return 'yesterday';
  if (t >= today - 6 * DAY_MS) return 'this-week';
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  if (t >= monthStart.getTime()) return 'this-month';
  return 'earlier';
}

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  'this-week': 'This week',
  'this-month': 'This month',
  earlier: 'Earlier',
};
