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
import { resetActiveCanvas, useActiveCanvasStore } from './activeCanvas'
import { getCanvasStores, listCanvasStores, releaseCanvasStores } from './canvasStores'
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
  resetActiveCanvas()
  resetPresenceStoreForTests()
  vi.stubEnv('VITE_SYNC_ENABLED', 'true')
})

afterEach(() => {
  resetPresenceStoreForTests()
  releaseCanvasStores('parent-A')
  // Guard: if a regression ever CREATES a phantom instance from a root-canvas
  // key, drop it so the leak can't bleed into a later test's registry count.
  releaseCanvasStores('root-canvas-xyz')
  resetActiveCanvas()
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

describe('usePresenceStore — selection cue follows the focus-active core (issue 106 item 3)', () => {
  it('publishes a LIVE CHILD core\'s selection to a peer when that child is focus-active', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    // Drill into a child core (its own store instance, keyed by parentContextId)
    // and make it focus-active, then select a context on ITS instance.
    const child = getCanvasStores('parent-A')
    useActiveCanvasStore.getState().setActiveCanvas('parent-A')
    child.useContexts.setState({ selectedContextId: 'child-ctx' })

    const latest = seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop()
    expect(latest).toMatchObject({ selectedContextId: 'child-ctx' })

    peer.stop()
  })

  it('regression — the DEFAULT selection is still published when the root core is active (or nothing is focused)', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    // activeCanvas === 'root' (the primary core) resolves the default instance.
    useActiveCanvasStore.getState().setActiveCanvas('root')
    useContextsStore.setState({ selectedContextId: 'root-ctx' })
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'root-ctx' })

    // activeCanvas === null (nothing focused) also falls back to the default.
    useActiveCanvasStore.getState().setActiveCanvas(null)
    useContextsStore.setState({ selectedContextId: 'root-ctx-2' })
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'root-ctx-2' })

    peer.stop()
  })

  it('flipping the active core republishes the newly-active core\'s selection (no store write)', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    // Seed distinct selections on the two live cores.
    useContextsStore.setState({ selectedContextId: 'root-ctx' })
    const child = getCanvasStores('parent-A')
    child.useContexts.setState({ selectedContextId: 'child-ctx' })

    // Root active → the wire carries the root selection.
    useActiveCanvasStore.getState().setActiveCanvas('root')
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'root-ctx' })

    // Flip focus to the child core — republishes the child's selection WITHOUT
    // touching either store's selectedContextId.
    useActiveCanvasStore.getState().setActiveCanvas('parent-A')
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'child-ctx' })

    peer.stop()
  })

  it('primary core on a non-default root canvas resolves the DEFAULT instance (no phantom instance created, no stale/null publish)', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    const instancesBefore = listCanvasStores().length
    // The Issue-090 multi-root selector sets activeCanvas to a ROOT canvas id
    // (CanvasSwitcher / ?canvas=<id>) that is NOT a registered child-store key.
    // The primary core on ANY root canvas must resolve the DEFAULT instance —
    // never CREATE a phantom instance from that key.
    useActiveCanvasStore.getState().setActiveCanvas('root-canvas-xyz')
    useContextsStore.setState({ selectedContextId: 'default-ctx' })

    // The peer sees the DEFAULT instance's live selection, not a phantom's null.
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'default-ctx' })
    // No phantom store instance was created (and thus leaked) from the root key.
    expect(listCanvasStores().length).toBe(instancesBefore)

    peer.stop()
  })

  it('collapsing the focus-active child core (release + activeCanvas reset) stops the zombie publish and rebinds to DEFAULT', () => {
    const { factory } = fakeChannelFactory()
    signIn('alice-sub', 'alice@x.test')
    usePresenceStore.getState().start('ws1', { channelFactory: factory })

    const seenByPeer: PresenceWireEvent[] = []
    const peer = startPresence(
      'ws1',
      { userSub: 'bob-sub', label: 'bob' },
      { channelFactory: factory, onEvent: (e) => seenByPeer.push(e) },
    )

    // A live child core is focus-active with its own selection; the DEFAULT core
    // holds a different one.
    const child = getCanvasStores('parent-A')
    useActiveCanvasStore.getState().setActiveCanvas('parent-A')
    child.useContexts.setState({ selectedContextId: 'child-stale' })
    useContextsStore.setState({ selectedContextId: 'root-live' })
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'child-stale' })

    // Collapse — exactly the two operations WorkspaceCanvas.onSatelliteCollapse
    // performs: release the child instance (now a frozen zombie) AND reset the
    // active-canvas arbiter. WITHOUT the reset, presence stays bound to the
    // zombie and keeps publishing 'child-stale' forever (the Finding-2 bug).
    releaseCanvasStores('parent-A')
    resetActiveCanvas()

    // Presence rebinds to the DEFAULT core and republishes ITS selection.
    expect(
      seenByPeer.filter((e) => e.type === 'presence' && e.userSub === 'alice-sub').pop(),
    ).toMatchObject({ selectedContextId: 'root-live' })

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
