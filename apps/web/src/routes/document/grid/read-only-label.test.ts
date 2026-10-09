import { afterEach, expect, test } from 'vitest';

import { resetLocaleForTests, setLocale } from '../../../locale.js';
import { readOnlyLabel } from './commands.js';

afterEach(() => {
  resetLocaleForTests();
});

test('SET-08 the computed read-only reason is read in the active locale', () => {
  expect(readOnlyLabel('computed')).toBe('the column is computed');
  setLocale('ta-IN');
  expect(readOnlyLabel('computed')).toBe('இந்த நெடுவரிசை கணக்கிடப்படுகிறது');
});
