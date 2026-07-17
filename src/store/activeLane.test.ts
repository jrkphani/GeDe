// Issue 089 D2 Phase 3 — the active-lane registry that scopes Design's global
// `c` / `v` / `d` verbs to the lane the user is in, now that all three tier
// lanes co-mount on one page. Mirrors focusedEditor.test.ts: a tiny value
// slice with one setter and a reset seam. Starts null (no lane active ⇒ the
// verbs are no-ops), last-set wins, and resetActiveLane clears it.
import { beforeEach, describe, expect, it } from 'vitest'
import { resetActiveLane, useActiveLaneStore } from './activeLane'

beforeEach(() => resetActiveLane())

describe('activeLane store', () => {
  it('starts with no active lane (null) — c/v/d are no-ops until a lane is focused', () => {
    expect(useActiveLaneStore.getState().activeLane).toBeNull()
  })

  it('setActiveLane records the active lane', () => {
    useActiveLaneStore.getState().setActiveLane('design')
    expect(useActiveLaneStore.getState().activeLane).toBe('design')
  })

  it('last-set wins (focus/click moves between lanes)', () => {
    const { setActiveLane } = useActiveLaneStore.getState()
    setActiveLane('foundation')
    setActiveLane('architecture')
    setActiveLane('design')
    expect(useActiveLaneStore.getState().activeLane).toBe('design')
  })

  it('setActiveLane(null) clears the active lane', () => {
    useActiveLaneStore.getState().setActiveLane('design')
    useActiveLaneStore.getState().setActiveLane(null)
    expect(useActiveLaneStore.getState().activeLane).toBeNull()
  })

  it('resetActiveLane clears the active lane (test/session seam)', () => {
    useActiveLaneStore.getState().setActiveLane('architecture')
    resetActiveLane()
    expect(useActiveLaneStore.getState().activeLane).toBeNull()
  })
})
