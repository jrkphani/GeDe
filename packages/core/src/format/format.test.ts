import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { sumCurrency, sumToCellValue } from './aggregate.js';
import { describeScope, FORMAT_LABELS } from './column.js';
import {
  compareDates,
  compareIsoDates,
  currencyOf,
  epochDay,
  isoDate,
  parseDate,
  parseNumber,
} from './parse.js';
import {
  cellFormat,
  clampDecimals,
  FORMAT_LOCALES,
  readFormatOpts,
  type FormatLocale,
} from './types.js';
import {
  canonicalText,
  formatCurrency,
  formatDate,
  formatNumber,
  renderText,
  resolveValue,
  toCellValue,
} from './value.js';

describe('parseNumber', () => {
  test('FMT-02 grouping, decimals, signs and accounting parentheses parse to one number', () => {
    expect(parseNumber('1,234.5')?.value).toBe(1234.5);
    expect(parseNumber('12,34,567')?.value).toBe(1234567);
    expect(parseNumber('-12')?.value).toBe(-12);
    expect(parseNumber('−12')?.value).toBe(-12);
    expect(parseNumber('(1,234.50)')?.value).toBe(-1234.5);
    expect(parseNumber('.5')?.value).toBe(0.5);
    expect(parseNumber(' 42 ')?.value).toBe(42);
  });

  test('FMT-05 text that is not a number is null, never zero', () => {
    for (const s of ['', 'abc', '12abc', '1,2345', '1.2.3', '12%', '1e5', '१२']) {
      expect(parseNumber(s)).toBeNull();
    }
  });

  test('FMT-05 a doubled negation is not a number, never a positive', () => {
    for (const s of ['--5', '−−5', '(-5)', '-(5)', '-$-5', '($-5)']) {
      expect(parseNumber(s)).toBeNull();
    }
    expect(parseNumber('-$5')?.value).toBe(-5);
    expect(parseNumber('$-5')?.value).toBe(-5);
    expect(parseNumber('(5)')?.value).toBe(-5);
  });

  test('FMT-03 currency symbols and codes are recognised, bare $ is ambiguous', () => {
    expect(parseNumber('S$1,250.00')).toEqual({
      value: 1250,
      currency: 'SGD',
      dollar: false,
      monetary: true,
    });
    expect(parseNumber('USD 300')).toEqual({
      value: 300,
      currency: 'USD',
      dollar: false,
      monetary: true,
    });
    expect(parseNumber('45 INR')?.currency).toBe('INR');
    expect(parseNumber('₹12,34,567')?.currency).toBe('INR');
    expect(parseNumber('RM 9.90')?.currency).toBe('MYR');
    expect(parseNumber('Rp5000')?.currency).toBe('IDR');
    expect(parseNumber('₱99')?.currency).toBe('PHP');
    expect(parseNumber('$12')).toEqual({ value: 12, currency: null, dollar: true, monetary: true });
    expect(parseNumber('($12.50)')?.value).toBe(-12.5);
    expect(parseNumber('$-12')?.value).toBe(-12);
  });

  test('FMT-03 a bare $ takes the column currency when that is SGD or USD, else SGD', () => {
    const dollar = parseNumber('$1')!;
    expect(currencyOf(dollar, undefined)).toBe('SGD');
    expect(currencyOf(dollar, 'USD')).toBe('USD');
    expect(currencyOf(dollar, 'MYR')).toBe('SGD');
    expect(currencyOf(parseNumber('RM1')!, 'USD')).toBe('MYR');
    expect(currencyOf(parseNumber('1')!, 'PHP')).toBe('PHP');
  });
});

