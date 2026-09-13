import { isEmptyQuery, parseQuery } from '@gede/core';
import { describe, expect, test } from 'vitest';

import { LOCALES } from '../locale.js';
import { CATALOGUE, format, MESSAGE_KEYS, translate, type MessageKey } from './index.js';

const TOUR_KEYS = MESSAGE_KEYS.filter((k) => k.startsWith('tour.'));
/** Keys whose values are prose in the locale's own script (the tour, ADR-047's object copy, ADR-048's sheet copy). */
const TRANSLATED_KEYS = MESSAGE_KEYS.filter(
  (k) => k.startsWith('tour.') || k.startsWith('object.') || k.startsWith('sheet.'),
);

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('message catalogue', () => {
  test('ONB-12 every tour string exists, non-empty, in all six locales, with no extra keys', () => {
    // 4 shared + 5 steps × 4 (step 1 has no note: −1) + 2b × 4 + 3b × 4 + 3c × 3 + 2 done = 36.
    expect(TOUR_KEYS.length).toBeGreaterThanOrEqual(36);
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
      for (const key of TRANSLATED_KEYS) {
        const value = CATALOGUE[locale as keyof typeof CATALOGUE][key];
        expect(script.test(value), `${locale} ${key}: ${value}`).toBe(true);
      }
    }
  });

  test('ONB-10 the copy names the Numbers equivalent, then the difference; graphs are introduced on their own terms', () => {
    const en = CATALOGUE['en-US'];
    expect(en['tour.step2.note']).toMatch(/^Numbers: People::B2/);
    expect(en['tour.step4.note']).toMatch(/^Numbers searches one sheet/);
    // SHARE-01: the permission is per person; nothing in the product is per table.
    expect(en['tour.step5.note']).toBe(
      'Like iCloud sharing, with a permission you set per person.',
    );
    for (const locale of ['ta-IN', 'hi-IN', 'te-IN'] as const) {
      expect(CATALOGUE[locale]['tour.step5.note']).toContain('iCloud');
    }
    expect(en['tour.step3.note']).toMatch(/^No Numbers equivalent/);
    // Step 1 teaches nothing Numbers already does and has no comparison note.
    expect(MESSAGE_KEYS).not.toContain('tour.step1.note');
    // Step 2b (FX-01): Numbers' CONCATENATE / `&` first, then the difference.
    expect(en['tour.step2.concat.note']).toMatch(/^Numbers: CONCATENATE or &/);
    expect(en['tour.step2.concat.note']).toMatch(/GeDe: =Concat\(a, b, …\)/);
    // Step 3's sub-cards keep its note: a graph is introduced on its own terms throughout.
    expect(MESSAGE_KEYS).not.toContain('tour.step3.point.note');
    expect(MESSAGE_KEYS).not.toContain('tour.step3.dimensions.note');
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale]['tour.step2.concat.note']).toContain('CONCATENATE');
      expect(CATALOGUE[locale]['tour.step2.concat.note']).toContain('=Concat(a, b, …)');
    }
  });

  test('ONB-10 FX-01 ONB-01 step 2b shows the worked example that evaluates against the sample, spelled the same in every locale', () => {
    // `packages/core/src/ref/concat.test.ts` commits this exact string into the sample and
    // evaluates it to the result the card shows (#159 item 11e).
    const example = '=Concat(C5, " — ", @Team.Priya.Role)';
    for (const locale of LOCALES) {
      expect(CATALOGUE[locale]['tour.step2.concat.body'], locale).toContain(example);
      expect(CATALOGUE[locale]['tour.step2.concat.body'], locale).toContain(
        'Priya — Product engineer',
      );
    }
    // #159 item 9: the pending actions, verbatim.
    const en = CATALOGUE['en-US'];
    expect(en['tour.step3.action']).toBe('Click Add graph in the toolbar');
    expect(en['tour.step3.point.action']).toBe('Click a table to bind the graph');
    // The action names the change: three are ticked when the card shows and the step
    // completes only when the set changes (review of #160, D1; #159 items 5 and 9).
    expect(en['tour.step3.dimensions.action']).toBe(
      'Untick or tick a dimension, keeping at least two',
    );
    expect(en['tour.step3.point.body']).toMatch(/Deliverables and Team/);
    expect(en['tour.step3.dimensions.body']).toMatch(/^A dimension is a column/);
    expect(en['tour.step3.dimensions.body']).toMatch(/first three entered columns/);
    expect(en['tour.step3.dimensions.body']).toMatch(/Change the set — untick one of the three/);
  });

  test('ONB-12 the voice holds in every locale: no exclamation mark, no "Oops", no emoji', () => {
    for (const locale of LOCALES) {
      for (const key of TRANSLATED_KEYS) {
        const value = CATALOGUE[locale][key];
        expect(value, `${locale} ${key}`).not.toMatch(/!|Oops|\p{Extended_Pictographic}/u);
      }
    }
  });

  test('ONB-10 FIND-04 the operators step 4 names are ones Find understands, in every locale', () => {
    for (const locale of LOCALES) {
      const body = CATALOGUE[locale]['tour.step4.body'];
      const named = [...body.matchAll(/\b(col|is):[\w|]+/g)].map((m) => m[0]);
      expect(named, `${locale}: ${body}`).toEqual(['col:Owner', 'is:date']);
      for (const operator of named) {
        expect(isEmptyQuery(parseQuery(operator)), `${locale} ${operator}`).toBe(false);
      }
    }
  });

  test('A11Y-05 ADR-047 the object announcements compose a localized name with the undo chord in every locale', () => {
    expect(
      translate('en-US', 'object.deleted', {
        name: translate('en-US', 'object.name.ring', { table: 'Table 1' }),
        undo: '⌘Z',
      }),
    ).toBe('Deleted the ring of Table 1 — press ⌘Z to undo');
    expect(
      translate('en-US', 'object.deleted', {
        name: translate('en-US', 'object.name.pairUnbound'),
        undo: '⌘Z',
      }),
    ).toBe('Deleted the graph — press ⌘Z to undo');
    expect(translate('en-US', 'object.collapsed', { name: 'the coverage of Table 1' })).toBe(
      'Collapsed the coverage of Table 1',
    );
    // #163: the table's announcement counts its graphs and the cells its delete broke.
    expect(
      translate('en-US', 'object.deleted.refs', {
        name: translate('en-US', 'object.name.tableGraph', { table: 'Table 1' }),
        count: 3,
        undo: '⌘Z',
      }),
    ).toBe(
      'Deleted Table 1 and its graph — 3 cells elsewhere now read “reference removed”; press ⌘Z to undo',
    );
    expect(translate('en-US', 'object.name.tableGraphs', { table: 'Table 1', count: 2 })).toBe(
      'Table 1 and its 2 graphs',
    );
    expect(translate('en-US', 'object.collapse', { name: 'Ring graph of Table 1' })).toBe(
      'Collapse Ring graph of Table 1',
    );
    for (const locale of LOCALES) {
      const name = translate(locale, 'object.name.coverage', { table: 'Table 1' });
      expect(name, locale).toContain('Table 1');
      const said = translate(locale, 'object.deleted', { name, undo: '⌘Z' });
      expect(said, locale).toContain('Table 1');
      expect(said, locale).toContain('⌘Z');
      expect(said, locale).not.toMatch(/\{\w+\}/);
    }
  });

  test('ONB-12 format substitutes placeholders and leaves unknown ones as written', () => {
    expect(format('STEP {step} OF {total}', { step: 2, total: 5 })).toBe('STEP 2 OF 5');
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(translate('ta-IN', 'tour.counter', { step: 1, total: 5 })).toBe('படி 1 / 5');
    const key: MessageKey = 'tour.skip';
    expect(translate('hi-IN', key)).toBe('छोड़ें');
  });
});
