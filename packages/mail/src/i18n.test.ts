import { describe, expect, test } from 'vitest';

import { format, resolveMailLocale, SUBJECT_MAX, subjectFor, translate, truncate } from './i18n.js';

describe('locale resolution', () => {
  test('I18N-05 an exact tag is kept, a bare language or a foreign region maps to the nearest shipped locale, anything else is en-US', () => {
    expect(resolveMailLocale('ta-IN')).toBe('ta-IN');
    expect(resolveMailLocale('en-gb')).toBe('en-GB');
    expect(resolveMailLocale('hi_IN')).toBe('hi-IN');
    expect(resolveMailLocale('ta')).toBe('ta-IN');
    expect(resolveMailLocale('te-US')).toBe('te-IN');
    expect(resolveMailLocale('en-AU')).toBe('en-US');
    expect(resolveMailLocale('fr-FR')).toBe('en-US');
    expect(resolveMailLocale(undefined)).toBe('en-US');
    expect(resolveMailLocale(null)).toBe('en-US');
    expect(resolveMailLocale('')).toBe('en-US');
  });
});

describe('formatting', () => {
  test('I18N-05 format substitutes placeholders and leaves unknown ones as written', () => {
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(translate('hi-IN', 'layout.sentTo', { email: 'a@b.c' })).toBe(
      'यह ईमेल a@b.c को भेजा गया।',
    );
  });

  test('I18N-05 truncate cuts on a grapheme boundary, never inside a Tamil or Telugu syllable', () => {
    expect(truncate('abcdef', 6)).toBe('abcdef');
    expect(truncate('abcdefg', 6)).toBe('abcde…');
    // கொ is two code units (க + ொ); a cut at 3 units may not split it.
    expect(truncate('கொகொகொ', 3)).toBe('கொ…');
    expect(truncate('మిమ్మల్ని', 4)).toBe('మి…');
  });

  test('SHARE-02 subjectFor trims the title so the subject fits 60 characters, in every script', () => {
    const long = 'x'.repeat(200);
    const en = subjectFor('en-US', 'share.member.subject', { actor: 'Meenarapan D', title: long });
    expect(en.length).toBe(SUBJECT_MAX);
    expect(en.endsWith('…” with you')).toBe(true);
    const ta = subjectFor('ta-IN', 'share.member.subject', { actor: 'மீனா', title: long });
    expect(ta.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(ta.endsWith('-ஐ உங்களுடன் பகிர்ந்துள்ளார்')).toBe(true);
    // No title placeholder: the whole subject is capped instead.
    const invite = subjectFor('en-US', 'share.invite.subject', { actor: 'y'.repeat(80) });
    expect(invite.length).toBe(SUBJECT_MAX);
  });
});
