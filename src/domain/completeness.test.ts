import { describe, expect, it } from 'vitest'
import { documentedStatus, isComplete } from './completeness'

describe('isComplete', () => {
  it('is false when no dimensions are bound', () => {
    expect(isComplete(['d1', 'd2'], new Set())).toBe(false)
  })

  it('is false when only some dimensions are bound', () => {
    expect(isComplete(['d1', 'd2'], new Set(['d1']))).toBe(false)
  })

  it('is true exactly when every dimension is bound', () => {
    expect(isComplete(['d1', 'd2'], new Set(['d1', 'd2']))).toBe(true)
  })

  it('ignores extra bound entries that are not on this canvas', () => {
    expect(isComplete(['d1'], new Set(['d1', 'd9']))).toBe(true)
  })

  it('is false for a canvas with no dimensions (vacuous truth guarded)', () => {
    expect(isComplete([], new Set())).toBe(false)
  })
})

describe('documentedStatus', () => {
  it('is draft when incomplete, regardless of justification', () => {
    expect(documentedStatus(false, 'a reason')).toBe('draft')
    expect(documentedStatus(false, '')).toBe('draft')
  })

  it('is complete (unjustified) when complete but justification is empty or whitespace', () => {
    expect(documentedStatus(true, '')).toBe('complete')
    expect(documentedStatus(true, '   ')).toBe('complete')
    expect(documentedStatus(true, null)).toBe('complete')
    expect(documentedStatus(true, undefined)).toBe('complete')
  })

  it('is documented when complete and justified', () => {
    expect(documentedStatus(true, 'Reflects the primary beneficiaries')).toBe('documented')
  })
})
