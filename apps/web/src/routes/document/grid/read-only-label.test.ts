import { afterEach, expect, test } from 'vitest';

import { resetLocaleForTests, setLocale } from '../../../locale.js';
import { readOnlyAnnouncement, readOnlyLabel } from './commands.js';

afterEach(() => {
  resetLocaleForTests();
});

test('SET-08 the computed read-only reason is read in the active locale', () => {
  expect(readOnlyLabel('computed')).toBe('the column is computed');
  setLocale('ta-IN');
  expect(readOnlyLabel('computed')).toBe('இந்த நெடுவரிசை கணக்கிடப்படுகிறது');
});

test('SET-08 the read-only refusal is announced whole in the active locale', () => {
  setLocale('en-US');
  expect(readOnlyAnnouncement('B16', 'computed')).toBe('B16 is read-only: the column is computed');
  expect(readOnlyAnnouncement(null, 'derived')).toBe('The cell is read-only: derived column');
  setLocale('ta-IN');
  const said = readOnlyAnnouncement('B16', 'computed');
  expect(said).toBe('B16 படிக்க மட்டும்: இந்த நெடுவரிசை கணக்கிடப்படுகிறது');
  expect(said).not.toMatch(/read-only/);
});
