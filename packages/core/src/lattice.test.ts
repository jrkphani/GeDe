import { describe, expect, test } from 'vitest';

import {
  LATTICE,
  pointToPx,
  pxToUnits,
  snapPoint,
  snapSizeToUnits,
  snapToLattice,
  snapToUnits,
  unitsToPx,
} from './lattice.js';

describe('lattice', () => {
  test('GRID-01 the lattice is 160 × 22 px', () => {
    expect(LATTICE).toEqual({ col: 160, row: 22 });
  });

  test('GRID-01 snapToLattice rounds pixels to whole units on each axis', () => {
    expect(snapToLattice(0, 'col')).toBe(0);
    expect(snapToLattice(79, 'col')).toBe(0);
    expect(snapToLattice(80, 'col')).toBe(160);
    expect(snapToLattice(330, 'col')).toBe(320);
    expect(snapToLattice(10, 'row')).toBe(0);
    expect(snapToLattice(11, 'row')).toBe(22);
    expect(snapToLattice(45, 'row')).toBe(44);
  });

  test('GRID-01 nothing snaps above or left of A1', () => {
    expect(snapToLattice(-500, 'col')).toBe(0);
    expect(snapToUnits(-1, 'row')).toBe(0);
    expect(snapPoint({ x: -3, y: -3 })).toEqual({ col: 0, row: 0 });
  });

  test('GRID-08 a resized column or row is never smaller than one unit', () => {
    expect(snapSizeToUnits(0, 'col')).toBe(1);
    expect(snapSizeToUnits(3, 'row')).toBe(1);
    expect(snapSizeToUnits(400, 'col')).toBe(3);
  });

  test('GRID-01 unit and pixel conversions invert each other', () => {
    for (let units = 0; units < 50; units += 1) {
      expect(pxToUnits(unitsToPx(units, 'col'), 'col')).toBe(units);
      expect(pxToUnits(unitsToPx(units, 'row'), 'row')).toBe(units);
    }
    expect(pointToPx({ col: 2, row: 3 })).toEqual({ x: 320, y: 66 });
    expect(snapPoint({ x: 321, y: 65 })).toEqual({ col: 2, row: 3 });
  });

  test('GRID-01 non-finite input is a programming error', () => {
    expect(() => snapToLattice(Number.NaN, 'col')).toThrow(RangeError);
    expect(() => unitsToPx(Number.POSITIVE_INFINITY, 'row')).toThrow(RangeError);
  });
});
