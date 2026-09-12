/**
 * A11Y-03 on fills: which text colour tokens fall under 4.5:1 on which fill
 * tints, in either theme. The table is measured from `packages/tokens` by
 * `apps/web/src/routes/document/inspector/contrast.test.ts`, which fails if
 * this list drifts from the tokens; the renderer and the inspector consult it
 * so a fill never leaves body text unreadable — the ink is auto-adjusted to
 * `ink` and the control says so.
 */
import type { HighlightToken, TextColourToken } from '../text/types.js';

export const UNSAFE_TEXT_ON_FILL: Readonly<Record<HighlightToken, readonly TextColourToken[]>> = {
  amber: ['live', 'warning'],
  forest: ['live', 'warning', 'ink-muted'],
  slate: ['live', 'warning'],
};

/** The text colour that renders on `fill`: the one asked for, or `ink` when the pair is under 4.5:1. */
export function readableTextColour(
  fill: HighlightToken | undefined,
  colour: TextColourToken | undefined,
): TextColourToken | undefined {
  if (fill === undefined || colour === undefined) return colour;
  return UNSAFE_TEXT_ON_FILL[fill].includes(colour) ? 'ink' : colour;
}
