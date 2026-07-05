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