describe('parseDate (FMT-04)', () => {
  test('FMT-04 D/M/Y and Y-M-D parse to the same civil date', () => {
    expect(parseDate('12/9/2026')).toEqual({ year: 2026, month: 9, day: 12 });
    expect(parseDate('12/09/26')).toEqual({ year: 2026, month: 9, day: 12 });
    expect(parseDate('2026-09-12')).toEqual({ year: 2026, month: 9, day: 12 });
    expect(parseDate('12 Sep 2026')).toEqual({ year: 2026, month: 9, day: 12 });
    expect(parseDate('12 Sept 2026')).toEqual({ year: 2026, month: 9, day: 12 });
  });

  test('FMT-04 impossible dates and non-dates are null', () => {
    for (const s of [
      '31/2/2026',
      '13/13/2026',
      '2026-02-30',
      '0/1/2026',
      'tomorrow',
      '12-09-2026',
    ]) {
      expect(parseDate(s)).toBeNull();
    }
    expect(parseDate('29/2/2024')).not.toBeNull();
    expect(parseDate('29/2/2025')).toBeNull();
  });

  test('FMT-04 compareDates orders chronologically whatever the typed pattern', () => {
    const a = parseDate('1/1/2026')!;
    const b = parseDate('2025-12-31')!;
    expect(compareDates(a, b)).toBeGreaterThan(0);
    expect(compareDates(b, a)).toBeLessThan(0);
    expect(compareDates(a, parseDate('01/01/26')!)).toBe(0);
    expect(compareIsoDates('2026-01-01', '2026-01-02')).toBeLessThan(0);
    expect(compareIsoDates('nope', '2026-01-02')).toBeGreaterThan(0);
    expect(epochDay({ year: 1970, month: 1, day: 2 })).toBe(1);
    expect(isoDate({ year: 2026, month: 9, day: 1 })).toBe('2026-09-01');
  });

  test('FMT-04 sorting by epochDay agrees with sorting by ISO string', () => {
    const arbDate = fc
      .record({
        y: fc.integer({ min: 1900, max: 2100 }),
        m: fc.integer({ min: 1, max: 12 }),
        d: fc.integer({ min: 1, max: 28 }),
      })
      .map(({ y, m, d }) => ({ year: y, month: m, day: d }));
    fc.assert(
      fc.property(fc.array(arbDate, { minLength: 2, maxLength: 12 }), (dates) => {
        const byDay = [...dates].sort(compareDates).map(isoDate);
        const byIso = dates.map(isoDate).sort();
        expect(byDay).toEqual(byIso);
      }),
    );
  });
});

describe('resolveValue (FMT-01, FMT-05)', () => {
  test('FMT-01 Automatic infers number, currency, date or text and never fails', () => {
    const auto = cellFormat('auto');
    expect(resolveValue('1,234', auto)).toEqual({ kind: 'number', value: 1234 });
    expect(resolveValue('S$12', auto)).toEqual({ kind: 'currency', value: 12, code: 'SGD' });
    expect(resolveValue('$12', auto)).toEqual({ kind: 'currency', value: 12, code: 'SGD' });
    expect(resolveValue('12/9/2026', auto)).toEqual({ kind: 'date', iso: '2026-09-12' });
    expect(resolveValue('hello', auto)).toEqual({ kind: 'text', text: 'hello' });
    expect(resolveValue('  ', auto)).toEqual({ kind: 'blank' });
  });

  test('FMT-01 Automatic never rewrites the stored text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(canonicalText(text, cellFormat('auto'))).toBe(text);
        expect(canonicalText(text, cellFormat('text'))).toBe(text);
      }),
    );
  });

  test('FMT-05 under an explicit format unparsable text is invalid, not zero', () => {
    expect(resolveValue('abc', cellFormat('number'))).toEqual({
      kind: 'invalid',
      text: 'abc',
      expected: 'number',
    });
    expect(resolveValue('abc', cellFormat('currency'))).toEqual({
      kind: 'invalid',
      text: 'abc',
      expected: 'currency',
    });
    expect(resolveValue('abc', cellFormat('date'))).toEqual({
      kind: 'invalid',
      text: 'abc',
      expected: 'date',
    });
    expect(toCellValue(resolveValue('abc', cellFormat('number')))).toEqual({ kind: 'blank' });
    expect(renderText('abc', cellFormat('number'))).toEqual({
      text: 'abc',
      align: 'left',
      invalid: true,
    });
  });

  test('Text format is never numeric', () => {
    expect(resolveValue('1234', cellFormat('text'))).toEqual({ kind: 'text', text: '1234' });
  });

  test('FMT-03 Currency takes the column code unless the text names another', () => {
    const sgd = cellFormat('currency', { currency: 'SGD' });
    expect(resolveValue('12', sgd)).toEqual({ kind: 'currency', value: 12, code: 'SGD' });
    expect(resolveValue('USD 12', sgd)).toEqual({ kind: 'currency', value: 12, code: 'USD' });
    expect(resolveValue('12', cellFormat('currency'))).toEqual({
      kind: 'currency',
      value: 12,
      code: 'SGD',
    });
  });

  test('FMT-02 the stored value is the parsed number; FMT-04 dates store as ISO', () => {
    expect(canonicalText('1,234.50', cellFormat('number'))).toBe('1234.5');
    expect(canonicalText('(1,234.50)', cellFormat('number'))).toBe('-1234.5');
    expect(canonicalText('S$1,250', cellFormat('currency', { currency: 'SGD' }))).toBe('1250');
    expect(canonicalText('USD 300', cellFormat('currency', { currency: 'SGD' }))).toBe('300 USD');
    expect(canonicalText('12/9/2026', cellFormat('date'))).toBe('2026-09-12');
    expect(canonicalText('abc', cellFormat('number'))).toBe('abc');
  });
});

