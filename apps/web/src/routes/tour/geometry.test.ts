import { describe, expect, test } from 'vitest';

import {
  CARD_GAP,
  CARD_HEIGHT_ESTIMATE,
  CARD_MARGIN,
  CARD_WIDTH,
  placeCard,
  roundedRect,
  sameRect,
  SPOTLIGHT_INSET,
  spotlightRect,
} from './geometry.js';

const viewport = { width: 1024, height: 900 };

describe('tour geometry', () => {
  test('ONB-04 the spotlight sits 5 px outside the target on every side; no target, no spotlight', () => {
    expect(spotlightRect({ x: 100, y: 200, width: 300, height: 42 })).toEqual({
      x: 100 - SPOTLIGHT_INSET,
      y: 200 - SPOTLIGHT_INSET,
      width: 300 + SPOTLIGHT_INSET * 2,
      height: 42 + SPOTLIGHT_INSET * 2,
    });
    expect(spotlightRect(null)).toBeNull();
  });

  test('ONB-09 the card sits 14 px below its target, aligned to its left edge', () => {
    const target = { x: 300, y: 200, width: 400, height: 42 };
    expect(placeCard(target, viewport)).toEqual({
      placement: 'below',
      left: 300,
      top: 200 + 42 + CARD_GAP,
    });
  });

  test('ONB-09 the card flips above when there is not enough room below, using its measured height', () => {
    const target = { x: 300, y: 800, width: 400, height: 42 };
    const above = placeCard(target, viewport);
    expect(above.placement).toBe('above');
    expect(above.top).toBe(800 - CARD_GAP - CARD_HEIGHT_ESTIMATE);
    // A shorter card fits below the same target (842 + 14 + 30 + 12 ≤ 900).
    expect(placeCard(target, viewport, { width: CARD_WIDTH, height: 30 }).placement).toBe('below');
    // Never off the top of the viewport.
    expect(placeCard({ x: 0, y: 30, width: 10, height: 10 }, { width: 400, height: 60 }).top).toBe(
      CARD_MARGIN,
    );
  });

  test('ONB-09 the card is clamped 12 px inside either viewport edge', () => {
    const right = placeCard({ x: 1000, y: 100, width: 20, height: 20 }, viewport);
    expect(right.left).toBe(viewport.width - CARD_WIDTH - CARD_MARGIN);
    const left = placeCard({ x: 2, y: 100, width: 20, height: 20 }, viewport);
    expect(left.left).toBe(CARD_MARGIN);
  });

  test('ONB-06 with no target the card centres in the viewport', () => {
    const centred = placeCard(null, viewport, { width: CARD_WIDTH, height: 200 });
    expect(centred).toEqual({
      placement: 'centre',
      left: (viewport.width - CARD_WIDTH) / 2,
      top: (viewport.height - 200) / 2,
    });
  });

  test('ONB-04 a re-measure that moved nothing compares equal; a collapsed box is no target', () => {
    const a = { x: 1, y: 2, width: 3, height: 4 };
    expect(sameRect(a, { ...a })).toBe(true);
    expect(sameRect(a, { ...a, x: 2 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(a, null)).toBe(false);
    expect(roundedRect({ left: 1.4, top: 2.6, width: 10.5, height: 20.4 })).toEqual({
      x: 1,
      y: 3,
      width: 11,
      height: 20,
    });
    expect(roundedRect({ left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  });
});
