import { describe, expect, it } from 'vitest'

import { focusPanTarget } from './workspaceFocusPan'

// A pane pinned at the screen origin, 1000×800 — the "viewport" the focused
// element is measured against. MARGIN mirrors WorkspaceCanvas' FOCUS_PAN_MARGIN.
const pane = { top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 }
const MARGIN = 88

function box(left: number, top: number, width: number, height: number) {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

describe('focusPanTarget', () => {
  it('returns null when the element is comfortably inside the margin band', () => {
    // Centred element, well clear of every edge → the viewport must not fight
    // a typist whose caret is already in view.
    expect(focusPanTarget(box(400, 300, 200, 100), pane, MARGIN)).toBeNull()
  })

  it('pans toward an element entirely off the right edge (the off-screen-lane case)', () => {
    const target = box(1100, 300, 200, 100)
    expect(focusPanTarget(target, pane, MARGIN)).toEqual({ x: 1200, y: 350 })
  })

  it('pans toward an element off the top edge', () => {
    const target = box(400, -120, 200, 100)
    expect(focusPanTarget(target, pane, MARGIN)).toEqual({ x: 500, y: -70 })
  })

  it('pans toward an element off the bottom edge', () => {
    const target = box(400, 780, 200, 100) // bottom 880 > pane.bottom 800
    expect(focusPanTarget(target, pane, MARGIN)).toEqual({ x: 500, y: 830 })
  })

  it('pans toward an element off the left edge', () => {
    const target = box(-150, 300, 200, 100)
    expect(focusPanTarget(target, pane, MARGIN)).toEqual({ x: -50, y: 350 })
  })

  it('pans when the element intrudes into the margin band though still on-screen', () => {
    // right edge 950 > pane.right(1000) - margin(88) = 912 → within the band → pan.
    const target = box(750, 300, 200, 100)
    expect(focusPanTarget(target, pane, MARGIN)).toEqual({ x: 850, y: 350 })
  })

  // Exact-boundary cases pin each of the four clauses at `<`/`>` (not `<=`/`>=`),
  // one per edge, so a comparison-operator mutation on ANY clause is caught.
  it('does not pan for an element resting exactly on the RIGHT margin boundary', () => {
    // right edge exactly 912 (= pane.right - margin); NOT strictly past → inside.
    expect(focusPanTarget(box(712, 300, 200, 100), pane, MARGIN)).toBeNull()
  })

  it('pans when the RIGHT edge is 1px past the margin boundary', () => {
    // right edge 913 > 912 → outside → pan.
    expect(focusPanTarget(box(713, 300, 200, 100), pane, MARGIN)).toEqual({ x: 813, y: 350 })
  })

  it('does not pan for an element resting exactly on the LEFT margin boundary', () => {
    // left edge exactly 88 (= pane.left + margin); NOT strictly inside → inside.
    expect(focusPanTarget(box(88, 300, 200, 100), pane, MARGIN)).toBeNull()
  })

  it('pans when the LEFT edge is 1px past the margin boundary', () => {
    // left edge 87 < 88 → outside → pan.
    expect(focusPanTarget(box(87, 300, 200, 100), pane, MARGIN)).toEqual({ x: 187, y: 350 })
  })

  it('does not pan for an element resting exactly on the TOP margin boundary', () => {
    // top edge exactly 88 (= pane.top + margin); NOT strictly above → inside.
    expect(focusPanTarget(box(400, 88, 200, 100), pane, MARGIN)).toBeNull()
  })

  it('pans when the TOP edge is 1px past the margin boundary', () => {
    // top edge 87 < 88 → outside → pan.
    expect(focusPanTarget(box(400, 87, 200, 100), pane, MARGIN)).toEqual({ x: 500, y: 137 })
  })

  it('does not pan for an element resting exactly on the BOTTOM margin boundary', () => {
    // bottom edge exactly 712 (= pane.bottom - margin); NOT strictly past → inside.
    expect(focusPanTarget(box(400, 612, 200, 100), pane, MARGIN)).toBeNull()
  })

  it('pans when the BOTTOM edge is 1px past the margin boundary', () => {
    // bottom edge 713 > 712 → outside → pan.
    expect(focusPanTarget(box(400, 613, 200, 100), pane, MARGIN)).toEqual({ x: 500, y: 663 })
  })

  it('never pans a zero-size (detached / unmeasured) element', () => {
    expect(focusPanTarget(box(5000, 5000, 0, 0), pane, MARGIN)).toBeNull()
  })
})