describe('rendering through Intl (FMT-02..04, I18N-04)', () => {
  test('FMT-02 numbers render with 0–6 decimals, locale grouping and right alignment', () => {
    expect(renderText('1234.5', cellFormat('number', { decimals: 2 }), 'en-US')).toEqual({
      text: '1,234.50',
      align: 'right',
      invalid: false,
    });
    expect(formatNumber(1234.5, { decimals: 0 }, 'en-US')).toBe('1,235');
    expect(formatNumber(1234.5, { decimals: 6 }, 'en-US')).toBe('1,234.500000');
    expect(formatNumber(1234.5678901, {}, 'en-US')).toBe('1,234.56789');
    expect(formatNumber(1234.5, { grouping: false }, 'en-US')).toBe('1234.5');
    expect(clampDecimals(9)).toBe(6);
    expect(clampDecimals(-1)).toBe(0);
    expect(clampDecimals('2')).toBeUndefined();
  });

  test('FMT-02 changing the format re-renders the same stored text', () => {
    const stored = canonicalText('1,234.5', cellFormat('number'));
    expect(renderText(stored, cellFormat('number', { decimals: 0 }), 'en-US').text).toBe('1,235');
    expect(renderText(stored, cellFormat('number', { decimals: 3 }), 'en-IN').text).toBe(
      '1,234.500',
    );
    expect(renderText(stored, cellFormat('currency', { currency: 'USD' }), 'en-US').text).toBe(
      '$1,234.50',
    );
  });

  test('I18N-04 Indian locales group lakh and crore; others group thousands', () => {
    expect(formatNumber(12345678.9, {}, 'en-IN')).toBe('1,23,45,678.9');
    expect(formatNumber(12345678.9, {}, 'hi-IN')).toBe('1,23,45,678.9');
    expect(formatNumber(12345678.9, {}, 'ta-IN')).toBe('1,23,45,678.9');
    expect(formatNumber(12345678.9, {}, 'te-IN')).toBe('1,23,45,678.9');
    expect(formatNumber(12345678.9, {}, 'en-US')).toBe('12,345,678.9');
    expect(formatNumber(12345678.9, {}, 'en-GB')).toBe('12,345,678.9');
  });

  test('FMT-03 currency: SGD default, negatives in accounting parentheses in every locale', () => {
    expect(formatCurrency(1234.5, 'SGD', {}, 'en-US')).toBe('SGD\u00a01,234.50');
    for (const locale of FORMAT_LOCALES) {
      const text = formatCurrency(-1234.5, 'SGD', {}, locale);
      expect(text.startsWith('(')).toBe(true);
      expect(text.endsWith(')')).toBe(true);
      expect(text).toContain('1,234.50');
      expect(text).not.toContain('-');
    }
    expect(renderText('-5', cellFormat('currency'), 'en-US')).toEqual({
      text: '(SGD\u00a05.00)',
      align: 'right',
      invalid: false,
    });
  });

  test('I18N-04 currency in an Indian locale groups lakh/crore', () => {
    expect(formatCurrency(1234567.89, 'INR', {}, 'en-IN')).toBe('₹12,34,567.89');
    expect(formatCurrency(1234567.89, 'INR', {}, 'hi-IN')).toBe('₹12,34,567.89');
    expect(formatCurrency(-1234567.89, 'SGD', {}, 'ta-IN')).toBe('(SGD\u00a012,34,567.89)');
    expect(formatCurrency(1234567.89, 'INR', { grouping: false }, 'en-IN')).toBe('₹1234567.89');
    expect(formatCurrency(1234567.891, 'USD', { decimals: 0 }, 'en-US')).toBe('$1,234,568');
  });

  test('FMT-03 all six currencies render', () => {
    const codes = ['SGD', 'MYR', 'PHP', 'IDR', 'USD', 'INR'];
    for (const code of codes) {
      const text = formatCurrency(10, code, {}, 'en-GB');
      expect(text).toContain('10');
    }
  });

  test('FMT-04 dates render per locale in every pattern', () => {
    const d = { year: 2026, month: 9, day: 12 };
    expect(formatDate(d, 'D MMM YYYY', 'en-US')).toBe('Sep 12, 2026');
    expect(formatDate(d, 'D MMM YYYY', 'en-GB')).toBe('12 Sept 2026');
    expect(formatDate(d, 'D MMM YYYY', 'en-IN')).toBe('12 Sept 2026');
    expect(formatDate(d, 'DD/MM/YYYY', 'en-US')).toBe('09/12/2026');
    expect(formatDate(d, 'DD/MM/YYYY', 'en-GB')).toBe('12/09/2026');
    expect(formatDate(d, 'YYYY-MM-DD', 'ta-IN')).toBe('2026-09-12');
    expect(formatDate(d, 'MMM YYYY', 'en-GB')).toBe('Sept 2026');
    for (const locale of ['ta-IN', 'hi-IN', 'te-IN'] as const) {
      expect(formatDate(d, 'D MMM YYYY', locale)).toContain('2026');
      expect(formatDate(d, 'D MMM YYYY', locale)).not.toMatch(/Sep/);
    }
    expect(renderText('12/9/2026', cellFormat('date'), 'en-GB')).toEqual({
      text: '12 Sept 2026',
      align: 'left',
      invalid: false,
    });
  });

  test('I18N-04 every value kind renders in every locale without throwing', () => {
    const locales: readonly FormatLocale[] = FORMAT_LOCALES;
    fc.assert(
      fc.property(
        fc.constantFrom(...locales),
        fc.double({ min: -1e9, max: 1e9, noNaN: true }),
        fc.constantFrom(0, 2, 6),
        (locale, n, decimals) => {
          expect(typeof formatNumber(n, { decimals }, locale)).toBe('string');
          expect(typeof formatCurrency(n, 'INR', { decimals }, locale)).toBe('string');
        },
      ),
    );
  });
});

