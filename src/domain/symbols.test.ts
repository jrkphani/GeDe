import { describe, expect, it } from 'vitest'
import { computeTupleHash, GREEK_CYCLE, nextChildSymbol, nextRootSymbol } from './symbols'

describe('nextRootSymbol', () => {
  it('cycles α β γ… in order for a fresh set', () => {
    const taken = new Set<string>()
    const symbols: string[] = []
    for (let i = 0; i < 4; i++) {
      const s = nextRootSymbol(taken)
      taken.add(s)
      symbols.push(s)
    }
    expect(symbols).toEqual(['α', 'β', 'γ', 'δ'])
  })

  it('skips symbols already taken by a live sibling (deletion gap)', () => {
    const taken = new Set(['α', 'γ'])
    expect(nextRootSymbol(taken)).toBe('β')
  })

  it('wraps with a prime suffix once the base cycle is exhausted', () => {
    const taken = new Set(GREEK_CYCLE)
    expect(nextRootSymbol(taken)).toBe('α′')
  })
})

describe('nextChildSymbol', () => {
  it('assigns parent-symbol + index, starting at 1', () => {
    const taken = new Set<string>()
    expect(nextChildSymbol('α', taken)).toBe('α1')
  })

  it('skips indices already taken by a live sibling', () => {
    const taken = new Set(['α1', 'α3'])
    expect(nextChildSymbol('α', taken)).toBe('α2')
  })

  it('is scoped to its own parent symbol', () => {
    const taken = new Set(['α1', 'β1'])
    expect(nextChildSymbol('β', taken)).toBe('β2')
  })
})

describe('computeTupleHash', () => {
  it('is deterministic over the same ordered parameter ids', () => {
    const ids = ['p1', 'p2', 'p3']
    expect(computeTupleHash(ids)).toBe(computeTupleHash(['p1', 'p2', 'p3']))
  })

  it('differs when order differs (order is dimension-sort order, not sorted internally)', () => {
    expect(computeTupleHash(['p1', 'p2'])).not.toBe(computeTupleHash(['p2', 'p1']))
  })

  it('differs when any parameter id differs', () => {
    expect(computeTupleHash(['p1', 'p2'])).not.toBe(computeTupleHash(['p1', 'p9']))
  })
})
