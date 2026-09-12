/**
 * The lattice (PRD §12, GRID-01): a uniform grid of 160 × 22 px cells underlies
 * the whole canvas. Geometry and addressing are one fact — every table origin,
 * column width and row height is a whole number of lattice units, so a pixel
 * position always maps to exactly one A1 address.
 */
export const LATTICE = { col: 160, row: 22 } as const;

export type Axis = keyof typeof LATTICE;

/** A position or size measured in whole lattice units. */
export interface LatticeUnits {
  readonly col: number;
  readonly row: number;
}

/** A position or size measured in CSS pixels at zoom 1. */
export interface Pixels {
  readonly x: number;
  readonly y: number;
}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${what} must be a finite number, got ${String(value)}`);
  }
}

/** Number of pixels in one lattice unit on the given axis. */
export function unitSize(axis: Axis): number {
  return LATTICE[axis];
}

/** Convert a pixel measurement to (fractional) lattice units. */
export function pxToUnits(px: number, axis: Axis): number {
  assertFinite(px, 'px');
  return px / LATTICE[axis];
}

/** Convert lattice units to pixels. */
export function unitsToPx(units: number, axis: Axis): number {
  assertFinite(units, 'units');
  return units * LATTICE[axis];
}

/**
 * Snap a pixel measurement to the nearest whole lattice unit and return it in
 * pixels. Snapping never produces a negative value: the canvas extends right and
 * down only (PRD §12), so nothing can sit above or left of A1.
 */
export function snapToLattice(px: number, axis: Axis): number {
  return unitsToPx(snapToUnits(px, axis), axis);
}

/** Snap a pixel measurement to the nearest whole lattice unit and return the unit count. */
export function snapToUnits(px: number, axis: Axis): number {
  assertFinite(px, 'px');
  const units = Math.round(px / LATTICE[axis]);
  // `Math.round(-0.1)` is -0; normalise so callers never see a signed zero.
  return units <= 0 ? 0 : units;
}

/**
 * Snap a size (width or height) in pixels to whole units, with a minimum of one
 * unit so a column or row can never collapse to zero (GRID-08).
 */
export function snapSizeToUnits(px: number, axis: Axis): number {
  return Math.max(1, snapToUnits(px, axis));
}

/** Snap a pixel point to the lattice, returning whole units on both axes. */
export function snapPoint(point: Pixels): LatticeUnits {
  return { col: snapToUnits(point.x, 'col'), row: snapToUnits(point.y, 'row') };
}

/** Convert a lattice point to its top-left pixel corner. */
export function pointToPx(point: LatticeUnits): Pixels {
  return { x: unitsToPx(point.col, 'col'), y: unitsToPx(point.row, 'row') };
}
