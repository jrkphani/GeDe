// STYLE_GUIDE §7 canvas responsiveness table. Pulled out as a pure function
// so the tier-switch behavior is unit-testable without depending on
// ResizeObserver (jsdom's is a no-op stub, see src/test/setup.ts).
export type CanvasLabelTier = 'full' | 'truncated' | 'legend'

export function labelTierForWidth(containerWidthPx: number): CanvasLabelTier {
  if (containerWidthPx >= 640) return 'full'
  if (containerWidthPx >= 400) return 'truncated'
  return 'legend'
}
