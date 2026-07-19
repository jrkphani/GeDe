// Pure pan-decision geometry extracted from WorkspaceCanvas.onFocusCapture.
//
// The e2e that exercised "focusing an off-screen cell pans it into view" could
// not be made deterministic (issue 096): the actual pan (React Flow setCenter)
// races a one-time post-measurement fitView and no-ops under reduced motion, so
// it stayed quarantined and out of the deploy gate. The flaky part is React
// Flow's animation timing — NOT the app logic. The app-owned invariant is this
// decision: given a just-focused element and the pane, do we pan, and to what
// screen-space point? That is pure geometry, so it lives here and is unit-tested
// (workspaceFocusPan.test.ts) instead of black-box e2e'd (089-P6).

export interface RectBox {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly width: number
  readonly height: number
}

/**
 * Returns the screen-space centre of `target` when it sits within `margin` px
 * of — or past — any edge of `pane` (→ pan it into view), or null when the
 * element is already comfortably inside (→ no pan, so the viewport never fights
 * a typist whose caret is in view). A zero-size target (detached / unmeasured)
 * never pans. `margin` mirrors WorkspaceCanvas' FOCUS_PAN_MARGIN.
 */
export function focusPanTarget(
  target: RectBox,
  pane: RectBox,
  margin: number,
): { x: number; y: number } | null {
  if (target.width === 0 && target.height === 0) return null
  const outside =
    target.top < pane.top + margin ||
    target.bottom > pane.bottom - margin ||
    target.left < pane.left + margin ||
    target.right > pane.right - margin
  if (!outside) return null
  return {
    x: target.left + target.width / 2,
    y: target.top + target.height / 2,
  }
}
