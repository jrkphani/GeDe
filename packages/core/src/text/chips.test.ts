import { describe, expect, test } from 'vitest';

import { extract } from './algebra.js';
import {
  CHIP_IDS,
  CHIP_PATTERNS,
  chipRegExp,
  handleChipRequest,
  isChipRequest,
  isRe2Safe,
  MAX_PATTERN_LENGTH,
} from './chips.js';
import { docNode, paragraphNode, plainText, richFromText, textNode } from './types.js';

function found(chip: (typeof CHIP_IDS)[number], text: string): string[] {
  return extract(richFromText(text), chipRegExp(chip)).map(plainText);
}

describe('Smart Chips (PRD §5, SORT-04)', () => {
  test('SORT-04 the eight chips exist with labels and compile', () => {
    expect(CHIP_IDS).toEqual([
      'email',
      'date',
      'currency',
      'company',
      'country',
      'parenthetical',
      'afterDash',
      'beforeDash',
    ]);
    for (const id of CHIP_IDS) {
      expect(CHIP_PATTERNS[id].label).not.toBe('');
      expect(() => chipRegExp(id)).not.toThrow();
      expect(isRe2Safe(CHIP_PATTERNS[id].source, CHIP_PATTERNS[id].flags)).toEqual({ ok: true });
    }
  });

  test('SORT-04 Email', () => {
    expect(found('email', 'Reach meena@1cloudhub.com or shankar.r@example.co.uk today')).toEqual([
      'meena@1cloudhub.com',
      'shankar.r@example.co.uk',
    ]);
    expect(found('email', 'no address here')).toEqual([]);
  });

  test('SORT-04 Date', () => {
    expect(found('date', 'Due 12/09/2026, signed 2026-09-01, kickoff 9 Sept 2026.')).toEqual([
      '12/09/2026',
      '2026-09-01',
      '9 Sept 2026',
    ]);
  });

  test('SORT-04 Currency', () => {
    expect(found('currency', 'Paid S$1,250.00 then USD 300 and ₹12,34,567; 45 INR left')).toEqual([
      'S$1,250.00',
      'USD 300',
      '₹12,34,567',
      '45 INR',
    ]);
  });

  test('SORT-04 Company', () => {
    expect(
      found('company', 'Vendor: 1Cloudhub Pte. Ltd. and Acme Widgets Sdn Bhd, plus Globex Corp'),
    ).toEqual(['1Cloudhub Pte. Ltd.', 'Acme Widgets Sdn Bhd', 'Globex Corp']);
  });

  test('SORT-04 Country', () => {
    expect(found('country', 'Offices in Singapore, India and the United Kingdom')).toEqual([
      'Singapore',
      'India',
      'United Kingdom',
    ]);
  });

  test('Parenthetical extracts the inside of the parentheses', () => {
    expect(found('parenthetical', 'Meena (PM) and Shankar (Design lead)')).toEqual([
      'PM',
      'Design lead',
    ]);
  });

  test('After dash and Before dash split a title at its first dash, per line', () => {
    expect(found('afterDash', 'GeDe - text-oriented spreadsheet\nSecond — line')).toEqual([
      'text-oriented spreadsheet',
      'line',
    ]);
    expect(found('beforeDash', 'GeDe - text-oriented spreadsheet\nSecond — line')).toEqual([
      'GeDe',
      'Second',
    ]);
    expect(found('afterDash', 'well-known name')).toEqual([]);
  });

  test('chips keep the marks of what they extract', () => {
    const d = docNode([paragraphNode([textNode('mail '), textNode('a@b.io', [{ type: 'bold' }])])]);
    expect(extract(d, chipRegExp('email'))).toEqual([
      docNode([paragraphNode([textNode('a@b.io', [{ type: 'bold' }])])]),
    ]);
  });
});

describe('RE2 safety', () => {
  test('lookaround, backreferences and over-long patterns are refused', () => {
    expect(isRe2Safe('a(?=b)').ok).toBe(false);
    expect(isRe2Safe('(?<!a)b').ok).toBe(false);
    expect(isRe2Safe('(a)\\1').ok).toBe(false);
    expect(isRe2Safe('(?<n>a)\\k<n>').ok).toBe(false);
    expect(isRe2Safe('a'.repeat(MAX_PATTERN_LENGTH + 1)).ok).toBe(false);
    expect(isRe2Safe('[unclosed').ok).toBe(false);
    expect(isRe2Safe('\\d+(?:\\.\\d+)?')).toEqual({ ok: true });
  });
});

describe('chip request / response (Worker contract)', () => {
  test('a chip request answers with matches in plain-text offsets', () => {
    expect(handleChipRequest({ id: 7, kind: 'chip', chip: 'email', text: 'hi a@b.io' })).toEqual({
      id: 7,
      ok: true,
      matches: [{ start: 3, end: 9, text: 'a@b.io' }],
    });
  });

  test('a regex request runs a safe user pattern and refuses an unsafe one', () => {
    expect(handleChipRequest({ id: 1, kind: 'regex', source: '\\d+', text: 'a 12 b 3' })).toEqual({
      id: 1,
      ok: true,
      matches: [
        { start: 2, end: 4, text: '12' },
        { start: 7, end: 8, text: '3' },
      ],
    });
    const refused = handleChipRequest({ id: 2, kind: 'regex', source: 'a(?=b)', text: 'ab' });
    expect(refused.ok).toBe(false);
  });

  test('an unknown chip is an error response, never a throw', () => {
    const response = handleChipRequest({
      id: 3,
      kind: 'chip',
      chip: 'phone' as never,
      text: '',
    });
    expect(response).toEqual({ id: 3, ok: false, error: 'unknown chip phone' });
  });

  test('isChipRequest guards the message shape', () => {
    expect(isChipRequest({ id: 1, kind: 'chip', chip: 'email', text: '' })).toBe(true);
    expect(isChipRequest({ id: 1, kind: 'regex', source: 'a', text: '' })).toBe(true);
    expect(isChipRequest({ id: '1', kind: 'chip', chip: 'email', text: '' })).toBe(false);
    expect(isChipRequest({ id: 1, kind: 'other', text: '' })).toBe(false);
    expect(isChipRequest(null)).toBe(false);
  });
});
