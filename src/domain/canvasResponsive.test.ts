import { describe, expect, it } from 'vitest'
import {
  dotHitRadiusUnits,
  hitRadiusUnits,
  labelTierForWidth,
  MIN_HIT_SCALE,
  MIN_HIT_TARGET_PX,
  quantizeHitScale,
} from './canvasResponsive'

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

// 099-2c — the hit radius must be sized from SCREEN space (layout width x zoom),
// not the zoom-invariant layout width the ResizeObserver reports.
describe('hitRadiusUnits', () => {
  const OPEN_CAP = 400 // canvasLayout's sparse-ring cap (ARC_RADIUS) — effectively open

  it('compensates for canvas zoom, so the on-screen target stays 44px', () => {
    // The reported bug: at zoom 0.5 an 800px-layout ring rendered a 27.5-unit
    // radius = a ~22px target. Screen width is 400px, so it must be 55.
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 0.5, maxDotHitRadius: OPEN_CAP })).toBe(55)
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 1, maxDotHitRadius: OPEN_CAP })).toBe(27.5)
    // Zoomed IN, 44px is met by a SMALLER unit radius — also correct.
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 2, maxDotHitRadius: OPEN_CAP })).toBe(13.75)
  })

  it('still honors the per-layout no-overlap cap', () => {
    // A crowded ring: the cap binds and neighboring circles stay disjoint.
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 0.5, maxDotHitRadius: 40 })).toBe(40)
  })

  it('clamps the compensation at MIN_HIT_SCALE so the circle never eats the canvas', () => {
    // The hit circle is painted, so it also swallows background-deselect clicks
    // and drives hover. Below MIN_HIT_SCALE the radius must STOP growing —
    // capped at 2x the zoom-1 radius even at RF's minZoom of 0.2.
    // 800px layout at the 0.5 floor = 400px on screen -> 22 * 1000/400 = 55.
    // Stated as a LITERAL: recomputing it from the implementation would pass at
    // any MIN_HIT_SCALE and prove nothing.
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: MIN_HIT_SCALE, maxDotHitRadius: OPEN_CAP })).toBe(55)
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 0.2, maxDotHitRadius: OPEN_CAP })).toBe(55)
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 0.01, maxDotHitRadius: OPEN_CAP })).toBe(55)
    // ...which is exactly 2x the zoom-1 radius, and no more.
    expect(hitRadiusUnits({ layoutWidthPx: 800, scale: 1, maxDotHitRadius: OPEN_CAP })).toBe(27.5)
  })

  it('never returns a non-finite radius for a degenerate scale', () => {
    // scale 0 would divide by zero without the MIN_HIT_SCALE floor.
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = hitRadiusUnits({ layoutWidthPx: 800, scale, maxDotHitRadius: OPEN_CAP })
      expect(Number.isFinite(r)).toBe(true)
      expect(r).toBeGreaterThan(0)
    }
  })
})

describe('quantizeHitScale', () => {
  it('floors to a bucket so the ring re-renders only on bucket crossings', () => {
    expect(quantizeHitScale(1)).toBe(1)
    expect(quantizeHitScale(1.24)).toBe(1)
    expect(quantizeHitScale(1.25)).toBe(1.25)
  })

  it('never returns 0 across the full RF zoom range (minZoom 0.2 - maxZoom 2)', () => {
    // A 0 bucket would make dotHitRadiusUnits divide by zero.
    for (let z = 0.2; z <= 2.0001; z += 0.01) {
      const q = quantizeHitScale(z)
      expect(q).toBeGreaterThanOrEqual(MIN_HIT_SCALE)
      expect(q).toBeLessThanOrEqual(z > MIN_HIT_SCALE ? z : MIN_HIT_SCALE)
    }
  })

  it('is monotonic across the whole range, and finite-safe', () => {
    // Monotonicity means every step, not one sampled pair.
    let prev = quantizeHitScale(0.2)
    for (let z = 0.21; z <= 2.0001; z += 0.01) {
      const q = quantizeHitScale(z)
      expect(q).toBeGreaterThanOrEqual(prev)
      prev = q
    }
    expect(quantizeHitScale(Number.NaN)).toBe(1)
    expect(quantizeHitScale(Number.POSITIVE_INFINITY)).toBe(1)
  })
})
