import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PHONE_QUERIES, isPhone, readPointerEnvironment, usePhone } from './breakpoint.js';
import { installMatchMedia, phoneMedia } from './test/match-media.js';

describe('phone predicate (ADR 039)', () => {
  it('RESP-02 a narrow viewport with a coarse pointer, or without hover, is a phone', () => {
    expect(isPhone({ narrow: true, coarse: true, noHover: true })).toBe(true);
    expect(isPhone({ narrow: true, coarse: true, noHover: false })).toBe(true);
    expect(isPhone({ narrow: true, coarse: false, noHover: true })).toBe(true);
  });

  it('A11Y-06 a narrow fine-pointer viewport with hover — a desktop at 200 % zoom — is not a phone', () => {
    expect(isPhone({ narrow: true, coarse: false, noHover: false })).toBe(false);
  });

  it('RESP-03 a wide viewport is never a phone, whatever the pointer', () => {
    expect(isPhone({ narrow: false, coarse: true, noHover: true })).toBe(false);
    expect(isPhone({ narrow: false, coarse: false, noHover: false })).toBe(false);
  });

  it('RESP-02 the width half of the predicate is the md breakpoint from the tokens', () => {
    expect(PHONE_QUERIES.narrow).toBe('(max-width: 767.98px)');
    expect(PHONE_QUERIES.coarse).toBe('(pointer: coarse)');
    expect(PHONE_QUERIES.noHover).toBe('(hover: none)');
  });

  it('RESP-02 usePhone reads the three queries from window.matchMedia', () => {
    installMatchMedia(phoneMedia);
    expect(readPointerEnvironment()).toEqual({ narrow: true, coarse: true, noHover: true });
    expect(renderHook(() => usePhone()).result.current).toBe(true);

    installMatchMedia((q) => q.includes('767.98')); // narrow, fine pointer, hover available
    expect(readPointerEnvironment()).toEqual({ narrow: true, coarse: false, noHover: false });
    expect(renderHook(() => usePhone()).result.current).toBe(false);

    installMatchMedia(false);
    expect(renderHook(() => usePhone()).result.current).toBe(false);
  });
});
