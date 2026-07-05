import { describe, expect, it } from 'vitest'
import { composeReducer, initialComposeState, type ComposeState } from './composeMode'

const DIMS = ['d0', 'd1', 'd2'] as const

describe('composeMode reducer', () => {
  it('starts with no bindings and the first dimension active', () => {
    expect(initialComposeState(DIMS)).toEqual<ComposeState>({ bindings: {}, activeDimensionId: 'd0' })
  })

  it('starts with no active dimension when there are no dimensions', () => {
    expect(initialComposeState([])).toEqual<ComposeState>({ bindings: {}, activeDimensionId: null })
  })

  it('binding a dimension advances the active pointer to the next unbound dimension', () => {
    const s0 = initialComposeState(DIMS)
    const t1 = composeReducer(DIMS, s0, { type: 'bind', dimensionId: 'd0', parameterId: 'p0' })
    expect(t1.state).toEqual<ComposeState>({ bindings: { d0: 'p0' }, activeDimensionId: 'd1' })
    expect(t1.completed).toBe(false)

    const t2 = composeReducer(DIMS, t1.state, { type: 'bind', dimensionId: 'd1', parameterId: 'p1' })
    expect(t2.state).toEqual<ComposeState>({ bindings: { d0: 'p0', d1: 'p1' }, activeDimensionId: 'd2' })
    expect(t2.completed).toBe(false)
  })

  it('fires completion exactly when the nth (last) dimension binds', () => {
    let t = composeReducer(DIMS, initialComposeState(DIMS), { type: 'bind', dimensionId: 'd0', parameterId: 'p0' })
    t = composeReducer(DIMS, t.state, { type: 'bind', dimensionId: 'd1', parameterId: 'p1' })
    expect(t.completed).toBe(false)
    t = composeReducer(DIMS, t.state, { type: 'bind', dimensionId: 'd2', parameterId: 'p2' })
    expect(t.completed).toBe(true)
    expect(t.state).toEqual<ComposeState>({
      bindings: { d0: 'p0', d1: 'p1', d2: 'p2' },
      activeDimensionId: null,
    })
  })

  it('advances with wrap-around to an earlier unbound dimension', () => {
    // d1 already bound, active on d0; binding the last (d2) wraps forward to d0.
    const state: ComposeState = { bindings: { d1: 'x' }, activeDimensionId: 'd0' }
    const t = composeReducer(DIMS, state, { type: 'bind', dimensionId: 'd2', parameterId: 'y' })
    expect(t.state).toEqual<ComposeState>({ bindings: { d1: 'x', d2: 'y' }, activeDimensionId: 'd0' })
    expect(t.completed).toBe(false)
  })

  it('re-binding an already-complete tuple does not re-fire completion', () => {
    const complete: ComposeState = {
      bindings: { d0: 'p0', d1: 'p1', d2: 'p2' },
      activeDimensionId: null,
    }
    const t = composeReducer(DIMS, complete, { type: 'bind', dimensionId: 'd1', parameterId: 'p1-alt' })
    expect(t.state).toEqual<ComposeState>({
      bindings: { d0: 'p0', d1: 'p1-alt', d2: 'p2' },
      activeDimensionId: null,
    })
    expect(t.completed).toBe(false)
  })

  it('unbinding makes that dimension active again and never fires completion', () => {
    const complete: ComposeState = {
      bindings: { d0: 'p0', d1: 'p1', d2: 'p2' },
      activeDimensionId: null,
    }
    const t = composeReducer(DIMS, complete, { type: 'unbind', dimensionId: 'd1' })
    expect(t.state).toEqual<ComposeState>({ bindings: { d0: 'p0', d2: 'p2' }, activeDimensionId: 'd1' })
    expect(t.completed).toBe(false)
  })

  it('re-binding after an unbind fires completion again', () => {
    const partial: ComposeState = { bindings: { d0: 'p0', d2: 'p2' }, activeDimensionId: 'd1' }
    const t = composeReducer(DIMS, partial, { type: 'bind', dimensionId: 'd1', parameterId: 'p1' })
    expect(t.completed).toBe(true)
    expect(t.state.activeDimensionId).toBeNull()
  })
})
