/**
 * The active locale (I18N-03/04/05). One store for the whole app: `lang` on
 * the root, collation, number and date formatting all read it.
 *
 * Persistence: the device remembers the last choice (`gede.locale`) so the
 * sign-in screen and a fresh session already read right; once a user is bound
 * their own choice (`gede.locale.<sub>`, mirrored on the server by the caller)
 * takes over.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export const LOCALES = ['en-US', 'en-GB', 'en-IN', 'ta-IN', 'hi-IN', 'te-IN'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en-US';

/**
 * Names shown in the picker: the language in its own script (the autonym),
 * the region in the UI language. The two parts are kept apart so the picker
 * can mark the autonym with its own `lang` (WCAG 3.1.2, Language of Parts).
 */
export const LOCALE_NAMES: Record<Locale, { autonym: string; region: string }> = {
  'en-US': { autonym: 'English', region: 'United States' },
  'en-GB': { autonym: 'English', region: 'United Kingdom' },
  'en-IN': { autonym: 'English', region: 'India' },
  'ta-IN': { autonym: 'தமிழ்', region: 'India' },
  'hi-IN': { autonym: 'हिन्दी', region: 'India' },
  'te-IN': { autonym: 'తెలుగు', region: 'India' },
};

/** `lang` for an autonym: the language subtag of its locale (`ta` for `ta-IN`). */
export function languageOf(locale: Locale): string {
  return locale.slice(0, locale.indexOf('-'));
}

/** Plain-text label, e.g. for announcements: "தமிழ் (India)". */
export const LOCALE_LABELS: Record<Locale, string> = Object.fromEntries(
  LOCALES.map((l) => [l, `${LOCALE_NAMES[l].autonym} (${LOCALE_NAMES[l].region})`]),
) as Record<Locale, string>;

const DEVICE_KEY = 'gede.locale';
const userKey = (sub: string): string => `${DEVICE_KEY}.${sub}`;

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

function readKey(key: string): Locale | null {
  try {
    const stored = localStorage.getItem(key);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeKey(key: string, locale: Locale): void {
  try {
    localStorage.setItem(key, locale);
  } catch {
    /* private mode: the choice lives for this page only */
  }
}

const listeners = new Set<() => void>();
let current: Locale = readKey(DEVICE_KEY) ?? DEFAULT_LOCALE;
let boundSub: string | null = null;

function publish(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  applyLang(locale);
  listeners.forEach((l) => {
    l();
  });
}

export function activeLocale(): Locale {
  return current;
}

/** The user's (or, before sign-in, the device's) choice. Persists locally; the caller mirrors it to the server. */
export function setLocale(locale: Locale): void {
  writeKey(DEVICE_KEY, locale);
  if (boundSub !== null) writeKey(userKey(boundSub), locale);
  publish(locale);
}

/**
 * I18N-05: adopt a signed-in user's locale. The server's value wins when it
 * is one we support; otherwise the user's last local choice; otherwise what
 * the device already shows. Returns the locale now active.
 */
export function bindUserLocale(sub: string, serverLocale: unknown = null): Locale {
  boundSub = sub;
  const locale = isLocale(serverLocale) ? serverLocale : (readKey(userKey(sub)) ?? current);
  writeKey(userKey(sub), locale);
  writeKey(DEVICE_KEY, locale);
  publish(locale);
  return locale;
}

export function unbindUserLocale(): void {
  boundSub = null;
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
  const locale = useSyncExternalStore(subscribe, activeLocale, () => DEFAULT_LOCALE);
  useEffect(() => {
    applyLang(locale);
  }, [locale]);
  const set = useCallback((l: Locale) => {
    setLocale(l);
  }, []);
  return [locale, set];
}

/** Test seam: forget the bound user and re-read the device choice. */
export function resetLocaleForTests(): void {
  boundSub = null;
  current = readKey(DEVICE_KEY) ?? DEFAULT_LOCALE;
  listeners.forEach((l) => {
    l();
  });
}
