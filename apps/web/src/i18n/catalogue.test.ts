import { describe, expect, test } from 'vitest';

import { LOCALES } from '../locale.js';
import { CATALOGUE, format, MESSAGE_KEYS, translate, type MessageKey } from './index.js';

const TOUR_KEYS = MESSAGE_KEYS.filter((k) => k.startsWith('tour.'));

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('message catalogue', () => {
  test('ONB-12 every tour string exists, non-empty, in all six locales, with no extra keys', () => {
    expect(TOUR_KEYS.length).toBeGreaterThanOrEqual(22);
    for (const locale of LOCALES) {
      const messages = CATALOGUE[locale];
      expect(Object.keys(messages).sort(), locale).toEqual([...MESSAGE_KEYS].sort());
      for (const key of MESSAGE_KEYS) {
        expect(messages[key].trim(), `${locale} ${key}`).not.toBe('');
      }
    }
  });

  test('ONB-12 every locale keeps the placeholders of the reference string', () => {
    for (const locale of LOCALES) {
      for (const key of MESSAGE_KEYS) {
        expect(placeholders(CATALOGUE[locale][key]), `${locale} ${key}`).toEqual(
          placeholders(CATALOGUE['en-US'][key]),
        );
      }
    }
  });

  test('ONB-12 the Indic locales are translated, not copied from English', () => {
    const scripts: Record<string, RegExp> = {
      'ta-IN': /\p{Script=Tamil}/u,
      'hi-IN': /\p{Script=Devanagari}/u,
      'te-IN': /\p{Script=Telugu}/u,
    };
    for (const [locale, script] of Object.entries(scripts)) {
      for (const key of TOUR_KEYS) {
        const value = CATALOGUE[locale as keyof typeof CATALOGUE][key];
        expect(script.test(value), `${locale} ${key}: ${value}`).toBe(true);
      }
    }
  });

  test('ONB-10 the copy names the Numbers equivalent, then the difference; graphs are introduced on their own terms', () => {
    const en = CATALOGUE['en-US'];
    expect(en['tour.step2.note']).toMatch(/^Numbers: People::B2/);
    expect(en['tour.step4.note']).toMatch(/^Numbers searches one sheet/);
    expect(en['tour.step5.note']).toMatch(/^Like iCloud sharing/);
    expect(en['tour.step3.note']).toMatch(/^No Numbers equivalent/);
    // Step 1 teaches nothing Numbers already does and has no comparison note.
    expect(MESSAGE_KEYS).not.toContain('tour.step1.note');
  });

  test('ONB-12 format substitutes placeholders and leaves unknown ones as written', () => {
    expect(format('STEP {step} OF {total}', { step: 2, total: 5 })).toBe('STEP 2 OF 5');
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(translate('ta-IN', 'tour.counter', { step: 1, total: 5 })).toBe('படி 1 / 5');
    const key: MessageKey = 'tour.skip';
    expect(translate('hi-IN', key)).toBe('छोड़ें');
  });
});
