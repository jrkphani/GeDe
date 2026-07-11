import { create } from 'zustand'
import type { Database } from '../db/client'
import {
  acknowledge,
  emptyQueue,
  enqueue,
  pending,
  pendingCount,
  prune,
  reconcileWithDeltas,
  rejectMutation,
  type MutationQueue,
  type QueuedMutation,
} from '../domain/mutationQueue'
import { deriveSyncStatus, detectLostEdits, lostEditMessage, type SyncStatus } from '../domain/syncStatus'
import type { TableName } from '../domain/syncDelta'
import { startSync, type SyncHandle, type SyncOptions } from '../sync/syncEngine'
import { isSyncEnabled, shouldSkipReadPath, SYNCED_TABLES, writeApiPath } from '../sync/config'
import { flushMutations, type WriteApiHttpClient } from '../sync/writeTransport'
import { getAuthHeaders } from '../auth/wireIdentity'
import { useAuthStore } from './auth'
import { useStatusStore } from './status'

// Issue 048 — the write-transport wiring: src/sync/writeTransport.ts is pure
// and store-free (mirrors syncEngine.ts's own split), so this store is what
// supplies the real `fetch`, the real Cognito JWT (wireIdentity.ts's
// getAuthHeaders(), 033/044), and the currently-open workspace. The HTTP
// client itself isn't injectable through the public store API (there's no
// test seam for swapping `fetch` at the store layer) — every flush test
// drives src/sync/writeTransport.ts directly instead, which IS fully
// DI-testable; this module only wires the real implementation once.
const defaultHttpClient: WriteApiHttpClient = async (path, init) => {
  const response = await fetch(path, init)
  return { ok: response.ok, status: response.status, json: () => response.json() as Promise<unknown> }
}

// Exponential backoff for a failed flush (network error or a wholesale
// auth rejection that a token refresh might resolve) — module-level, like
// onlineHandler/offlineHandler below, so it survives across store actions
// without bloating SyncState with timer plumbing tests don't need (every
// flush test calls `flush()` directly rather than waiting on real timers).
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
let flushTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = INITIAL_BACKOFF_MS

function clearFlushTimer(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
}

function resetBackoff(): void {
  backoffMs = INITIAL_BACKOFF_MS
}

