/**
 * Viewport arithmetic (DOC-04, DOC-05, DOC-07). Pure functions over a small
 * record; the canvas component owns the record as UI state (it is not
 * document state — pan and zoom are per viewer).
 *
 * `x`/`y` are the canvas-space pixel offsets, at the current zoom, of the
 * viewport's top-left corner from A1. They are never negative: A1 stays the
 * top-left of what can be seen (PRD §12). The plane extends right and down
 * without bound.
 */
import { LATTICE, type PixelBounds } from '@gede/core';

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const ZOOM_MIN = 0.12;
export const ZOOM_MAX = 1.9;
/** One press of ⌘+ / ⌘−, from the prototype. */
export const ZOOM_STEP = 1.22;
/** The zoom pill's presets. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5] as const;
export const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** DOC-05 semantic zoom bands. */
export type ZoomTier = 'micro' | 'meso' | 'macro';
export const TIER_MICRO_MIN = 0.48;
export const TIER_MESO_MIN = 0.3;

export function zoomTier(zoom: number): ZoomTier {
  if (zoom >= TIER_MICRO_MIN) return 'micro';
  if (zoom >= TIER_MESO_MIN) return 'meso';
  return 'macro';
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** DOC-04: pan clamps so A1 remains the top-left; nothing clamps on the far side. */
export function clampViewport(v: Viewport): Viewport {
  return {
    x: Number.isFinite(v.x) ? Math.max(0, v.x) : 0,
    y: Number.isFinite(v.y) ? Math.max(0, v.y) : 0,
    zoom: clampZoom(v.zoom),
  };
}

export function pan(v: Viewport, dx: number, dy: number): Viewport {
  return clampViewport({ x: v.x + dx, y: v.y + dy, zoom: v.zoom });
}

/**
 * Zoom so the canvas point under `at` (viewport pixels) stays under the
 * pointer — ⌥scroll and pinch zoom about the cursor, the pill about the centre.
 */
export function zoomTo(v: Viewport, zoom: number, at: { x: number; y: number }): Viewport {
  const next = clampZoom(zoom);
  const ratio = next / v.zoom;
  return clampViewport({
    x: (v.x + at.x) * ratio - at.x,
    y: (v.y + at.y) * ratio - at.y,
    zoom: next,
  });
}

export function zoomBy(v: Viewport, factor: number, at: { x: number; y: number }): Viewport {
  return zoomTo(v, v.zoom * factor, at);
}

export function centre(size: Size): { x: number; y: number } {
  return { x: size.width / 2, y: size.height / 2 };
}

/** Wheel with ⌥ (or ctrl, which a trackpad pinch sends): exponential in deltaY, from the prototype. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0016);
}

/**
 * DOC-07 Fit: frame the union bounds of tables and graphs with a padding, never
 * beyond 100 % (fitting one small table should not blow it up) and never below
 * the minimum zoom. With nothing on the sheet, return to A1 at 100 %.
 */
export function fitViewport(bounds: PixelBounds | null, size: Size, padding: number): Viewport {
  if (bounds === null || size.width <= 0 || size.height <= 0) return INITIAL_VIEWPORT;
  const availW = Math.max(1, size.width - padding * 2);
  const availH = Math.max(1, size.height - padding * 2);
  const zoom = clampZoom(
    Math.min(1, availW / Math.max(1, bounds.width), availH / Math.max(1, bounds.height)),
  );
  return clampViewport({
    x: bounds.x * zoom - padding,
    y: bounds.y * zoom - padding,
    zoom,
  });
}

export interface LatticeRange {
  readonly colStart: number;
  readonly colEnd: number; // exclusive
  readonly rowStart: number;
  readonly rowEnd: number; // exclusive
}

/** The lattice columns and rows intersecting the viewport (plus one for the partial edge). */
export function visibleRange(v: Viewport, size: Size): LatticeRange {
  const colPx = LATTICE.col * v.zoom;
  const rowPx = LATTICE.row * v.zoom;
  return {
    colStart: Math.max(0, Math.floor(v.x / colPx)),
    colEnd: Math.max(0, Math.ceil((v.x + size.width) / colPx)) + 1,
    rowStart: Math.max(0, Math.floor(v.y / rowPx)),
    rowEnd: Math.max(0, Math.ceil((v.y + size.height) / rowPx)) + 1,
  };
}

/** Canvas pixel (zoom 1) under a viewport pixel. */
export function toCanvas(v: Viewport, point: { x: number; y: number }): { x: number; y: number } {
  return { x: (v.x + point.x) / v.zoom, y: (v.y + point.y) / v.zoom };
}

export function formatZoom(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`;
}

/**
 * FIND-07: pan just enough that a canvas rectangle (pixels at zoom 1) sits
 * inside the viewport with `padding` around it; a rectangle already in view
 * leaves the viewport unchanged. Zoom never changes — stepping through matches
 * moves the plane, it does not re-scale it. A rectangle wider or taller than
 * the viewport aligns its top-left edge.
 */
export function revealBounds(
  v: Viewport,
  size: Size,
  bounds: PixelBounds,
  padding: number,
): Viewport {
  if (size.width <= 0 || size.height <= 0) return v;
  const left = bounds.x * v.zoom - padding;
  const top = bounds.y * v.zoom - padding;
  const right = (bounds.x + bounds.width) * v.zoom + padding;
  const bottom = (bounds.y + bounds.height) * v.zoom + padding;
  let x = v.x;
  let y = v.y;
  if (left < v.x || right - left > size.width) x = left;
  else if (right > v.x + size.width) x = right - size.width;
  if (top < v.y || bottom - top > size.height) y = top;
  else if (bottom > v.y + size.height) y = bottom - size.height;
  return clampViewport({ x, y, zoom: v.zoom });
}
