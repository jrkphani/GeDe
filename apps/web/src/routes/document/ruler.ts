/**
 * Ruler label density (DOC-06, issue #65). Row numbers are 9.5 px mono; once
 * the row pitch on screen drops below what a label needs, the ruler thins its
 * labels to every 2nd, 5th, 10th … row, the way spreadsheets do at macro zoom.
 * The ruler cells themselves are still drawn for every row, so the gutter
 * keeps tracking pan and zoom exactly.
 */

/** The label needs this many screen px of row pitch to read (9.5 px glyphs plus a hairline). */
export const ROW_LABEL_MIN_PX = 12;

const STEPS = [1, 2, 5, 10, 20, 50] as const;
const MAX_STEP = 100;

/** Label every `step`th row so consecutive labels are at least `ROW_LABEL_MIN_PX` apart. */
export function rowLabelStep(rowPx: number): number {
  if (!(rowPx > 0)) return MAX_STEP;
  for (const step of STEPS) {
    if (step * rowPx >= ROW_LABEL_MIN_PX) return step;
  }
  return MAX_STEP;
}

/** Is row `index0` (0-based) labelled at this step? Row 1 always is; then every multiple. */
export function rowIsLabelled(index0: number, step: number): boolean {
  if (step <= 1) return true;
  return index0 === 0 || (index0 + 1) % step === 0;
}