describe('sumCurrency (FMT-03, FMT-05, FX-02)', () => {
  test('FMT-03 mixed currencies are an error naming the offender, never a conversion', () => {
    const result = sumCurrency([
      { value: { kind: 'currency', value: 10, code: 'SGD' }, address: 'B2' },
      { value: { kind: 'currency', value: 5, code: 'USD' }, address: 'B3' },
    ]);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'mixed-currency', address: 'B3', codes: ['SGD', 'USD'] },
    });
  });

  test('FMT-05 invalid cells are excluded and counted; blanks are zero', () => {
    const result = sumCurrency([
      { kind: 'currency', value: 10, code: 'SGD' },
      { kind: 'invalid', text: 'abc', expected: 'currency' },
      { kind: 'blank' },
      { kind: 'number', value: 2.5 },
    ]);
    expect(result).toEqual({
      ok: true,
      value: { kind: 'currency', value: 12.5, code: 'SGD', excluded: 1 },
    });
    if (result.ok)
      expect(sumToCellValue(result.value)).toEqual({ kind: 'currency', value: 12.5, code: 'SGD' });
  });

  test('FX-02 text or a date in the range is text-in-range', () => {
    expect(sumCurrency([{ kind: 'text', text: 'x' }])).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: '#1' },
    });
    expect(sumCurrency([{ value: { kind: 'date', iso: '2026-01-01' }, address: 'C4' }])).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'C4' },
    });
  });

  test('numbers alone sum to a number', () => {
    expect(
      sumCurrency([
        { kind: 'number', value: 1 },
        { kind: 'number', value: 2 },
      ]),
    ).toEqual({
      ok: true,
      value: { kind: 'number', value: 3, excluded: 0 },
    });
    expect(sumToCellValue({ kind: 'number', value: 3, excluded: 0 })).toEqual({
      kind: 'number',
      value: 3,
    });
  });
});

describe('describeScope (FMT-06)', () => {
  test('FMT-06 states the column, the format, the row count and that later rows inherit', () => {
    expect(
      describeScope({
        columnLabel: 'Amount',
        rowCount: 12,
        overrides: 0,
        to: 'currency',
        currency: 'SGD',
      }),
    ).toBe('Formats Amount as Currency (SGD) for all 12 rows, and for rows added later.');
    expect(describeScope({ columnLabel: 'Due', rowCount: 1, overrides: 1, to: 'date' })).toBe(
      'Formats Due as Date for all 1 row, and for rows added later. 1 cell with its own format will keep it.',
    );
    expect(
      describeScope({ columnLabel: 'Due', rowCount: 3, overrides: 2, to: 'number' }),
    ).toContain('2 cells with their own format will keep them.');
    expect(
      describeScope({
        columnLabel: 'Due',
        rowCount: 3,
        overrides: 0,
        to: 'text',
        cellOnly: true,
        address: 'B4',
      }),
    ).toBe('Formats cell B4 as Text. Other cells in Due keep the column format.');
    expect(FORMAT_LABELS.auto).toBe('Automatic');
  });
});

describe('readFormatOpts', () => {
  test('drops unknown keys and off-vocabulary values', () => {
    expect(
      readFormatOpts({
        decimals: 3,
        currency: 'EUR',
        datePattern: 'bogus',
        textCase: 'upper',
        extra: 1,
      }),
    ).toEqual({
      decimals: 3,
      textCase: 'upper',
    });
    expect(readFormatOpts(null)).toEqual({});
    expect(readFormatOpts({ grouping: false, currency: 'INR', datePattern: 'MMM YYYY' })).toEqual({
      grouping: false,
      currency: 'INR',
      datePattern: 'MMM YYYY',
    });
  });
});
