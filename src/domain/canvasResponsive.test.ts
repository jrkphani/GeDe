import { describe, expect, it } from 'vitest'
import { labelTierForWidth } from './canvasResponsive'

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
