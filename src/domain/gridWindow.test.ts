import { describe, expect, it } from 'vitest'
import { windowRange } from './gridWindow'

describe('windowRange (issue 012 virtualization)', () => {
  it('at the top, renders the first viewport of cells plus trailing overscan', () => {
    // 240px viewport / 24px cells = 10 visible; +4 overscan below; none above.
    expect(windowRange(0, 240, 24, 100, 4)).toEqual({ start: 0, end: 14 })
  })

  it('scrolled into the middle, brackets the visible band with overscan both sides', () => {
    // scroll 480 → first visible index 20; window [20-4, (480+240)/24 + 4] = [16, 34]
    expect(windowRange(480, 240, 24, 100, 4)).toEqual({ start: 16, end: 34 })
  })

  it('clamps to [0, count] at both ends', () => {
    expect(windowRange(-50, 240, 24, 100, 4)).toEqual({ start: 0, end: 14 })
    // near the bottom: end never exceeds count
    expect(windowRange(24 * 100, 240, 24, 100, 4).end).toBe(100)
  })

  it('degenerate inputs yield an empty range', () => {
    expect(windowRange(0, 240, 24, 0)).toEqual({ start: 0, end: 0 })
    expect(windowRange(0, 240, 0, 100)).toEqual({ start: 0, end: 0 })
  })

  it('renders only a viewport-sized slice of a 10,000-cell axis', () => {
    const { start, end } = windowRange(24 * 5000, 600, 24, 10000, 4)
    expect(end - start).toBeLessThan(60) // ~25 visible + overscan, never all 10k
  })
})