function scheduleFlushRetry(flush: () => Promise<void>): void {
  clearFlushTimer()
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

// The store-layer seam for issue 032's read-path + optimistic-write queue:
// owns the queue's runtime state and the sync engine's lifecycle, gated by
// isSyncEnabled() (default OFF — v1's single-user path is the tested
// default, test-first plan #6). Issue 036 extends this same store with the
// derived SyncStatus (online/offline/syncing/reconnecting/error/synced) a
// status-bar indicator (src/shell/SyncIndicator.tsx) renders, plus the quiet
// lost-edit note (useStatusStore.announce — the one feedback channel, no
// toasts) — 032 exposes the raw signals, 036 renders them.
//
// Session-scoped, not persisted — mirrors useCommandLogStore (issue 006):
// the queue and the command log are independent structures (test-first plan
// #5 — a remote delta reconciling mid-session must never touch undo/redo),
// so this store never imports or calls useCommandLogStore.

let onlineHandler: (() => void) | null = null
let offlineHandler: (() => void) | null = null

function initialOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

interface SyncState {
  enabled: boolean
  handle: SyncHandle | null
  queue: MutationQueue
  pendingCount: number
  // Issue 036 — the raw signals deriveSyncStatus() folds into `status`.
  online: boolean
  hasError: boolean
  reconnecting: boolean
  upToDateTables: ReadonlySet<TableName>
  status: SyncStatus
  // Issue 048 — the workspace a flush's MutationEnvelopes are scoped to.
  // KNOWN GAP: nothing calls setWorkspaceId() yet — wiring it to "whichever
  // workspace the open project belongs to" touches src/store/projects.ts,
  // out of this issue's ownership (see docs/issues/048 implementation
  // notes). Until a caller sets it, flush() finds no workspace and stays a
  // no-op (never a crash, mirrors the rest of this store's "sync is
  // additive, never load-bearing" design).
  workspaceId: string | null
  flushing: boolean
  // Issue 062 — a generic "an `invitations` delta just applied" signal, a
  // plain `Date.now()` timestamp bumped by onApplied below. Deliberately
  // table-name-only: this store has no notion of invitations/workspace
  // semantics (mirrors its own "never touches the command log" isolation
  // principle) — src/components/PendingInvitations.tsx is the one consumer,
  // subscribing to this value so useWorkspaceStore.loadMyInvitations() reruns
  // whenever a NEW inbound invite streams in mid-session, closing the gap
  // where the 060 badge only ever refreshed on mount/identity-change.
  invitationsAppliedAt: number
  // Issue 067 — the `workspace_members` analogue of invitationsAppliedAt
  // directly above: a plain "an inbound `workspace_members` delta just
  // applied" timestamp, bumped by onApplied below the same way. This store
  // stays workspace-semantics-free either way — src/store/workspace.ts's
  // useWorkspaceRole is the one consumer, subscribing to this value so its
  // own load-on-workspaceId-change effect ALSO reruns whenever a member is
  // added/changed/removed on another client mid-session, closing the gap
  // where the owner's Members panel (WorkspaceMembers.tsx) only ever
  // reflected whatever this device's own local PGlite happened to already
  // contain.
  membersAppliedAt: number
  setWorkspaceId: (workspaceId: string | null) => void
  // Starts the read-path engine if isSyncEnabled() is true; a no-op
  // otherwise (leaves `enabled: false`, `handle: null`) — safe to call
  // unconditionally from app bootstrap (src/store/projects.ts's init()).
  start: (db: Database, options?: SyncOptions) => void
  stop: () => void
  enqueueLocalMutation: (mutation: QueuedMutation) => void
  // Issue 048 — drains the pending queue to the write-path API. A no-op
  // (never touches the network) unless sync is enabled, the caller is
  // signed in, a workspace is resolvable, and there is something pending —
  // signed-out and sync=off stay byte-for-byte unchanged and network-free
  // (test-first plan #5). Safe to call repeatedly/concurrently: an
  // in-flight flush is skipped rather than doubled.
  flush: () => Promise<void>
}

export const useSyncStore = create<SyncState>()((set, get) => {
  // Recomputes the derived `status` (and clears a completed `reconnecting`
  // transition) from the store's current raw signals. Called after every
  // action that can move the needle — the pure decision itself lives in
  // src/domain/syncStatus.ts, this just feeds it live state.
  function recompute(): void {
    const s = get()
    const upToDate = s.upToDateTables.size >= SYNCED_TABLES.length
    // A reconnect completes only once BOTH the read-path has fully caught up
    // again AND the queue that accumulated while offline has drained — issue
    // 036 test-first plan #2 ("goes offline (queues N) → reconnecting →
    // synced, with the count draining to 0"). Clearing on `upToDate` alone
    // would report "synced" while pending writes are still in flight.
    const reconnecting = s.reconnecting && !(upToDate && s.pendingCount === 0)
    const status = deriveSyncStatus({
      enabled: s.enabled,
      online: s.online,
      hasError: s.hasError,
      reconnecting,
      upToDate,
      pendingCount: s.pendingCount,
    })
    set({ reconnecting, status })
  }

  return {
    enabled: false,
    handle: null,
    queue: emptyQueue(),
    pendingCount: 0,
    online: true,
    hasError: false,
    reconnecting: false,
    upToDateTables: new Set<TableName>(),
    status: 'disabled',
    workspaceId: null,
    flushing: false,
    invitationsAppliedAt: 0,
    membersAppliedAt: 0,

    setWorkspaceId(workspaceId) {
      set({ workspaceId })
      void get().flush()
    },

    start(db, callerOptions = {}) {
      if (!isSyncEnabled()) return
      // Issue 068 (Defect B) — the read-path was never authenticated: a
      // caller that doesn't inject its own getAuthToken (the one production
      // entry point, src/store/projects.ts, never has) fell through to
      // authToken.ts's `noAuth` deep inside syncEngine.ts, so every shape
      // request's Authorization header was empty and the shape proxy 401s
      // (src/server/shapeProxy/handler.ts). Mirror flush() below: default to
      // the real Cognito JWT via useAuthStore. A caller (or a test) that
      // injects its own getAuthToken keeps it as-is.
      const options: SyncOptions = {
        ...callerOptions,
        getAuthToken: callerOptions.getAuthToken ?? (() => useAuthStore.getState().getIdToken()),
      }
      // The read-path (Electric) needs a configured shape endpoint. Without
      // VITE_SYNC_URL — and no injected test streamFactory — the default
      // factory would build a shape URL from an empty base and throw
      // "Failed to construct 'URL': Invalid URL". Skip the read-path in that
      // case; the write flush (048) is independent and stays enabled via
      // isSyncEnabled() alone — see flush() below. As of issue 058, a real
      // Electric service is deployed behind VITE_SYNC_URL (the CloudFront
      // `/sync*` path, fronting the shape-proxy Lambda — never Electric
      // directly, see src/server/shapeProxy/), so this naturally starts
      // passing once that URL is populated in the deployed build — the
      // predicate itself (shouldSkipReadPath, src/sync/config.ts) is
      // unchanged from 051, still defensive rather than deleted.
      if (shouldSkipReadPath(Boolean(options.streamFactory))) return
      get().handle?.stop()
      set({
        enabled: true,
        online: initialOnline(),
        hasError: false,
        reconnecting: false,
        upToDateTables: new Set<TableName>(),
      })

      const handle = startSync(db, {
        ...options,
        onApplied: (table, deltas) => {
          options.onApplied?.(table, deltas)
          // Detect a lost local edit BEFORE reconciling — reconcileWithDeltas
          // acknowledges+prunes the matching queue entries (mutationQueue.ts
          // deliberately never compares row values; this is 036's own,
          // additional read of the same batch for UI purposes only).
          const lostEdits = detectLostEdits(get().queue, deltas)
          const queue = reconcileWithDeltas(get().queue, deltas)
          set({ queue, pendingCount: pendingCount(queue), hasError: false })
          // Issue 062 — a plain timestamp bump, not a counter: any store
          // subscribing to this only cares "did this change since I last
          // looked", which a monotonically-updated Date.now() answers just
          // as well as a counter, with no extra state to reset in lockstep.
          if (table === 'invitations') set({ invitationsAppliedAt: Date.now() })
          // Issue 067 — same bump, same rationale, for `workspace_members`.
          if (table === 'workspace_members') set({ membersAppliedAt: Date.now() })
          recompute()
          if (lostEdits.length > 0) {
            useStatusStore.getState().announce(lostEditMessage(lostEdits.length))
          }
        },
        onControl: (table, control) => {
          options.onControl?.(table, control)
          if (control === 'up-to-date') {
            const next = new Set(get().upToDateTables)
            next.add(table)
            set({ upToDateTables: next, hasError: false })
            recompute()
          }
        },
        onError: (table, error) => {
          options.onError?.(table, error)
          set({ hasError: true })
          recompute()
        },
      })

      if (typeof window !== 'undefined') {
        onlineHandler = () => {
          const wasOffline = !get().online
          set({
            online: true,
            reconnecting: wasOffline ? true : get().reconnecting,
            // Force a fresh catch-up check on reconnect — an up-to-date
            // reported before the drop doesn't prove the shape is still
            // caught up after it (test-first plan #2).
            upToDateTables: wasOffline ? new Set<TableName>() : get().upToDateTables,
          })
          recompute()
          // Issue 048 test-first plan #3 — flush-on-reconnect: drain
          // whatever backed up in the queue while offline. flush() itself
          // is the no-op gate (sync off / signed out / no workspace), so
          // this is always safe to call.
          resetBackoff()
          void get().flush()
        }
        offlineHandler = () => {
          set({ online: false })
          recompute()
        }
        window.addEventListener('online', onlineHandler)
        window.addEventListener('offline', offlineHandler)
      }

      set({ handle })
      recompute()
    },

    stop() {
      get().handle?.stop()
      if (typeof window !== 'undefined') {
        if (onlineHandler) window.removeEventListener('online', onlineHandler)
        if (offlineHandler) window.removeEventListener('offline', offlineHandler)
      }
      onlineHandler = null
      offlineHandler = null
      clearFlushTimer()
      resetBackoff()
      set({ enabled: false, handle: null })
      recompute()
    },

    enqueueLocalMutation(mutation) {
      const queue = enqueue(get().queue, mutation)
      set({ queue, pendingCount: pendingCount(queue) })
      recompute()
      // Issue 048 — flush promptly after a local write is queued; flush()
      // is a no-op unless sync is on, the caller is signed in, and a
      // workspace is resolvable (test-first plan #5).
      void get().flush()
    },

    async flush() {
      if (!isSyncEnabled()) return
      if (useAuthStore.getState().status !== 'authenticated') return
      if (get().flushing) return
      const { queue, workspaceId } = get()
      if (workspaceId === null || pending(queue).length === 0) return

      set({ flushing: true })
      clearFlushTimer()
      let result
      try {
        result = await flushMutations(queue, workspaceId, {
          httpClient: defaultHttpClient,
          getAuthHeaders,
          path: writeApiPath(),
        })
      } finally {
        set({ flushing: false })
      }

      if (result.kind === 'skipped') return

      if (result.kind === 'network-error') {
        scheduleFlushRetry(() => get().flush())
        return
      }

      if (result.kind === 'auth-rejected') {
        useStatusStore.getState().announce(result.rejection.message)
        scheduleFlushRetry(() => get().flush())
        return
      }

      // result.kind === 'applied' — the round trip itself succeeded, so
      // reset backoff even if some individual mutations were rejected.
      resetBackoff()
      let nextQueue = get().queue
      for (const id of result.acknowledgedIds) nextQueue = acknowledge(nextQueue, id)
      nextQueue = prune(nextQueue)
      // Rejection reconciliation (test-first plan #4): drop the rejected
      // entry from the local queue (mutationQueue.ts's own documented
      // rollback-on-reject seam) and surface a calm status-bar error (015
      // style) — never a toast. The command log (006) is untouched here,
      // exactly like every other sync-store action (test-first plan #5 in
      // issue 036: "the sync store never touches the command log").
      for (const rejection of result.rejections) {
        nextQueue = rejectMutation(nextQueue, rejection.mutationId)
      }
      set({ queue: nextQueue, pendingCount: pendingCount(nextQueue) })
      recompute()
      if (result.rejections.length > 0) {
        const last = result.rejections[result.rejections.length - 1]
        if (last) useStatusStore.getState().announce(last.message)
      }

      // More work may remain (the queue grew mid-flush, or this batch only
      // partially drained) — keep draining until a flush finds nothing left.
      if (pending(get().queue).length > 0) void get().flush()
    },
  }
})

export function resetSyncStore(): void {
  useSyncStore.getState().handle?.stop()
  if (typeof window !== 'undefined') {
    if (onlineHandler) window.removeEventListener('online', onlineHandler)
    if (offlineHandler) window.removeEventListener('offline', offlineHandler)
  }
  onlineHandler = null
  offlineHandler = null
  clearFlushTimer()
  resetBackoff()
  useSyncStore.setState({
    enabled: false,
    handle: null,
    queue: emptyQueue(),
    pendingCount: 0,
    online: true,
    hasError: false,
    reconnecting: false,
    upToDateTables: new Set<TableName>(),
    status: 'disabled',
    workspaceId: null,
    flushing: false,
    invitationsAppliedAt: 0,
    membersAppliedAt: 0,
  })
}
