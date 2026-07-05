import { describe, expect, it } from 'vitest'
import { dotHitRadiusUnits, labelTierForWidth, MIN_HIT_TARGET_PX } from './canvasResponsive'

describe('labelTierForWidth', () => {
  it('is "full" at and above 640px', () => {
    expect(labelTierForWidth(640)).toBe('full')
    expect(labelTierForWidth(1200)).toBe('full')
  })

  it('is "truncated" from 400px up to (not including) 640px', () => {
    expect(labelTierForWidth(639)).toBe('truncated')
    expect(labelTierForWidth(400)).toBe('truncated')
  })

  it('is "legend" below 400px', () => {
    expect(labelTierForWidth(399)).toBe('legend')
    expect(labelTierForWidth(0)).toBe('legend')
  })
})

describe('dotHitRadiusUnits', () => {
  it('scales the 44px touch target into viewBox units for the measured canvas width', () => {
    // 1000-unit square rendered at 500px => 1px = 2 units => 44px diameter is
    // a 22px radius = 44 units.
    expect(dotHitRadiusUnits(500)).toBe(44)
    // Rendered 1:1 at 1000px, the 22px radius maps straight through.
    expect(dotHitRadiusUnits(1000)).toBe(22)
  })

  it('grows the hit radius as the canvas shrinks, keeping the on-screen target constant', () => {
    expect(dotHitRadiusUnits(250)).toBeGreaterThan(dotHitRadiusUnits(500))
    // The target diameter always maps back to at least 44px on screen.
    const widthPx = 320
    const radiusUnits = dotHitRadiusUnits(widthPx)
    const diameterPx = radiusUnits * 2 * (widthPx / 1000)
    expect(diameterPx).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PX)
  })
})
