import { beforeEach, describe, expect, it } from 'vitest'
import { useCoreEditingStore } from './coreEditing'

// Issue 106 item 1 (HIGH review fix) — the shared per-core editing signal. The
// register WRITES it (imperatively, via getState, so it never subscribes and never
// re-renders on its own focus — the 089-P5 click-to-edit regression); the ring READS
// it (boolean selector) so register + ring demote in lockstep on the editing axis.
// This covers the pure store: set / clear / reset, per-core isolation, stable ref.

describe('coreEditing store', () => {
  beforeEach(() => {
    useCoreEditingStore.getState().resetCoreEditing()
  })

  it('defaults to no cores editing', () => {
    expect(useCoreEditingStore.getState().editing).toEqual({})
  })

  it('marks a core as editing', () => {
    useCoreEditingStore.getState().setCoreEditing('canvas-a', true)
    expect(useCoreEditingStore.getState().editing['canvas-a']).toBe(true)
  })

  it('clears a core (deletes the key rather than storing false)', () => {
    useCoreEditingStore.getState().setCoreEditing('canvas-a', true)
    useCoreEditingStore.getState().setCoreEditing('canvas-a', false)
    expect(useCoreEditingStore.getState().editing['canvas-a']).toBeUndefined()
    expect(useCoreEditingStore.getState().editing).toEqual({})
  })

  it('keeps per-core isolation (clearing one leaves the other set)', () => {
    useCoreEditingStore.getState().setCoreEditing('canvas-a', true)
    useCoreEditingStore.getState().setCoreEditing('canvas-b', true)
    useCoreEditingStore.getState().setCoreEditing('canvas-a', false)
    expect(useCoreEditingStore.getState().editing['canvas-a']).toBeUndefined()
    expect(useCoreEditingStore.getState().editing['canvas-b']).toBe(true)
  })

  it('resets every core', () => {
    useCoreEditingStore.getState().setCoreEditing('canvas-a', true)
    useCoreEditingStore.getState().setCoreEditing('canvas-b', true)
    useCoreEditingStore.getState().resetCoreEditing()
    expect(useCoreEditingStore.getState().editing).toEqual({})
  })

  it('keeps a STABLE editing reference on a no-op set (no needless ring re-render)', () => {
    useCoreEditingStore.getState().setCoreEditing('canvas-a', true)
    const before = useCoreEditingStore.getState().editing
    useCoreEditingStore.getState().setCoreEditing('canvas-a', true)
    expect(useCoreEditingStore.getState().editing).toBe(before)
  })

  it('keeps a stable reference clearing an already-clear core', () => {
    const before = useCoreEditingStore.getState().editing
    useCoreEditingStore.getState().setCoreEditing('canvas-a', false)
    expect(useCoreEditingStore.getState().editing).toBe(before)
  })
})
