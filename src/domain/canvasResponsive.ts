// STYLE_GUIDE §7 canvas responsiveness table. Pulled out as a pure function
// so the tier-switch behavior is unit-testable without depending on
// ResizeObserver (jsdom's is a no-op stub, see src/test/setup.ts).
export type CanvasLabelTier = 'full' | 'truncated' | 'legend'

export function labelTierForWidth(containerWidthPx: number): CanvasLabelTier {
  if (containerWidthPx >= 640) return 'full'
  if (containerWidthPx >= 400) return 'truncated'
  return 'legend'
}

// STYLE_GUIDE §7 — "every dot/node carries an invisible ≥ 44px hit circle
// regardless of visual radius." The canvas geometry is a scale-free 1000-unit
// square (canvasLayout), rendered into `canvasWidthPx` on screen, so one CSS
// pixel is `1000 / canvasWidthPx` viewBox units. Sizing the invisible hit
// circle from the *measured* width is the only honest way to guarantee a real
// 44px target at any zoom — a fixed viewBox radius would drift with scale.
export const MIN_HIT_TARGET_PX = 44
const VIEWBOX_SIZE = 1000

export function dotHitRadiusUnits(canvasWidthPx: number): number {
  return (MIN_HIT_TARGET_PX / 2) * (VIEWBOX_SIZE / canvasWidthPx)
}

// 099-2c — `dotHitRadiusUnits` needs the ON-SCREEN width, but its caller measures
// a ResizeObserver `contentRect`, which is LAYOUT width and therefore INVARIANT
// under the React Flow canvas's `transform: scale()`. Screen width is
// `layoutWidth * zoom`, so at zoom 0.5 the real target was ~22px (WCAG 2.5.5).
//
// Compensating naively is HARMFUL, though: the hit circle is `fill: transparent`
// = PAINTED, so SVG `visiblePainted` hit-tests it. It therefore also swallows
// background clicks (Canvas.tsx's `e.target === e.currentTarget` deselect) and
// drives hover emphasis. Full compensation at RF's minZoom of 0.2 would mean a
// 5x radius / 25x area — and `maxDotHitRadius` CANNOT contain it, because on a
// ring where no dimension has two dots that cap opens to ARC_RADIUS
// (canvasLayout.ts:455). A third of the canvas would go dead to deselect.
//
// So the compensation is clamped: honor the 44px target down to MIN_HIT_SCALE
// and no further. This exactly fixes the reported zoom-0.5 case and makes the
// degenerate zoom cases finite by construction (the divisor can never reach 0).
// Below MIN_HIT_SCALE the target shrinks with the zoom — the honest tradeoff for
// a user who has zoomed out to see more.
//
// This clamp is NOT the containment guarantee, though, and must not be mistaken
// for one: it bounds the radius at `2 * 22000/W`, which is a function of the
// LAYOUT WIDTH, and W is itself variable — the ring shell is
// `min(480px, 60vh, 100%)` (base.css), so a short viewport shrinks it well below
// 480 and the bound rises with it. Containment is `maxDotHitRadius`'s job, which
// 099-2c made a true all-pairs minimum precisely so it can carry that weight
// (see canvasLayout.ts). The two terms are complementary, not redundant.
export const MIN_HIT_SCALE = 0.5

// Quantized so the ring re-renders only when a BUCKET is crossed, never per zoom
// frame (the established RF-selector pattern — see DesignCoreAdapter's LOD
// boolean). Flooring is deliberate: underestimating the zoom OVERestimates the
// radius, so the target errs larger, never below 44px.
const HIT_SCALE_STEP = 0.25

export function quantizeHitScale(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.max(MIN_HIT_SCALE, Math.floor(zoom / HIT_SCALE_STEP) * HIT_SCALE_STEP)
}

interface HitRadiusInput {
  // ResizeObserver `contentRect` width — LAYOUT px, zoom-invariant.
  layoutWidthPx: number
  // Quantized viewport scale; 1 on the non-transformed fallback surface.
  scale: number
  // Per-layout no-overlap cap (canvasLayout.ts) — neighboring hit circles must
  // never overlap and steal each other's clicks (issue 082 Phase 1 regression).
  maxDotHitRadius: number
}

export function hitRadiusUnits({ layoutWidthPx, scale, maxDotHitRadius }: HitRadiusInput): number {
  const effectiveScale = Number.isFinite(scale) ? Math.max(scale, MIN_HIT_SCALE) : 1
  return Math.min(dotHitRadiusUnits(layoutWidthPx * effectiveScale), maxDotHitRadius)
}
