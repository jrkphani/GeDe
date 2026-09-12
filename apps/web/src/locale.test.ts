import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeLocale,
  bindUserLocale,
  resetLocaleForTests,
  setLocale,
  unbindUserLocale,
} from './locale.js';

describe('locale store', () => {
  beforeEach(() => {
    resetLocaleForTests();
  });

  it('I18N-05 a choice persists on the device and, once a user is bound, under that user', () => {
    expect(activeLocale()).toBe('en-US');
    setLocale('en-GB');
    expect(localStorage.getItem('gede.locale')).toBe('en-GB');
    expect(localStorage.getItem('gede.locale.sub-1')).toBeNull();
    bindUserLocale('sub-1');
    expect(activeLocale()).toBe('en-GB');
    setLocale('ta-IN');
    expect(localStorage.getItem('gede.locale.sub-1')).toBe('ta-IN');
    expect(document.documentElement.lang).toBe('ta-IN');
  });

  it('I18N-05 binding a user prefers the server value, then the user’s local value, then the device', () => {
    localStorage.setItem('gede.locale', 'en-GB');
    localStorage.setItem('gede.locale.sub-2', 'hi-IN');
    resetLocaleForTests();
    expect(bindUserLocale('sub-2')).toBe('hi-IN');
    expect(bindUserLocale('sub-2', 'te-IN')).toBe('te-IN');
    expect(bindUserLocale('sub-2', 'xx-YY')).toBe('te-IN'); // unsupported: keep the stored one
    unbindUserLocale();
    expect(bindUserLocale('sub-3')).toBe('te-IN'); // a new user inherits what the device shows
  });
});
