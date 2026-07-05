import { describe, expect, it } from 'vitest'
import { computeRemovalImpact } from './dimensionImpact'

describe('computeRemovalImpact', () => {
  it('counts zero bindings when no context has bound the dimension', () => {
    expect(computeRemovalImpact('d1', {})).toEqual({ bindingCount: 0 })
    expect(computeRemovalImpact('d1', { ctxA: { d2: 'p1' } })).toEqual({ bindingCount: 0 })
  })

  it('counts exactly the contexts bound to the removed dimension', () => {
    const bindingsByContext = {
      ctxA: { d1: 'p1', d2: 'p2' },
      ctxB: { d1: 'p3' },
      ctxC: { d2: 'p4' },
    }
    expect(computeRemovalImpact('d1', bindingsByContext)).toEqual({ bindingCount: 2 })
    expect(computeRemovalImpact('d2', bindingsByContext)).toEqual({ bindingCount: 2 })
  })

  it('does not mutate the input', () => {
    const bindingsByContext = { ctxA: { d1: 'p1' } }
    const frozen = JSON.parse(JSON.stringify(bindingsByContext)) as typeof bindingsByContext
    computeRemovalImpact('d1', bindingsByContext)
    expect(bindingsByContext).toEqual(frozen)
  })
})
