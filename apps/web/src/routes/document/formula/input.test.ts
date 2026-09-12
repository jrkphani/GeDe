import { describe, expect, it } from 'vitest';

import {
  entityQueryAt,
  insertReferenceAt,
  isBareEquals,
  isFormulaInput,
  replaceRange,
  separatorBefore,
} from './input.js';

describe('formula input helpers', () => {
  it('FX-07 isFormulaInput matches what the document stores as a formula: a leading =', () => {
    expect(isFormulaInput('=Sum(B2:B14)')).toBe(true);
    expect(isFormulaInput(' =Sum()')).toBe(false);
    expect(isFormulaInput('Base camp')).toBe(false);
    expect(isBareEquals('=')).toBe(true);
    expect(isBareEquals('=S')).toBe(false);
  });

  it('FX-04 entityQueryAt finds the @ path under the caret, quoted segments included', () => {
    expect(entityQueryAt('=Sum(@Ever', 10)).toEqual({ start: 5, query: 'Ever' });
    expect(entityQueryAt('=@"Everest trek".Luk', 20)).toEqual({
      start: 1,
      query: '"Everest trek".Luk',
    });
    expect(entityQueryAt('=Sum(@Everest, B2', 17)).toBeNull();
    expect(entityQueryAt('=Sum(@Everest, @', 16)).toEqual({ start: 15, query: '' });
    expect(entityQueryAt('hello @there', 12)).toBeNull();
    // Caret before the @: nothing to complete yet.
    expect(entityQueryAt('=@Ever', 1)).toBeNull();
  });

  it('FX-05 insertReferenceAt adds a separator only where the grammar needs one', () => {
    expect(separatorBefore('=Sum(')).toBe('');
    expect(separatorBefore('=Sum(B2, ')).toBe('');
    expect(separatorBefore('=B2:')).toBe('');
    expect(separatorBefore('=')).toBe('');
    expect(separatorBefore('=Sum(B2')).toBe(', ');
    expect(separatorBefore('=B2 ')).toBe(', ');
    expect(insertReferenceAt('=Sum(', 5, 5, 'B5')).toEqual({ text: '=Sum(B5', caret: 7 });
    expect(insertReferenceAt('=Sum(B5', 7, 7, 'B6')).toEqual({ text: '=Sum(B5, B6', caret: 11 });
    expect(insertReferenceAt('=Sum(B5)', 7, 7, 'B6')).toEqual({ text: '=Sum(B5, B6)', caret: 11 });
    // A selection is replaced.
    expect(insertReferenceAt('=Sum(B5)', 5, 7, 'C9')).toEqual({ text: '=Sum(C9)', caret: 7 });
  });

  it('replaceRange keeps the tail and lands the caret after the insertion', () => {
    expect(replaceRange('=Sum(@Ev, B2)', 5, 8, '@Everest.Lukla')).toEqual({
      text: '=Sum(@Everest.Lukla, B2)',
      caret: 19,
    });
  });
});
