import { describe, expect, test } from 'vitest';

import {
  CATALOGUE,
  MAIL_LOCALES,
  MESSAGE_KEYS,
  SUBJECT_MAX,
  type MailLocale,
  type MessageKey,
} from './i18n.js';

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('mail catalogue', () => {
  test('I18N-05 every mail string exists, non-empty, in all six locales, with no extra keys', () => {
    expect(MAIL_LOCALES).toHaveLength(6);
    for (const locale of MAIL_LOCALES) {
      const messages = CATALOGUE[locale];
      expect(Object.keys(messages).sort(), locale).toEqual([...MESSAGE_KEYS].sort());
      for (const key of MESSAGE_KEYS) {
        expect(messages[key].trim(), `${locale} ${key}`).not.toBe('');
      }
    }
  });

  test('I18N-05 every locale keeps the placeholders of the reference string', () => {
    for (const locale of MAIL_LOCALES) {
      for (const key of MESSAGE_KEYS) {
        expect(placeholders(CATALOGUE[locale][key]), `${locale} ${key}`).toEqual(
          placeholders(CATALOGUE['en-US'][key]),
        );
      }
    }
  });

  test('I18N-05 the Indic locales are translated, not copied from English; product names stay as written', () => {
    const scripts: Record<string, RegExp> = {
      'ta-IN': /\p{Script=Tamil}/u,
      'hi-IN': /\p{Script=Devanagari}/u,
      'te-IN': /\p{Script=Telugu}/u,
    };
    for (const [locale, script] of Object.entries(scripts)) {
      for (const key of MESSAGE_KEYS) {
        const value = CATALOGUE[locale as MailLocale][key];
        expect(script.test(value), `${locale} ${key}: ${value}`).toBe(true);
        // A name is never transliterated (root CLAUDE.md: GeDe, workscape, passkey).
        for (const name of ['GeDe', 'workscape', 'passkey']) {
          if (CATALOGUE['en-US'][key].includes(name)) {
            expect(value, `${locale} ${key} keeps “${name}”`).toContain(name);
          }
        }
      }
    }
  });

  test('DESIGN-SYSTEM §6 voice: no exclamation marks, no “Oops”, no emoji; actions are verbs without punctuation', () => {
    for (const locale of MAIL_LOCALES) {
      for (const key of MESSAGE_KEYS) {
        const value = CATALOGUE[locale][key];
        expect(value, `${locale} ${key}`).not.toMatch(/!|Oops|\p{Extended_Pictographic}/u);
        if (key.endsWith('.action')) expect(value, `${locale} ${key}`).not.toMatch(/[.:!?।]$/);
      }
    }
  });

  test('DESIGN-SYSTEM §6 a fixed subject (the code mails) is within 60 characters in every locale', () => {
    const fixed: MessageKey[] = [
      'signUpCode.subject',
      'signInCode.subject',
      'emailChangeCode.subject',
    ];
    for (const locale of MAIL_LOCALES) {
      for (const key of fixed) {
        expect(CATALOGUE[locale][key].length, `${locale} ${key}`).toBeLessThanOrEqual(SUBJECT_MAX);
      }
    }
  });

  test('AUTH-04 the sign-in code subject is “Your GeDe sign-in code”; the code never sits in a subject', () => {
    expect(CATALOGUE['en-US']['signInCode.subject']).toBe('Your GeDe sign-in code');
    expect(CATALOGUE['en-US']['signUpCode.subject']).toBe('Your GeDe sign-up code');
    for (const locale of MAIL_LOCALES) {
      for (const key of MESSAGE_KEYS) {
        if (key.endsWith('.subject')) expect(CATALOGUE[locale][key]).not.toContain('{code}');
      }
    }
  });
});
