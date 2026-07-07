// The presence transport seam (issue 038): an ephemeral, workspace-scoped
// pub/sub — never a synced row (this issue's design brief: "ephemeral ≠
// synced data" / ADR-0005 spirit). Modeled exactly like 032's
// src/sync/syncEngine.ts: a structural interface a fake can implement in
// tests (no live transport reachable in this repo's tests, HANDOFF), with a
// real default backed by the browser's BroadcastChannel API.
//
// Honest scope note: BroadcastChannel is same-origin, same-browser only —
// it genuinely, functionally shares presence across every open tab on the
// same workspace, but NOT across two different devices/browsers over the
// network. True cross-network presence needs a real server-side channel
// (e.g. a WebSocket route behind the ALB, or a future Electric presence
// primitive) that this issue does not build — flagged in the issue's own
// final report as a deliberate scope cut, not an oversight: 038 is marked
// speculative/demand-gated, and standing up new realtime server infra before
// there's evidence anyone wants this is exactly the over-building the issue
// warns against.
import type { FocusedCell, PresenceWireEvent } from '../domain/presence'
import { PRESENCE_HEARTBEAT_MS } from '../domain/presence'

export interface PresenceChannelLike {
  publish(event: PresenceWireEvent): void
  subscribe(callback: (event: PresenceWireEvent) => void): () => void
  close?(): void
}

export type PresenceChannelFactory = (workspaceId: string) => PresenceChannelLike

function channelName(workspaceId: string): string {
  return `gede-presence-${workspaceId}`
}

// Guarded, not assumed: missing in some test/SSR environments. A channel
// that can't be created just means presence is inert, never a crash — the
// same "additive/best-effort" philosophy syncEngine.ts documents for 032.
export const defaultPresenceChannelFactory: PresenceChannelFactory = (workspaceId) => {
  if (typeof BroadcastChannel === 'undefined') {
    return { publish: () => undefined, subscribe: () => () => undefined }
  }
  const bc = new BroadcastChannel(channelName(workspaceId))
  return {
    publish(event) {
      bc.postMessage(event)
    },
    subscribe(callback) {
      const listener = (e: MessageEvent<PresenceWireEvent>) => callback(e.data)
      bc.addEventListener('message', listener)
      return () => bc.removeEventListener('message', listener)
    },
    close() {
      bc.close()
    },
  }
}

export interface PresenceOptions {
  channelFactory?: PresenceChannelFactory
  onEvent?: (event: PresenceWireEvent) => void
  heartbeatMs?: number
  now?: () => number
}

export interface PresenceHandle {
  setSelection(selectedContextId: string | null): void
  setFocusedCell(cell: FocusedCell | null): void
  stop(): void
}

export function startPresence(
  workspaceId: string,
  self: { userSub: string; label: string },
  options: PresenceOptions = {},
): PresenceHandle {
  const factory = options.channelFactory ?? defaultPresenceChannelFactory
  const now = options.now ?? (() => Date.now())
  const channel = factory(workspaceId)

  let selectedContextId: string | null = null
  let focusedCell: FocusedCell | null = null

  function snapshotEvent(): PresenceWireEvent {
    return {
      type: 'presence',
      userSub: self.userSub,
      label: self.label,
      selectedContextId,
      focusedCell,
      at: now(),
    }
  }

  // Subscribe BEFORE any publish below — the fake bus in tests (and a real
  // BroadcastChannel) fan out synchronously/soon-after to whoever is already
  // listening, so a late subscribe would miss the reply this client's own
  // `hello` provokes from existing peers.
  const unsubscribe = channel.subscribe((event) => {
    if (event.userSub === self.userSub) return // never hear our own broadcast
    if (event.type === 'hello') {
      // A newly-joined peer asked "who's here?" — reannounce immediately so
      // its roster doesn't sit empty until the next heartbeat (a plain
      // pub/sub channel has no replay for late subscribers).
      channel.publish(snapshotEvent())
      return
    }
    options.onEvent?.(event)
  })

  channel.publish({ type: 'hello', userSub: self.userSub, at: now() })
  channel.publish(snapshotEvent())

  const heartbeat = setInterval(
    () => channel.publish(snapshotEvent()),
    options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS,
  )

  function publishLeave(): void {
    channel.publish({ type: 'leave', userSub: self.userSub, at: now() })
  }

  // Best-effort leave on tab close — `pagehide` fires reliably on both
  // navigation and close (unlike `beforeunload`, which some browsers
  // suppress); a crash/network loss still relies on pruneStale's heartbeat
  // timeout (src/domain/presence.ts), same as any ephemeral presence system.
  let unloadHandler: (() => void) | null = null
  if (typeof window !== 'undefined') {
    unloadHandler = () => publishLeave()
    window.addEventListener('pagehide', unloadHandler)
  }

  return {
    setSelection(next) {
      selectedContextId = next
      channel.publish(snapshotEvent())
    },
    setFocusedCell(next) {
      focusedCell = next
      channel.publish(snapshotEvent())
    },
    stop() {
      clearInterval(heartbeat)
      publishLeave()
      unsubscribe()
      channel.close?.()
      if (unloadHandler && typeof window !== 'undefined') window.removeEventListener('pagehide', unloadHandler)
    },
  }
}
