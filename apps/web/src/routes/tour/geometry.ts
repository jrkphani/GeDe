/**
 * Coachmark geometry (ONB-04, ONB-06, ONB-09), pure so it can be tested
 * without a DOM. Numbers are the prototype's (`PROTOTYPE-CHANGES` §1.5–1.6):
 * the spotlight sits 5 px outside the target's live box; the card is 286 px
 * wide, 14 px below the target, clamped 12 px from either viewport edge, and
 * flips above when the room below is short; with no target it centres.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How far the spotlight ring sits outside the target. */
export const SPOTLIGHT_INSET = 5;
/** Coachmark width, fixed. */
export const CARD_WIDTH = 286;
/** Gap between the target and the card. */
export const CARD_GAP = 14;
/** Minimum distance from either viewport edge. */
export const CARD_MARGIN = 12;
/** The card's height before it has been measured (the prototype's estimate). */
export const CARD_HEIGHT_ESTIMATE = 212;

export type CardPlacement = 'below' | 'above' | 'centre';

export interface CardPosition {
  readonly placement: CardPlacement;
  readonly left: number;
  readonly top: number;
}

/** The spotlight ring's box for a target, or null when the step has none. */
export function spotlightRect(target: Rect | null): Rect | null {
  if (target === null) return null;
  return {
    x: target.x - SPOTLIGHT_INSET,
    y: target.y - SPOTLIGHT_INSET,
    width: target.width + SPOTLIGHT_INSET * 2,
    height: target.height + SPOTLIGHT_INSET * 2,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where the card goes. Below the target when its measured height (plus the
 * gap) fits between the target and the bottom edge, otherwise above it
 * (ONB-09 "flip above when there is insufficient room below"), never off the
 * top. Without a target the card centres in the viewport (ONB-06).
 */
export function placeCard(
  target: Rect | null,
  viewport: Size,
  card: Size = { width: CARD_WIDTH, height: CARD_HEIGHT_ESTIMATE },
): CardPosition {
  if (target === null) {
    return {
      placement: 'centre',
      left: Math.max(CARD_MARGIN, (viewport.width - card.width) / 2),
      top: Math.max(CARD_MARGIN, (viewport.height - card.height) / 2),
    };
  }
  const left = clamp(target.x, CARD_MARGIN, viewport.width - card.width - CARD_MARGIN);
  const bottom = target.y + target.height;
  const fitsBelow = bottom + CARD_GAP + card.height + CARD_MARGIN <= viewport.height;
  if (fitsBelow) return { placement: 'below', left, top: bottom + CARD_GAP };
  return {
    placement: 'above',
    left,
    top: Math.max(CARD_MARGIN, target.y - CARD_GAP - card.height),
  };
}

/** Whether two boxes are the same to the pixel, so a re-measure that moved nothing re-renders nothing. */
export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** A DOMRect-like box rounded to whole pixels; a collapsed box (nothing painted) is null. */
export function roundedRect(box: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): Rect | null {
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}
