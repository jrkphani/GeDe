/**
 * The mail catalogue: one set of keys, six locales (I18N-05), the same `{placeholder}`
 * mechanism as the web app's catalogue (`apps/web/src/i18n`). A locale tag that is not
 * one of the six — absent, unknown, or a bare language — resolves to the nearest match,
 * then to en-US, so a mail is never refused for want of a translation.
 */
import { messages as enGB } from './messages/en-GB.js';
import { messages as enIN } from './messages/en-IN.js';
import { messages as enUS } from './messages/en-US.js';
import { messages as hiIN } from './messages/hi-IN.js';
import { messages as taIN } from './messages/ta-IN.js';
import { messages as teIN } from './messages/te-IN.js';
import { MESSAGE_KEYS, type MessageKey, type Messages } from './messages/types.js';

export type { MessageKey, Messages };
export { MESSAGE_KEYS };

/** The locales the product ships (root CLAUDE.md), en-US first as the reference. */
export const MAIL_LOCALES = ['en-US', 'en-GB', 'en-IN', 'ta-IN', 'hi-IN', 'te-IN'] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];
export const DEFAULT_MAIL_LOCALE: MailLocale = 'en-US';

export const CATALOGUE: Readonly<Record<MailLocale, Messages>> = {
  'en-US': enUS,
  'en-GB': enGB,
  'en-IN': enIN,
  'ta-IN': taIN,
  'hi-IN': hiIN,
  'te-IN': teIN,
};

export function isMailLocale(value: unknown): value is MailLocale {
  return typeof value === 'string' && (MAIL_LOCALES as readonly string[]).includes(value);
}

/**
 * The locale a mail is rendered in, from whatever tag was stored: an exact tag; else the
 * first shipped locale with the same language (`ta` → ta-IN, `en-AU` → en-US); else en-US.
 */
export function resolveMailLocale(tag: string | null | undefined): MailLocale {
  if (typeof tag !== 'string' || tag === '') return DEFAULT_MAIL_LOCALE;
  const normalised = tag.trim().replace('_', '-');
  const exact = MAIL_LOCALES.find((l) => l.toLowerCase() === normalised.toLowerCase());
  if (exact !== undefined) return exact;
  const language = normalised.split('-')[0]?.toLowerCase() ?? '';
  return MAIL_LOCALES.find((l) => l.startsWith(`${language}-`)) ?? DEFAULT_MAIL_LOCALE;
}

export type MessageParams = Readonly<Record<string, string | number>>;

/** Substitute `{name}` placeholders; an unknown placeholder is left as written. */
export function format(template: string, params?: MessageParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function translate(locale: MailLocale, key: MessageKey, params?: MessageParams): string {
  return format(CATALOGUE[locale][key], params);
}

/** DESIGN-SYSTEM §6: a subject is at most 60 characters, front-loaded with the actor. */
export const SUBJECT_MAX = 60;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `text` cut to at most `max` UTF-16 units on a grapheme boundary — a Tamil or Telugu
 * syllable is several units and must never be split — with an ellipsis when it was cut.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = Math.max(0, max - 1);
  let out = '';
  for (const { segment } of graphemes.segment(text)) {
    if (out.length + segment.length > budget) break;
    out += segment;
  }
  return `${out}…`;
}

/**
 * A subject from a template whose `{title}` is the one variable-length part: the title is
 * trimmed so the whole fits `SUBJECT_MAX`; a long actor alone can pass it, and the cap holds.
 */
export function subjectFor(
  locale: MailLocale,
  key: MessageKey,
  params: MessageParams & { title?: string },
): string {
  const template = CATALOGUE[locale][key];
  if (params.title === undefined) return truncate(format(template, params), SUBJECT_MAX);
  const fixed = format(template, { ...params, title: '' });
  const room = Math.max(0, SUBJECT_MAX - fixed.length);
  const title = truncate(params.title, room);
  return truncate(format(template, { ...params, title }), SUBJECT_MAX);
}
