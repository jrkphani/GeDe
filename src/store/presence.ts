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
import { useActiveCanvasStore } from './activeCanvas'
import { useAuthStore } from './auth'
import { listCanvasStores, resolveCanvasStores } from './canvasStores'

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

// Issue 106 item 3 — the selection publish now tracks the FOCUS-ACTIVE core, not
// just the default instance. `selectionUnsubscribe` is the subscription to the
// currently-active instance's `selectedContextId` (rebound whenever the active
// core flips); `activeCanvasUnsubscribe` watches the active-core arbiter itself.
// Both are torn down together.
let selectionUnsubscribe: (() => void) | null = null
let activeCanvasUnsubscribe: (() => void) | null = null
let pruneInterval: ReturnType<typeof setInterval> | null = null

function selfIdentity(): { userSub: string; label: string } | null {
  const { user } = useAuthStore.getState()
  if (!user) return null
  return { userSub: user.sub, label: user.email ?? user.sub }
}

// Resolve the contexts store of the focus-active core. The active-canvas key is
// NOT a store-instance key: 'root'/null is the primary core, a parentContextId is
// a LIVE CHILD core, but it is ALSO any ROOT canvas id (Issue-090 multi-root
// selector — WorkspaceCanvas sets activeCanvas from `data.canvasId`, which for the
// PRIMARY core is `route.canvasId`). So a non-'root'/non-null key does NOT imply a
// child instance. Resolve a child instance ONLY when that key already EXISTS in
// the live registry (a non-creating membership check against listCanvasStores) —
// never CREATE one from the activeCanvas key (that would leak a phantom empty
// instance and publish its frozen null). The primary core on ANY root canvas id
// finds no matching child → the DEFAULT instance (today's behavior); a live child
// core (its parentContextId IS registered) → that child's own instance.
function activeContextsStore() {
  const { activeCanvas } = useActiveCanvasStore.getState()
  if (activeCanvas != null && activeCanvas !== 'root') {
    const child = listCanvasStores().find((s) => s.canvasId === activeCanvas)
    if (child) return child.useContexts
  }
  return resolveCanvasStores(null).useContexts
}

function teardown(): void {
  selectionUnsubscribe?.()
  selectionUnsubscribe = null
  activeCanvasUnsubscribe?.()
  activeCanvasUnsubscribe = null
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

    // The ephemeral "selected context" cue (test-first plan #2, extended by
    // 106 item 3 to reach LIVE CHILD cores): the wire carries one
    // selectedContextId per user — whichever the FOCUS-ACTIVE core has selected.
    // Reads the active contexts store reactively (never the other way — the
    // contexts stores have no idea presence exists) and republishes only when
    // the value actually changes, so an unrelated store update never spams the
    // channel.
    let lastSelected: string | null = activeContextsStore().getState().selectedContextId
    handle.setSelection(lastSelected)
    const publishSelection = (): void => {
      // Resolve the active instance LAZILY every time — never cache an instance
      // ref, because a child core can be released between publishes.
      const selected = activeContextsStore().getState().selectedContextId
      if (selected === lastSelected) return
      lastSelected = selected
      handle.setSelection(selected)
    }
    // (Re)bind the selection subscription to the currently-active instance.
    const bindSelectionSubscription = (): void => {
      selectionUnsubscribe?.()
      selectionUnsubscribe = activeContextsStore().subscribe(publishSelection)
    }
    bindSelectionSubscription()
    // When the focus-active core flips, rebind the selection subscription to the
    // newly-active instance AND republish its current selection immediately.
    activeCanvasUnsubscribe = useActiveCanvasStore.subscribe(() => {
      bindSelectionSubscription()
      publishSelection()
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
