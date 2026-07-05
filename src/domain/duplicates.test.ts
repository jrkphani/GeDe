import { describe, expect, it } from 'vitest'
import { findDuplicateContextIds, tupleKeyFor } from './duplicates'

describe('tupleKeyFor', () => {
  it('is null when nothing is bound', () => {
    expect(tupleKeyFor(['d1', 'd2'], {})).toBeNull()
  })

  it('orders by dimension sort order, not binding insertion order', () => {
    expect(tupleKeyFor(['d1', 'd2'], { d2: 'p2', d1: 'p1' })).toBe(
      tupleKeyFor(['d1', 'd2'], { d1: 'p1', d2: 'p2' }),
    )
  })

  it('ignores bindings for dimensions outside the given set', () => {
    expect(tupleKeyFor(['d1'], { d1: 'p1', d9: 'p9' })).toBe('p1')
  })

  it('differs when only a partial subset of dimensions is bound', () => {
    expect(tupleKeyFor(['d1', 'd2'], { d1: 'p1' })).not.toBe(tupleKeyFor(['d1', 'd2'], { d1: 'p1', d2: 'p2' }))
  })
})

describe('findDuplicateContextIds', () => {
  it('returns nothing when every tuple is unique', () => {
    expect(findDuplicateContextIds(['d1'], { a: { d1: 'p1' }, b: { d1: 'p2' } })).toEqual({})
  })

  it('groups contexts that share the same ordered tuple', () => {
    const result = findDuplicateContextIds(['d1', 'd2'], {
      a: { d1: 'p1', d2: 'p2' },
      b: { d1: 'p1', d2: 'p2' },
      c: { d1: 'p9', d2: 'p2' },
    })
    expect(result).toEqual({ a: ['b'], b: ['a'] })
  })

  it('never flags two unbound contexts against each other', () => {
    expect(findDuplicateContextIds(['d1'], { a: {}, b: {} })).toEqual({})
  })

  it('lists every sibling when three or more contexts share a tuple', () => {
    const result = findDuplicateContextIds(['d1'], {
      a: { d1: 'p1' },
      b: { d1: 'p1' },
      c: { d1: 'p1' },
    })
    expect(result.a?.slice().sort()).toEqual(['b', 'c'])
    expect(result.b?.slice().sort()).toEqual(['a', 'c'])
    expect(result.c?.slice().sort()).toEqual(['a', 'b'])
  })
})
