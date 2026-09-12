/**
 * The message catalogue (ONB-12; I18N-05 picks the locale). One catalogue per
 * supported locale, all carrying the same keys; `useMessages()` binds `t()`
 * to the active locale from `locale.ts`, so a locale change re-renders every
 * string at once with the collation and formatting it already drives.
 *
 * Interface copy that predates the catalogue is still written inline in its
 * component; new user-facing strings go here, in all six locales.
 */
import { useCallback } from 'react';

import { useLocale, type Locale } from '../locale.js';
import { messages as enGB } from './en-GB.js';
import { messages as enIN } from './en-IN.js';
import { messages as enUS } from './en-US.js';
import { messages as hiIN } from './hi-IN.js';
import { MESSAGE_KEYS, type MessageKey, type Messages } from './messages.js';
import { messages as taIN } from './ta-IN.js';
import { messages as teIN } from './te-IN.js';

export type { MessageKey, Messages };
export { MESSAGE_KEYS };

export const CATALOGUE: Readonly<Record<Locale, Messages>> = {
  'en-US': enUS,
  'en-GB': enGB,
  'en-IN': enIN,
  'ta-IN': taIN,
  'hi-IN': hiIN,
  'te-IN': teIN,
};

export type MessageParams = Readonly<Record<string, string | number>>;

/** Substitute `{name}` placeholders; an unknown placeholder is left as written. */
export function format(template: string, params?: MessageParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function messagesFor(locale: Locale): Messages {
  return CATALOGUE[locale];
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return format(CATALOGUE[locale][key], params);
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** `t(key, params)` for the active locale. */
export function useMessages(): Translate {
  const [locale] = useLocale();
  return useCallback<Translate>((key, params) => translate(locale, key, params), [locale]);
}
