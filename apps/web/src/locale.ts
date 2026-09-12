import { useCallback, useEffect, useSyncExternalStore } from 'react';

export const LOCALES = ['en-US', 'en-GB', 'en-IN', 'ta-IN', 'hi-IN', 'te-IN'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-US';

const STORAGE_KEY = 'gede.locale';
const listeners = new Set<() => void>();

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

function read(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private mode: the choice lives for this page only */
  }
  applyLang(locale);
  listeners.forEach((l) => {
    l();
  });
}

/** I18N-03: `lang` on the root drives font shaping and the Indic line-height rule. */
export function applyLang(locale: Locale): void {
  document.documentElement.lang = locale;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const locale = useSyncExternalStore(subscribe, read, () => DEFAULT_LOCALE);
  useEffect(() => {
    applyLang(locale);
  }, [locale]);
  const set = useCallback((l: Locale) => {
    setLocale(l);
  }, []);
  return [locale, set];
}

/** I18N-04: dates through Intl for the active locale. `numeric` is the short form used below 900 px (LIB-10). */
export function formatDate(
  locale: Locale,
  iso: string,
  style: 'long' | 'numeric' = 'long',
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions =
    style === 'numeric'
      ? { year: '2-digit', month: 'numeric', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
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
