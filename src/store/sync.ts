import { create } from 'zustand'
import type { Database } from '../db/client'
import {
  emptyQueue,
  enqueue,
  pendingCount,
  reconcileWithDeltas,
  type MutationQueue,
  type QueuedMutation,
} from '../domain/mutationQueue'
import { deriveSyncStatus, detectLostEdits, lostEditMessage, type SyncStatus } from '../domain/syncStatus'
import type { TableName } from '../domain/syncDelta'
import { startSync, type SyncHandle, type SyncOptions } from '../sync/syncEngine'
import { isSyncEnabled, SYNCED_TABLES } from '../sync/config'
import { useStatusStore } from './status'

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
  // Starts the read-path engine if isSyncEnabled() is true; a no-op
  // otherwise (leaves `enabled: false`, `handle: null`) — safe to call
  // unconditionally from app bootstrap (src/store/projects.ts's init()).
  start: (db: Database, options?: SyncOptions) => void
  stop: () => void
  enqueueLocalMutation: (mutation: QueuedMutation) => void
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

    start(db, options = {}) {
      if (!isSyncEnabled()) return
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
      set({ enabled: false, handle: null })
      recompute()
    },

    enqueueLocalMutation(mutation) {
      const queue = enqueue(get().queue, mutation)
      set({ queue, pendingCount: pendingCount(queue) })
      recompute()
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
  })
}
