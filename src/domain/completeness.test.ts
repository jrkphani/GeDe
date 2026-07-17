import { describe, expect, it } from 'vitest'
import { documentedStatus, isComplete } from './completeness'
import { plainTextToRichJson } from './richText'

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

  // Issue 089 D1 Phase 2 — once justification can hold Lexical JSON, an EMPTY
  // rich doc is ALWAYS a non-empty string (`{"root":...}`), so a naive
  // `.trim() !== ''` would wrongly read it as documented (a status-dot
  // regression, STYLE_GUIDE §9). documentedStatus must read the PROSE, not the
  // JSON envelope.
  it('is complete (not documented) when the justification is an EMPTY rich doc', () => {
    const emptyRichDoc = plainTextToRichJson('')
    expect(emptyRichDoc.trim()).not.toBe('') // the trap: the envelope is non-empty
    expect(documentedStatus(true, emptyRichDoc)).toBe('complete')
  })

  it('is documented when the justification is a NON-empty rich doc', () => {
    expect(documentedStatus(true, plainTextToRichJson('Reflects the primary beneficiaries'))).toBe(
      'documented',
    )
  })
})
