import { describe, expect, test } from 'vitest';

import { detectIndicLang } from './script.js';

describe('script detection (I18N-03)', () => {
  test('I18N-03 Tamil, Devanagari and Telugu text report their lang; Latin reports none', () => {
    expect(detectIndicLang('வணக்கம்')).toBe('ta');
    expect(detectIndicLang('नमस्ते')).toBe('hi');
    expect(detectIndicLang('నమస్కారం')).toBe('te');
    expect(detectIndicLang('Hello 123')).toBeNull();
    expect(detectIndicLang('')).toBeNull();
  });

  test('mixed text takes the first Indic script that appears', () => {
    expect(detectIndicLang('Total: ₹12 — மொத்தம் / कुल')).toBe('ta');
    expect(detectIndicLang('कुल மொத்தம்')).toBe('hi');
  });
});
