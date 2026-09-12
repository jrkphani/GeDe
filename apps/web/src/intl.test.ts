import { describe, expect, it } from 'vitest';
import {
  collator,
  formatBytes,
  formatDate,
  formatNumber,
  isIndianLocale,
  recencyBucket,
} from './intl.js';

describe('intl', () => {
  it('I18N-04 Indian locales group as lakh and crore; others as thousands', () => {
    expect(formatNumber('en-IN', 1234567)).toBe('12,34,567');
    expect(formatNumber('hi-IN', 12345678)).toBe('1,23,45,678');
    expect(formatNumber('en-US', 1234567)).toBe('1,234,567');
    expect(formatNumber('en-GB', 1234567)).toBe('1,234,567');
    expect(isIndianLocale('ta-IN')).toBe(true);
    expect(isIndianLocale('en-GB')).toBe(false);
  });

  it('I18N-04 dates follow the locale: month-first in en-US, day-first in en-GB and en-IN', () => {
    const iso = '2026-09-10T10:00:00Z';
    expect(formatDate('en-US', iso)).toBe('Sep 10, 2026');
    expect(formatDate('en-GB', iso)).toBe('10 Sept 2026');
    expect(formatDate('en-IN', iso)).toBe('10 Sept 2026');
    expect(formatDate('en-US', iso, 'numeric')).toBe('9/10/26');
    expect(formatDate('en-GB', iso, 'numeric')).toBe('10/09/26');
    expect(formatDate('en-US', 'not a date')).toBe('');
  });

  it('I18N-04 sizes go through Intl units', () => {
    expect(formatBytes('en-US', 956000)).toBe('956 kB');
    expect(formatBytes('en-US', 93_700_000)).toBe('93.7 MB');
    expect(formatBytes('en-US', 12)).toBe('12 byte');
  });

  it('I18N-05 collation is case-insensitive and numeric-aware', () => {
    const c = collator('en-IN');
    expect(['Plan 10', 'plan 2', 'Archive'].sort((a, b) => c.compare(a, b))).toEqual([
      'Archive',
      'plan 2',
      'Plan 10',
    ]);
  });

  it('LIB-01 recency buckets are relative to the local day', () => {
    const now = new Date('2026-09-12T15:00:00').getTime();
    expect(recencyBucket('2026-09-12T01:00:00', now)).toBe('today');
    expect(recencyBucket('2026-09-11T23:59:00', now)).toBe('yesterday');
    expect(recencyBucket('2026-09-07T12:00:00', now)).toBe('this-week');
    expect(recencyBucket('2026-09-02T12:00:00', now)).toBe('this-month');
    expect(recencyBucket('2026-08-31T12:00:00', now)).toBe('earlier');
    expect(recencyBucket('garbage', now)).toBe('earlier');
  });
});
