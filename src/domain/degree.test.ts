import { describe, expect, it } from 'vitest'
import { formatDegree } from './degree'

// STYLE_GUIDE §3 — rank/degree notation is mono `1°`, `2°`… (issue 013).
describe('formatDegree', () => {
  it('renders an integer rank as degree notation', () => {
    expect(formatDegree(1)).toBe('1°')
    expect(formatDegree(2)).toBe('2°')
    expect(formatDegree(10)).toBe('10°')
  })
})
