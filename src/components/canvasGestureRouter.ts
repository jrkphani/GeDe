import type { Viewport } from '@xyflow/react'

// Confirmed against @xyflow/react 12.11.2 / d3-zoom source (not re-derived here):
// React Flow's own `noWheelClassName`/`noPanClassName` filters are pure DOM-class
// ancestry checks with no modifier-key awareness — `nowheel` blocks EVERY wheel
// event under it, including Cmd/Ctrl+wheel and macOS trackpad pinch (which arrives
// as a `wheel` event with `ctrlKey: true` and no real Control keypress); `nopan`
// blocks genuine two-finger touchscreen pinch the same way, because pan-drag and
// pinch share the same `touchstart` entry point in d3-zoom. Zoom buttons and
// keyboard shortcuts bypass this filter entirely (they call `scaleBy`/`setViewport`
// imperatively), which is why zoom "sometimes works" and users report it broken
// specifically over the tables.
//
// This module is the single router that replaces the per-node nowheel/nopan class
// special-casing. It runs as ONE capture-phase listener pair on `.workspace-canvas`
// — upstream of React Flow's own bubble-phase pane listeners, so it always sees a
// gesture first — and classifies every wheel/touchstart into a pass-through-as-is
// decision or an owned gesture:
//   • Cmd/Ctrl+wheel or trackpad-pinch-wheel (ctrlKey/metaKey set) — untouched
//     pass-through. `noWheelClassName` below points at a class nothing ever
//     carries, so React Flow's own (unblocked) wheel handling zooms exactly as it
//     already does over open canvas — no reimplementation, so the feel is
//     identical by construction.
//   • Plain wheel over a `[data-gesture-scroll]` node body that has real overflow
//     left in the wheel's direction — owned: scroll that element's own content and
//     stop the event there. No overflow left (or nothing to scroll) — untouched
//     pass-through, which now pans (see noWheelClassName above) instead of the old
//     wheel-over-a-table dead zone.
//   • touchstart with 2+ touches (real pinch, anywhere — including over a table) —
//     owned: React Flow's `noPanClassName` stays pointed at the real
//     `wc-node__body` class (unchanged single-touch protection — a one-finger drag
//     starting inside a table must still not also pan the canvas, and that was
//     never the bug), so a genuine pinch must be driven here, before the pane's
//     nopan-gated touch handling ever sees it. The math below mirrors d3-zoom's own
//     touch-pinch formula (`zoom' = zoom * distance' / distance`, anchored so the
//     midpoint's world position stays under the fingers) so the feel matches.
//   • Everything else (clicks, focus, keyboard nav, a pointerdown on
//     `.wc-node__handle`) is never touched — cell-edit and the existing
//     mouse/touch header drag-to-reorder paths are untouched by this router.

const NOTHING_TO_SCROLL_EPSILON = 1

function isScrollableY(el: HTMLElement): boolean {
  if (el.scrollHeight - el.clientHeight <= NOTHING_TO_SCROLL_EPSILON) return false
  const { overflowY } = getComputedStyle(el)
  return overflowY === 'auto' || overflowY === 'scroll'
}

// Walk from the wheel target up to (and including) its nearest
// `[data-gesture-scroll]` boundary, looking for the first element that actually
// has room to scroll. Runtime overflow detection (rather than hardcoding which
// node types "are tables") means a body with nothing to scroll simply falls
// through to canvas-pan — no new dead zone, no per-node-type special-casing.
function findWheelScrollTarget(target: HTMLElement, boundary: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = target
  while (el) {
    if (isScrollableY(el)) return el
    if (el === boundary) return null
    el = el.parentElement
  }
  return null
}

function handleWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) return
  if (event.deltaY === 0) return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const boundary = target.closest<HTMLElement>('[data-gesture-scroll]')
  if (!boundary) return
  const scrollable = findWheelScrollTarget(target, boundary)
  if (!scrollable) return
  const atTop = scrollable.scrollTop <= 0
  const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - NOTHING_TO_SCROLL_EPSILON
  if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) return
  event.preventDefault()
  event.stopPropagation()
  scrollable.scrollTop += event.deltaY
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// The minimal slice of `useReactFlow()` the pinch driver needs, typed loosely so
// this module doesn't need the full generic `ReactFlowInstance<...>` node type.
export interface CanvasViewportController {
  getViewport: () => Viewport
  setViewport: (viewport: Viewport, options?: { duration?: number }) => unknown
}

interface ActivePinch {
  cleanup: () => void
}

