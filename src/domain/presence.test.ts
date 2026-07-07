import { describe, expect, it } from 'vitest'
import {
  applyPresenceEvent,
  assignPresenceColor,
  editorsOfContext,
  emptyRoster,
  othersInRoster,
  presenceCueLabel,
  pruneStale,
  selectorsOfContext,
  type PresenceWireEvent,
} from './presence'
import { DIMENSION_PALETTE } from '../theme/palette'

function presenceEvent(userSub: string, over: Partial<Extract<PresenceWireEvent, { type: 'presence' }>> = {}): PresenceWireEvent {
  return {
    type: 'presence',
    userSub,
    label: over.label ?? `${userSub}@x.test`,
    selectedContextId: over.selectedContextId ?? null,
    focusedCell: over.focusedCell ?? null,
    at: over.at ?? 0,
  }
}

describe('applyPresenceEvent — roster reducer (test-first plan #1: join/leave)', () => {
  it('a presence event adds/refreshes an entry keyed by userSub', () => {
    const roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { at: 10 }))
    expect(roster.size).toBe(1)
    expect(roster.get('alice')).toMatchObject({ userSub: 'alice', label: 'alice@x.test', lastSeen: 10 })
  })

  it('a later presence event from the same user overwrites the entry (last message wins)', () => {
    let roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { selectedContextId: 'ctx1', at: 10 }))
    roster = applyPresenceEvent(roster, presenceEvent('alice', { selectedContextId: 'ctx2', at: 20 }))
    expect(roster.size).toBe(1)
    expect(roster.get('alice')).toMatchObject({ selectedContextId: 'ctx2', lastSeen: 20 })
  })

  it('a leave event removes the entry — join then leave nets to an empty roster', () => {
    let roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice'))
    expect(roster.size).toBe(1)
    roster = applyPresenceEvent(roster, { type: 'leave', userSub: 'alice', at: 5 })
    expect(roster.size).toBe(0)
  })

  it('a leave for a user not present is a harmless no-op', () => {
    const roster = applyPresenceEvent(emptyRoster(), { type: 'leave', userSub: 'ghost', at: 0 })
    expect(roster.size).toBe(0)
  })

  it('a hello (handshake) event never mutates the roster — it is a protocol event, not a presence fact', () => {
    const roster = applyPresenceEvent(emptyRoster(), { type: 'hello', userSub: 'alice', at: 0 })
    expect(roster.size).toBe(0)
  })
})

describe('pruneStale — heartbeat timeout (a tab that vanishes without publishing leave)', () => {
  it('removes an entry whose lastSeen is older than the timeout', () => {
    const roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { at: 0 }))
    const pruned = pruneStale(roster, 100_000, 45_000)
    expect(pruned.size).toBe(0)
  })

  it('keeps a fresh entry', () => {
    const roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { at: 90_000 }))
    const pruned = pruneStale(roster, 100_000, 45_000)
    expect(pruned.size).toBe(1)
  })

  it('returns the same reference when nothing was pruned (no gratuitous re-renders)', () => {
    const roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { at: 90_000 }))
    const pruned = pruneStale(roster, 100_000, 45_000)
    expect(pruned).toBe(roster)
  })
})

describe('assignPresenceColor — deterministic per-user identity color', () => {
  it('is stable for the same userSub', () => {
    expect(assignPresenceColor('alice-sub')).toBe(assignPresenceColor('alice-sub'))
  })

  it('never returns green (the one reserved chrome accent, STYLE_GUIDE §2.2) or a literal dimension-palette hex', () => {
    const subs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'alice-sub', 'bob-sub', 'carol-sub']
    for (const sub of subs) {
      const color = assignPresenceColor(sub)
      expect(color.toLowerCase()).not.toBe('#2d6a4f')
      expect(color.toLowerCase()).not.toBe('#23543f')
      expect(DIMENSION_PALETTE.map((c) => c.toLowerCase())).not.toContain(color.toLowerCase())
    }
  })
})

describe('othersInRoster / selectorsOfContext / editorsOfContext — cue derivations', () => {
  it('excludes self and sorts deterministically', () => {
    let roster = applyPresenceEvent(emptyRoster(), presenceEvent('bob'))
    roster = applyPresenceEvent(roster, presenceEvent('alice'))
    roster = applyPresenceEvent(roster, presenceEvent('self'))
    const others = othersInRoster(roster, 'self')
    expect(others.map((e) => e.userSub)).toEqual(['alice', 'bob'])
  })

  it('selectorsOfContext returns only entries whose selectedContextId matches, excluding self', () => {
    let roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { selectedContextId: 'ctx1' }))
    roster = applyPresenceEvent(roster, presenceEvent('bob', { selectedContextId: 'ctx2' }))
    roster = applyPresenceEvent(roster, presenceEvent('self', { selectedContextId: 'ctx1' }))
    expect(selectorsOfContext(roster, 'ctx1', 'self').map((e) => e.userSub)).toEqual(['alice'])
    expect(selectorsOfContext(roster, 'ctx2', 'self').map((e) => e.userSub)).toEqual(['bob'])
  })

  it('editorsOfContext returns only entries whose focusedCell.contextId matches, excluding self — test-first plan #3 (same-cell hint)', () => {
    let roster = applyPresenceEvent(
      emptyRoster(),
      presenceEvent('alice', { focusedCell: { contextId: 'ctx1', field: 'justification' } }),
    )
    roster = applyPresenceEvent(roster, presenceEvent('bob', { focusedCell: { contextId: 'ctx2', field: 'symbol' } }))
    expect(editorsOfContext(roster, 'ctx1', 'self').map((e) => e.userSub)).toEqual(['alice'])
    expect(editorsOfContext(roster, 'ctx2', 'self').map((e) => e.userSub)).toEqual(['bob'])
    expect(editorsOfContext(roster, 'ctx3', 'self')).toEqual([])
  })
})

describe('presenceCueLabel — STYLE_GUIDE §9 voice (quiet, specific, numerate)', () => {
  it('empty list is empty string', () => {
    expect(presenceCueLabel([], 'editing')).toBe('')
  })

  it('one entry names them', () => {
    const roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { label: 'alice@x.test' }))
    expect(presenceCueLabel(othersInRoster(roster, null), 'editing')).toBe('alice@x.test is editing')
  })

  it('two entries name both', () => {
    let roster = applyPresenceEvent(emptyRoster(), presenceEvent('alice', { label: 'Alice' }))
    roster = applyPresenceEvent(roster, presenceEvent('bob', { label: 'Bob' }))
    const label = presenceCueLabel(othersInRoster(roster, null), 'here')
    expect(label === 'Alice and Bob are here' || label === 'Bob and Alice are here').toBe(true)
  })

  it('three or more collapses to a count, per §9 (numerate, not a name dump)', () => {
    let roster = emptyRoster()
    for (const sub of ['a', 'b', 'c']) roster = applyPresenceEvent(roster, presenceEvent(sub))
    expect(presenceCueLabel(othersInRoster(roster, null), 'here')).toBe('3 people are here')
  })
})
