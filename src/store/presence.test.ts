// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import { addDimension, addParameter, createProject, bindParameter } from '../db/mutations'
import { createContext as createContextRow, listContexts } from '../db/mutations'
import { bindings, contexts } from '../db/schema'
import { setDatabase } from './database'
import { startPresence, type PresenceChannelFactory, type PresenceChannelLike } from '../presence/presenceChannel'
import type { PresenceWireEvent } from '../domain/presence'
import { resetAuthStoreForTests, useAuthStore } from './auth'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetPresenceStoreForTests, usePresenceStore } from './presence'

// A shared in-memory bus per workspace id — the same fixture shape as
// presenceChannel.test.ts. A raw startPresence() call stands in for "a
// second browser tab" sharing the same fake transport, without needing a
// second Zustand module instance (module singletons). No live Electric/AWS/
// BroadcastChannel in tests (HANDOFF).
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

function signIn(sub: string, email: string): void {
  useAuthStore.setState({ status: 'authenticated', user: { sub, email }, configured: true })
}

beforeEach(() => {
  resetAuthStoreForTests()
  resetContextsStore()
  resetPresenceStoreForTests()
  vi.stubEnv('VITE_SYNC_ENABLED', 'true')
})

afterEach(() => {
  resetPresenceStoreForTests()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('usePresenceStore.start — gating (v1 default stays untouched)', () => {
  it('is a no-op when sync is disabled — no roster, no handle', () => {
    vi.stubEnv('VITE_SYNC_ENABLED', 'false')
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: fakeChannelFactory().factory })
    expect(usePresenceStore.getState().enabled).toBe(false)
  })

  it('is a no-op when nobody is signed in — no `sub` to key a roster entry on', () => {
    usePresenceStore.getState().start('ws1', { channelFactory: fakeChannelFactory().factory })
    expect(usePresenceStore.getState().enabled).toBe(false)
  })
})

describe('usePresenceStore.start — roster reflects join/leave (test-first plan #1)', () => {
  it('a peer joining and leaving the same workspace shows up and disappears from the roster', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })
    expect(usePresenceStore.getState().enabled).toBe(true)
    expect(usePresenceStore.getState().roster.size).toBe(0)

    const peer = startPresence('ws1', { userSub: 'bob-sub', label: 'bob@x.test' }, { channelFactory: factory })
    expect(usePresenceStore.getState().roster.has('bob-sub')).toBe(true)

    peer.stop()
    expect(usePresenceStore.getState().roster.has('bob-sub')).toBe(false)
  })

  it('a peer in a different workspace never appears (channel is workspace-scoped)', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const peer = startPresence('ws2', { userSub: 'bob-sub', label: 'bob' }, { channelFactory: factory })
    expect(usePresenceStore.getState().roster.has('bob-sub')).toBe(false)
    peer.stop()
  })

  it('stop() publishes a leave so peers see it, and clears local state', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )
    expect(seenByPeer.some((e) => e.type === 'presence' && e.userSub === 'alice-sub')).toBe(true)

    usePresenceStore.getState().stop()
    expect(usePresenceStore.getState().enabled).toBe(false)
    expect(usePresenceStore.getState().roster.size).toBe(0)
    expect(seenByPeer.some((e) => e.type === 'leave' && e.userSub === 'alice-sub')).toBe(true)

    peer.stop()
  })
})

describe('usePresenceStore — ephemeral selection cue (test-first plan #2)', () => {
  it('publishes the local selectedContextId whenever useContextsStore changes it, and a peer sees it', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    useContextsStore.setState({ selectedContextId: 'ctx1' })
    const latest = seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop()
    expect(latest).toMatchObject({ selectedContextId: 'ctx1' })

    peer.stop()
  })

  it('never persists selection/focus as domain data — a full presence workflow leaves the DB untouched', async () => {
    const { db } = await openDatabase('memory://')
    setDatabase(db)
    const project = await createProject(db, { name: 'Tavalo' })
    const dim = await addDimension(db, project.id)
    const param = await addParameter(db, dim.id, 'Comfort')
    const ctx = await createContextRow(db, project.id, null)
    await bindParameter(db, ctx.id, dim.id, param.id)

    const contextRowsBefore = await listContexts(db, project.id, null)
    const bindingRowsBefore = await db.select().from(bindings)

    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })
    const peer = startPresence('ws1', { userSub: 'bob-sub', label: 'bob' }, { channelFactory: factory })

    useContextsStore.setState({ selectedContextId: ctx.id })
    usePresenceStore.getState().setFocusedCell({ contextId: ctx.id, field: dim.id })
    usePresenceStore.getState().setFocusedCell(null)
    useContextsStore.setState({ selectedContextId: null })

    const contextRowsAfter = await db.select().from(contexts)
    const bindingRowsAfter = await db.select().from(bindings)
    expect(contextRowsAfter).toHaveLength(contextRowsBefore.length)
    expect(bindingRowsAfter).toHaveLength(bindingRowsBefore.length)
    // The row content itself is untouched too (no stray column written).
    expect(contextRowsAfter).toEqual(contextRowsBefore)

    peer.stop()
  })
})

describe('usePresenceStore — same-cell editing hint (test-first plan #3)', () => {
  it('setFocusedCell publishes, and a peer can derive who is editing a given context', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    usePresenceStore.getState().setFocusedCell({ contextId: 'ctx1', field: 'justification' })
    const latest = seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop()
    expect(latest).toMatchObject({ focusedCell: { contextId: 'ctx1', field: 'justification' } })

    peer.stop()
  })
})

describe('usePresenceStore — stale entries are pruned (heartbeat timeout)', () => {
  it('a ghost entry (no leave, no heartbeat for the timeout) drops out of the roster', () => {
    vi.useFakeTimers()
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    let clock = 0
    usePresenceStore.getState().start('ws1', { channelFactory: factory, now: () => clock })

    // A peer that publishes once and then goes silent forever (crash — no
    // leave event), never advancing its own clock again.
    const ghostFactory = factory
    const ghostChannel = ghostFactory('ws1')
    ghostChannel.publish({ type: 'presence', userSub: 'ghost-sub', label: 'ghost', selectedContextId: null, focusedCell: null, at: 0 })
    expect(usePresenceStore.getState().roster.has('ghost-sub')).toBe(true)

    clock = 100_000 // well past PRESENCE_TIMEOUT_MS (45s)
    vi.advanceTimersByTime(10_000) // let the prune interval tick with the advanced clock
    expect(usePresenceStore.getState().roster.has('ghost-sub')).toBe(false)
  })
})
