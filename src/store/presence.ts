import { useMemo } from 'react'
import { create } from 'zustand'
import {
  applyPresenceEvent,
  editorsOfContext,
  emptyRoster,
  othersInRoster,
  pruneStale,
  selectorsOfContext,
  PRESENCE_TIMEOUT_MS,
  type FocusedCell,
  type PresenceEntry,
  type PresenceRoster,
} from '../domain/presence'
import {
  startPresence,
  type PresenceChannelFactory,
  type PresenceHandle,
} from '../presence/presenceChannel'
import { isSyncEnabled } from '../sync/config'
import { useAuthStore } from './auth'
import { useContextsStore } from './contexts'

// Issue 038 — the store-layer seam for presence, mirroring store/sync.ts's
// own split (032): the pure roster reducer + cue derivations live in
// src/domain/presence.ts, the DI-testable live wiring lives in
// src/presence/presenceChannel.ts, and this store owns runtime lifecycle +
// reads/writes the rest of the app's state (auth identity, the contexts
// store's `selectedContextId`) that the pure/transport layers below can't
// see. Deliberately never imports `src/db/**` or `src/domain/syncDelta` —
// this is the structural half of "ephemeral ≠ synced data" (this issue's
// design brief); presence.test.ts also proves it at the data level (a full
// start/select/focus/stop workflow leaves every DB table row-for-row
// unchanged).

const PRUNE_INTERVAL_MS = 5_000

export interface PresenceStartOptions {
  channelFactory?: PresenceChannelFactory
  now?: () => number
  heartbeatMs?: number
}

interface PresenceState {
  enabled: boolean
  workspaceId: string | null
  selfSub: string | null
  roster: PresenceRoster
  handle: PresenceHandle | null
  // Gated by isSyncEnabled() (032's flag) AND a signed-in identity (033) —
  // v1's single-user, no-network default has nobody else to show (mirrors
  // src/shell/SyncIndicator.tsx's "renders nothing while inert" convention),
  // and an anonymous/local session has no Cognito `sub` to key a roster
  // entry on. Safe to call unconditionally/repeatedly (idempotent for an
  // already-running workspace).
  start: (workspaceId: string, options?: PresenceStartOptions) => void
  stop: () => void
  setFocusedCell: (cell: FocusedCell | null) => void
}

let contextsUnsubscribe: (() => void) | null = null
let pruneInterval: ReturnType<typeof setInterval> | null = null

function selfIdentity(): { userSub: string; label: string } | null {
  const { user } = useAuthStore.getState()
  if (!user) return null
  return { userSub: user.sub, label: user.email ?? user.sub }
}

function teardown(): void {
  contextsUnsubscribe?.()
  contextsUnsubscribe = null
  if (pruneInterval) clearInterval(pruneInterval)
  pruneInterval = null
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  enabled: false,
  workspaceId: null,
  selfSub: null,
  roster: emptyRoster(),
  handle: null,

  start(workspaceId, options = {}) {
    if (!isSyncEnabled()) return
    const self = selfIdentity()
    if (!self) return
    // Already running for this exact workspace (e.g. a re-render re-firing
    // the caller's effect) — a no-op rather than a churn-y stop/restart.
    if (get().enabled && get().workspaceId === workspaceId) return

    get().handle?.stop()
    teardown()
    set({ enabled: true, workspaceId, selfSub: self.userSub, roster: emptyRoster() })

    const now = options.now ?? (() => Date.now())
    const handle = startPresence(workspaceId, self, {
      ...options,
      now,
      onEvent: (event) => {
        set({ roster: applyPresenceEvent(get().roster, event) })
      },
    })

    // The ephemeral "selected context" cue (test-first plan #2): reads
    // useContextsStore reactively (never the other way — contexts.ts has no
    // idea presence exists) and republishes only when the value actually
    // changes, so an unrelated contexts-store update never spams the channel.
    let lastSelected = useContextsStore.getState().selectedContextId
    handle.setSelection(lastSelected)
    contextsUnsubscribe = useContextsStore.subscribe((state) => {
      if (state.selectedContextId === lastSelected) return
      lastSelected = state.selectedContextId
      handle.setSelection(lastSelected)
    })

    pruneInterval = setInterval(() => {
      set({ roster: pruneStale(get().roster, now(), PRESENCE_TIMEOUT_MS) })
    }, PRUNE_INTERVAL_MS)

    set({ handle })
  },

  stop() {
    get().handle?.stop()
    teardown()
    set({ enabled: false, workspaceId: null, selfSub: null, roster: emptyRoster(), handle: null })
  },

  setFocusedCell(cell) {
    get().handle?.setFocusedCell(cell)
  },
}))

/** Test-only reset — mirrors every other store's own reset helper. */
export function resetPresenceStoreForTests(): void {
  usePresenceStore.getState().stop()
}

// Store-layer selector hook (mirrors useWorkspaceRole's own derived-hook
// convention, src/store/workspace.ts): who else has this context selected
// (test-first plan #2) and who else is editing a cell on it (test-first
// plan #3), keyed off the live roster.
export function usePresenceCues(contextId: string): {
  selectors: PresenceEntry[]
  editors: PresenceEntry[]
} {
  const roster = usePresenceStore((s) => s.roster)
  const selfSub = usePresenceStore((s) => s.selfSub)
  return useMemo(
    () => ({
      selectors: selectorsOfContext(roster, contextId, selfSub),
      editors: editorsOfContext(roster, contextId, selfSub),
    }),
    [roster, contextId, selfSub],
  )
}

/** Every other online collaborator in the current workspace (the app-bar
 *  roster's data source) — empty when presence isn't running. */
export function useOnlinePresence(): PresenceEntry[] {
  const enabled = usePresenceStore((s) => s.enabled)
  const roster = usePresenceStore((s) => s.roster)
  const selfSub = usePresenceStore((s) => s.selfSub)
  return useMemo(() => (enabled ? othersInRoster(roster, selfSub) : []), [enabled, roster, selfSub])
}
