import { below } from '@gede/tokens';
import { useMediaQuery } from './use-media-query.js';

/**
 * The phone predicate (RESP-02, ADR-039). Phone means a narrow viewport on a
 * device without a fine pointer: under `md` (768 CSS px) AND the primary
 * pointer is coarse or hover is unavailable. A fine-pointer desktop whose CSS
 * viewport is under 768 px — a 1440 px display at 200 % browser zoom is
 * 720 px — keeps the tablet chrome and stays editable (A11Y-06 / WCAG 1.4.4
 * "no loss of functionality" wins over the width heuristic; #137).
 *
 * Composed in JS from three queries rather than one Level 4 `or` expression,
 * so a browser that cannot parse `((pointer: coarse) or (hover: none))` does
 * not silently answer `false` and drop the phone contract.
 */
export const PHONE_QUERIES = {
  narrow: below('md'),
  coarse: '(pointer: coarse)',
  noHover: '(hover: none)',
} as const;

export interface PointerEnvironment {
  narrow: boolean;
  coarse: boolean;
  noHover: boolean;
}

/** Pure form of the predicate, for tests and for callers outside React. */
export function isPhone({ narrow, coarse, noHover }: PointerEnvironment): boolean {
  return narrow && (coarse || noHover);
}

/** The environment as `window.matchMedia` reports it. */
export function readPointerEnvironment(): PointerEnvironment {
  return {
    narrow: window.matchMedia(PHONE_QUERIES.narrow).matches,
    coarse: window.matchMedia(PHONE_QUERIES.coarse).matches,
    noHover: window.matchMedia(PHONE_QUERIES.noHover).matches,
  };
}

/** React state: true while the window is a phone in the sense above. */
export function usePhone(): boolean {
  const narrow = useMediaQuery(PHONE_QUERIES.narrow);
  const coarse = useMediaQuery(PHONE_QUERIES.coarse);
  const noHover = useMediaQuery(PHONE_QUERIES.noHover);
  return isPhone({ narrow, coarse, noHover });
}
