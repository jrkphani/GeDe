import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPresence, type PresenceChannelFactory, type PresenceChannelLike } from './presenceChannel'
import type { PresenceWireEvent } from '../domain/presence'

// A shared in-memory bus per workspace id — every channel created for the
// same workspace hears every other's publish, mirroring BroadcastChannel's
// same-origin fan-out (including "the sender never hears its own
// postMessage", asserted below) without a real browser API. This is the
// fixture/DI the issue calls for — no live Electric/AWS/BroadcastChannel in
// tests (HANDOFF), mirroring 032's syncEngine.test.ts fakeStreamFactory.
function fakeChannelFactory(): { factory: PresenceChannelFactory } {
  const buses = new Map<string, Set<(event: PresenceWireEvent) => void>>()
  const factory: PresenceChannelFactory = (workspaceId): PresenceChannelLike => {
    let subscribers = buses.get(workspaceId)
    if (!subscribers) {
      subscribers = new Set()
      buses.set(workspaceId, subscribers)
    }
    const subs = subscribers
    return {
      publish(event) {
        for (const cb of subs) cb(event)
      },
      subscribe(callback) {
        subs.add(callback)
        return () => subs.delete(callback)
      },
    }
  }
  return { factory }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startPresence — channel orchestration (test-first plan #1/#2)', () => {
  it('a second client hears the first client join (via the hello handshake), a selection update, and a leave', () => {
    const { factory } = fakeChannelFactory()
    const events1: PresenceWireEvent[] = []
    const events2: PresenceWireEvent[] = []
    let clock = 0
    const now = () => clock

    const client1 = startPresence(
      'ws1',
      { userSub: 'alice', label: 'alice@x.test' },
      { channelFactory: factory, now, onEvent: (e) => events1.push(e) },
    )
    const client2 = startPresence(
      'ws1',
      { userSub: 'bob', label: 'bob@x.test' },
      { channelFactory: factory, now, onEvent: (e) => events2.push(e) },
    )

    // Each hears the other's presence, never its own (BroadcastChannel's own
    // "sender doesn't hear itself" semantics, honored here even though the
    // fake bus would otherwise loop back).
    expect(events2.some((e) => e.type === 'presence' && e.userSub === 'alice')).toBe(true)
    expect(events1.some((e) => e.type === 'presence' && e.userSub === 'bob')).toBe(true)
    expect(events1.some((e) => e.userSub === 'alice')).toBe(false)
    expect(events2.some((e) => e.userSub === 'bob')).toBe(false)
    // The handshake event itself never reaches onEvent (it's transport-level).
    expect(events1.some((e) => e.type === 'hello')).toBe(false)
    expect(events2.some((e) => e.type === 'hello')).toBe(false)

    clock = 5
    client1.setSelection('ctx1')
    const latest = events2.filter((e) => e.type === 'presence' && e.userSub === 'alice').pop()
    expect(latest).toMatchObject({ selectedContextId: 'ctx1', at: 5 })

    clock = 6
    client1.stop()
    expect(events2.some((e) => e.type === 'leave' && e.userSub === 'alice' && e.at === 6)).toBe(true)

    client2.stop()
  })

  it('ephemeral focus (selectedContextId / focusedCell) never touches the wire until published — starts null', () => {
    const { factory } = fakeChannelFactory()
    const observer = factory('ws2')
    const seen: PresenceWireEvent[] = []
    observer.subscribe((e) => seen.push(e))

    const handle = startPresence('ws2', { userSub: 'alice', label: 'alice' }, { channelFactory: factory })
    const join = seen.find((e) => e.type === 'presence')
    expect(join).toMatchObject({ selectedContextId: null, focusedCell: null })

    handle.setFocusedCell({ contextId: 'ctx1', field: 'justification' })
    const updated = seen.filter((e) => e.type === 'presence').pop()
    expect(updated).toMatchObject({ focusedCell: { contextId: 'ctx1', field: 'justification' } })

    handle.stop()
  })

  it('heartbeats resend the current snapshot on an interval', () => {
    vi.useFakeTimers()
    const { factory } = fakeChannelFactory()
    const observer = factory('ws3')
    const seen: PresenceWireEvent[] = []
    observer.subscribe((e) => seen.push(e))

    const handle = startPresence(
      'ws3',
      { userSub: 'alice', label: 'alice' },
      { channelFactory: factory, heartbeatMs: 1000 },
    )
    expect(seen).toHaveLength(2) // hello + initial join snapshot

    vi.advanceTimersByTime(2500)
    // 2 more heartbeats at a 1s cadence within 2.5s.
    expect(seen.filter((e) => e.type === 'presence').length).toBeGreaterThanOrEqual(3)

    handle.stop()
  })

  it('a missing BroadcastChannel (no default factory used here, but a no-op-shaped fake) never throws — best-effort like 032 sync', () => {
    const noop: PresenceChannelFactory = () => ({ publish: () => undefined, subscribe: () => () => undefined })
    expect(() => {
      const handle = startPresence('ws4', { userSub: 'alice', label: 'alice' }, { channelFactory: noop })
      handle.setSelection('ctx1')
      handle.stop()
    }).not.toThrow()
  })
})
