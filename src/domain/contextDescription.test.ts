import { describe, expect, it } from 'vitest'
import { describeContext, tupleReadout } from './contextDescription'

const DIMENSIONS = [
  { id: 'd0', sort: 0 },
  { id: 'd1', sort: 1 },
  { id: 'd2', sort: 2 },
]
const PARAM_NAMES = { p0: 'Comfort', p1: 'Users', p2: 'Engagement' }

describe('tupleReadout', () => {
  it('resolves each dimension to its bound parameter name, in dimension order', () => {
    const bindings = { d0: 'p0', d1: 'p1', d2: 'p2' }
    expect(tupleReadout(DIMENSIONS, bindings, PARAM_NAMES)).toEqual(['Comfort', 'Users', 'Engagement'])
  })

  it('renders an em-dash placeholder for an unbound dimension', () => {
    const bindings = { d0: 'p0', d2: 'p2' } // d1 unbound
    expect(tupleReadout(DIMENSIONS, bindings, PARAM_NAMES)).toEqual(['Comfort', '—', 'Engagement'])
  })

  it('renders all placeholders when nothing is bound', () => {
    expect(tupleReadout(DIMENSIONS, {}, PARAM_NAMES)).toEqual(['—', '—', '—'])
  })

  it('renders a placeholder if a binding points at a parameter id with no known name', () => {
    const bindings = { d0: 'unknown-param-id' }
    expect(tupleReadout([DIMENSIONS[0] as (typeof DIMENSIONS)[number]], bindings, PARAM_NAMES)).toEqual(['—'])
  })
})

describe('describeContext', () => {
  it('formats symbol, tuple, and status into one readable a11y string', () => {
    expect(describeContext('α', ['Comfort', 'Users', 'Engagement'], 'draft')).toBe(
      'α — Comfort, Users, Engagement, draft',
    )
  })

  it('includes placeholders for unbound dimensions verbatim', () => {
    expect(describeContext('β', ['Comfort', '—', 'Engagement'], 'draft')).toBe(
      'β — Comfort, —, Engagement, draft',
    )
  })

  it('reflects the documented status', () => {
    expect(describeContext('α', ['Comfort'], 'documented')).toBe('α — Comfort, documented')
  })
})