// Drives the pinch itself (rather than merely unblocking React Flow's own
// touch-zoom) because React Flow's touch pan/zoom entry point is gated by the
// SAME `noPanClassName` filter that must stay real to protect a one-finger drag
// inside a table (see the module comment) — this gesture is intercepted before
// that filter ever runs, so it has to finish the job itself.
function beginPinch(
  wrapper: HTMLElement,
  viewportController: CanvasViewportController,
  zoomBounds: { min: number; max: number },
  touch0: Touch,
  touch1: Touch,
  onEnd: () => void,
): ActivePinch {
  const rect = wrapper.getBoundingClientRect()
  const startViewport = viewportController.getViewport()
  const ids = [touch0.identifier, touch1.identifier]

  const toLocal = (t: Touch): { x: number; y: number } => ({
    x: t.clientX - rect.left,
    y: t.clientY - rect.top,
  })
  const toWorld = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: (p.x - startViewport.x) / startViewport.zoom,
    y: (p.y - startViewport.y) / startViewport.zoom,
  })

  const p0 = toLocal(touch0)
  const p1 = toLocal(touch1)
  const world0 = toWorld(p0)
  const world1 = toWorld(p1)
  const worldMidX = (world0.x + world1.x) / 2
  const worldMidY = (world0.y + world1.y) / 2
  const initialDist = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1

  function activeTouches(event: TouchEvent): Touch[] {
    return Array.from(event.touches).filter((t) => ids.includes(t.identifier))
  }

  function onTouchMove(event: TouchEvent): void {
    const touches = activeTouches(event)
    const [a, b] = touches
    if (!a || !b) return
    event.preventDefault()
    const pa = toLocal(a)
    const pb = toLocal(b)
    const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1
    // d3-zoom's own touch-pinch formula: new (absolute) zoom is the starting zoom
    // scaled by how much the finger-to-finger distance has changed since gesture
    // start, then the transform is translated so the FIXED world midpoint (the
    // point under the fingers when the gesture began) stays pinned under the
    // fingers' current midpoint — not re-sampled every move, exactly like d3-zoom.
    const zoom = clamp(startViewport.zoom * (dist / initialDist), zoomBounds.min, zoomBounds.max)
    const midX = (pa.x + pb.x) / 2
    const midY = (pa.y + pb.y) / 2
    void viewportController.setViewport(
      { x: midX - worldMidX * zoom, y: midY - worldMidY * zoom, zoom },
      { duration: 0 },
    )
  }

  function onTouchEnd(event: TouchEvent): void {
    if (activeTouches(event).length >= 2) return
    teardown()
  }

  function teardown(): void {
    window.removeEventListener('touchmove', onTouchMove, true)
    window.removeEventListener('touchend', onTouchEnd, true)
    window.removeEventListener('touchcancel', onTouchEnd, true)
    onEnd()
  }

  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  window.addEventListener('touchend', onTouchEnd, { capture: true })
  window.addEventListener('touchcancel', onTouchEnd, { capture: true })

  return { cleanup: teardown }
}

// Attaches the router to `.workspace-canvas` and returns a cleanup function for
// the owning effect. Capture phase is load-bearing: it guarantees this listener
// sees the event before it reaches React Flow's own pane listeners (bound in
// bubble phase directly on the pane element), regardless of mount order.
export function attachCanvasGestureRouter(
  wrapper: HTMLElement,
  viewportController: CanvasViewportController,
  zoomBounds: { min: number; max: number },
): () => void {
  let activePinch: ActivePinch | null = null

  function onWheel(event: WheelEvent): void {
    handleWheel(event)
  }

  function onTouchStart(event: TouchEvent): void {
    if (event.touches.length < 2) return
    // A real pinch (or native browser pinch-to-zoom-the-page) must never reach
    // anything downstream — the pane's own nopan-gated touch handling, a header's
    // single-touch reorder tracker, or the OS page zoom.
    event.preventDefault()
    event.stopPropagation()
    if (activePinch) return // a third finger joining an active pinch changes nothing
    const [touch0, touch1] = event.touches
    if (!touch0 || !touch1) return
    activePinch = beginPinch(wrapper, viewportController, zoomBounds, touch0, touch1, () => {
      activePinch = null
    })
  }

  wrapper.addEventListener('wheel', onWheel, { capture: true, passive: false })
  wrapper.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })

  return () => {
    wrapper.removeEventListener('wheel', onWheel, true)
    wrapper.removeEventListener('touchstart', onTouchStart, true)
    activePinch?.cleanup()
    activePinch = null
  }
}
