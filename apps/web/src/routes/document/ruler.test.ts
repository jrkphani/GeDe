import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATTICE } from '@gede/core';

import { ROW_LABEL_MIN_PX, rowIsLabelled, rowLabelStep } from './ruler.js';

describe('canvas type floor (issue #65)', () => {
  it('SHARE-04 the presence name tag sits on the 9 px label step, never below the type scale, and hides beneath the micro tier', () => {
    const css = readFileSync(resolve(__dirname, 'document.css'), 'utf8');
    const rule = /\.gd-cell__presence-tag\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/font-size:\s*0\.5625rem/);
    expect(rule).not.toMatch(/font-size:\s*0\.5rem/);
    expect(css).toMatch(/\.gd-table--macro \.gd-cell__presence-tag\s*\{[^}]*display:\s*none/);
  });
});

describe('row ruler labels (DOC-06, issue #65)', () => {
  it('DOC-06 labels every row down to the pitch a 9.5 px label needs, then thins to every 2nd, 5th, 10th …', () => {
    expect(rowLabelStep(LATTICE.row)).toBe(1); // 100 %
    expect(rowLabelStep(LATTICE.row * 0.75)).toBe(1); // 16.5 px
    expect(rowLabelStep(LATTICE.row * 0.5)).toBe(2); // 11 px: below the 12 px floor
    expect(rowLabelStep(LATTICE.row * 0.28)).toBe(2); // 6.16 px → every 2nd is 12.3 px
    expect(rowLabelStep(LATTICE.row * 0.15)).toBe(5); // 3.3 px → every 5th is 16.5 px
    expect(rowLabelStep(1)).toBe(20);
    expect(rowLabelStep(0)).toBe(100);
    for (const zoom of [0.1, 0.25, 0.28, 0.5, 1, 2]) {
      expect(rowLabelStep(LATTICE.row * zoom) * LATTICE.row * zoom).toBeGreaterThanOrEqual(
        ROW_LABEL_MIN_PX,
      );
    }
  });

  it('DOC-06 row 1 is always labelled; then the multiples of the step', () => {
    expect([0, 1, 2, 3, 4, 9].map((r) => rowIsLabelled(r, 1))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([0, 1, 2, 3, 4, 9].map((r) => rowIsLabelled(r, 5))).toEqual([
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});
