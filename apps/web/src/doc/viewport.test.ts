import { describe, expect, it } from 'vitest';
import {
  clampViewport,
  fitViewport,
  INITIAL_VIEWPORT,
  pan,
  visibleRange,
  wheelZoomFactor,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomBy,
  zoomTier,
  zoomTo,
} from './viewport.js';

describe('viewport', () => {
  it('DOC-04 pan clamps so A1 stays top-left and extends right and down without bound', () => {
    expect(pan(INITIAL_VIEWPORT, -100, -100)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(pan(INITIAL_VIEWPORT, 1e6, 1e6)).toEqual({ x: 1e6, y: 1e6, zoom: 1 });
    expect(clampViewport({ x: -1, y: 5, zoom: 0.01 })).toEqual({ x: 0, y: 5, zoom: ZOOM_MIN });
    expect(clampViewport({ x: 0, y: 0, zoom: 99 }).zoom).toBe(ZOOM_MAX);
    expect(clampViewport({ x: Number.NaN, y: 0, zoom: Number.NaN })).toEqual(INITIAL_VIEWPORT);
  });

  it('DOC-04 zoom keeps the canvas point under the cursor fixed, and clamps at A1 when it cannot', () => {
    const v = { x: 320, y: 220, zoom: 1 };
    const at = { x: 100, y: 50 };
    const next = zoomBy(v, 2, at);
    // Canvas point under the cursor before: (420, 270) at zoom 1 → after, (v.x + at.x) / zoom must match.
    expect((next.x + at.x) / next.zoom).toBeCloseTo(420);
    expect((next.y + at.y) / next.zoom).toBeCloseTo(270);
    expect(zoomTo(INITIAL_VIEWPORT, 0.5, { x: 400, y: 300 })).toEqual({ x: 0, y: 0, zoom: 0.5 });
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
  });

  it('DOC-05 semantic zoom tiers: micro ≥ 0.48, meso ≥ 0.30, macro below', () => {
    expect(zoomTier(1)).toBe('micro');
    expect(zoomTier(0.48)).toBe('micro');
    expect(zoomTier(0.4799)).toBe('meso');
    expect(zoomTier(0.3)).toBe('meso');
    expect(zoomTier(0.2999)).toBe('macro');
    expect(zoomTier(ZOOM_MIN)).toBe('macro');
  });

  it('DOC-07 fit frames the bounds with padding, never above 100 %, and returns to A1 when empty', () => {
    const size = { width: 1000, height: 600 };
    const wide = fitViewport({ x: 160, y: 22, width: 3200, height: 220 }, size, 20);
    expect(wide.zoom).toBeCloseTo(960 / 3200);
    expect(wide.x).toBeCloseTo(160 * wide.zoom - 20);
    expect(wide.y).toBeCloseTo(22 * wide.zoom - 20 < 0 ? 0 : 22 * wide.zoom - 20);
    const tiny = fitViewport({ x: 0, y: 0, width: 160, height: 66 }, size, 20);
    expect(tiny).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(fitViewport(null, size, 20)).toEqual(INITIAL_VIEWPORT);
    const tall = fitViewport({ x: 0, y: 0, width: 160, height: 22_000 }, size, 20);
    expect(tall.zoom).toBeCloseTo(Math.max(ZOOM_MIN, 560 / 22_000));
  });

  it('DOC-06 the visible lattice range tracks pan and zoom exactly', () => {
    expect(visibleRange({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 220 })).toEqual({
      colStart: 0,
      colEnd: 6,
      rowStart: 0,
      rowEnd: 11,
    });
    expect(visibleRange({ x: 480, y: 66, zoom: 1 }, { width: 800, height: 220 })).toEqual({
      colStart: 3,
      colEnd: 9,
      rowStart: 3,
      rowEnd: 14,
    });
    expect(visibleRange({ x: 0, y: 0, zoom: 0.5 }, { width: 800, height: 220 })).toEqual({
      colStart: 0,
      colEnd: 11,
      rowStart: 0,
      rowEnd: 21,
    });
  });
});
