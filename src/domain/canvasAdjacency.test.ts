import { describe, expect, it } from 'vitest'
import { adjacentSet, dotKey, EMPTY_ADJACENT_SET } from './canvasAdjacency'

// Issue 028(a), test-first-plan item 1 — pure adjacency predicate. Three
// dimensions (d0/d1/d2), d2 has zero parameters (mirrors Canvas.test.tsx's
// zero-parameter dimension fixture). ctxA binds d0+d1; ctxB binds d0 only.
const dots = [
  { dimensionId: 'd0', parameterId: 'd0-p0' },
  { dimensionId: 'd0', parameterId: 'd0-p1' },
  { dimensionId: 'd1', parameterId: 'd1-p0' },
]
const bindingsByContext = {
  ctxA: { d0: 'd0-p0', d1: 'd1-p0' },
  ctxB: { d0: 'd0-p1' },
}

describe('adjacentSet', () => {
  it('returns the empty set when nothing is emphasised', () => {
    expect(adjacentSet(null, { bindingsByContext, dots })).toBe(EMPTY_ADJACENT_SET)
  })

  describe('context role', () => {
    it("returns the context itself plus its bound dots' keys, no dimensions", () => {
      const result = adjacentSet({ id: 'ctxA', role: 'context' }, { bindingsByContext, dots })
      expect(result.contextIds).toEqual(new Set(['ctxA']))
      expect(result.dotKeys).toEqual(new Set([dotKey('d0', 'd0-p0'), dotKey('d1', 'd1-p0')]))
      expect(result.dimensionIds).toEqual(new Set())
    })

    it('an unbound context returns itself with no dot keys', () => {
      const result = adjacentSet(
        { id: 'ctxC', role: 'context' },
        { bindingsByContext: { ...bindingsByContext, ctxC: {} }, dots },
      )
      expect(result.contextIds).toEqual(new Set(['ctxC']))
      expect(result.dotKeys).toEqual(new Set())
    })

    it('a context id absent from bindingsByContext entirely still returns itself with no dots', () => {
      const result = adjacentSet({ id: 'ghost', role: 'context' }, { bindingsByContext, dots })
      expect(result.contextIds).toEqual(new Set(['ghost']))
      expect(result.dotKeys).toEqual(new Set())
    })
  })

  describe('parameter role', () => {
    it('returns every context bound to it, no dots, no dimensions', () => {
      const result = adjacentSet({ id: 'd0-p0', role: 'parameter' }, { bindingsByContext, dots })
      expect(result.contextIds).toEqual(new Set(['ctxA']))
      expect(result.dotKeys).toEqual(new Set())
      expect(result.dimensionIds).toEqual(new Set())
    })

    it('a parameter bound by multiple contexts returns all of them', () => {
      const multi = { ctxA: { d0: 'd0-p1' }, ctxB: { d0: 'd0-p1' }, ctxC: { d0: 'd0-p0' } }
      const result = adjacentSet({ id: 'd0-p1', role: 'parameter' }, { bindingsByContext: multi, dots })
      expect(result.contextIds).toEqual(new Set(['ctxA', 'ctxB']))
    })

    it('a parameter no context uses returns an empty context set (boundary case)', () => {
      const result = adjacentSet({ id: 'd1-p0-unused', role: 'parameter' }, { bindingsByContext, dots })
      expect(result.contextIds).toEqual(new Set())
    })
  })

  describe('dimension role', () => {
    it('returns every one of its parameter dots (bound or not) plus the contexts bound within it', () => {
      // d0 has two dots (d0-p0, d0-p1); only d0-p0 is ever bound (by ctxA).
      const result = adjacentSet({ id: 'd0', role: 'dimension' }, { bindingsByContext, dots })
      expect(result.dotKeys).toEqual(new Set([dotKey('d0', 'd0-p0'), dotKey('d0', 'd0-p1')]))
      expect(result.contextIds).toEqual(new Set(['ctxA', 'ctxB']))
      expect(result.dimensionIds).toEqual(new Set(['d0']))
    })

    it('an empty dimension (zero parameters) returns itself with no dots and no contexts (boundary case)', () => {
      const result = adjacentSet({ id: 'd2', role: 'dimension' }, { bindingsByContext, dots })
      expect(result.dotKeys).toEqual(new Set())
      expect(result.contextIds).toEqual(new Set())
      expect(result.dimensionIds).toEqual(new Set(['d2']))
    })
  })

  it('is deterministic: identical input produces an equivalent result on repeat calls', () => {
    const a = adjacentSet({ id: 'd0', role: 'dimension' }, { bindingsByContext, dots })
    const b = adjacentSet({ id: 'd0', role: 'dimension' }, { bindingsByContext, dots })
    expect(a).toEqual(b)
  })
})
