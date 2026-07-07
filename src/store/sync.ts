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
import { startSync, type SyncHandle, type SyncOptions } from '../sync/syncEngine'
import { isSyncEnabled } from '../sync/config'

// The store-layer seam for issue 032's read-path + optimistic-write queue:
// owns the queue's runtime state and the sync engine's lifecycle, gated by
// isSyncEnabled() (default OFF — v1's single-user path is the tested
// default, test-first plan #6). This is the state a future sync-status UI
// (issue 036) reads; 032 exposes it, 036 renders it — no UI is built here.
//
// Session-scoped, not persisted — mirrors useCommandLogStore (issue 006):
// the queue and the command log are independent structures (test-first plan
// #5 — a remote delta reconciling mid-session must never touch undo/redo),
// so this store never imports or calls useCommandLogStore.

interface SyncState {
  enabled: boolean
  handle: SyncHandle | null
  queue: MutationQueue
  pendingCount: number
  // Starts the read-path engine if isSyncEnabled() is true; a no-op
  // otherwise (leaves `enabled: false`, `handle: null`) — safe to call
  // unconditionally from app bootstrap (src/store/projects.ts's init()).
  start: (db: Database, options?: SyncOptions) => void
  stop: () => void
  enqueueLocalMutation: (mutation: QueuedMutation) => void
}

export const useSyncStore = create<SyncState>()((set, get) => ({
  enabled: false,
  handle: null,
  queue: emptyQueue(),
  pendingCount: 0,

  start(db, options = {}) {
    if (!isSyncEnabled()) return
    get().handle?.stop()
    const handle = startSync(db, {
      ...options,
      onApplied: (table, deltas) => {
        options.onApplied?.(table, deltas)
        const queue = reconcileWithDeltas(get().queue, deltas)
        set({ queue, pendingCount: pendingCount(queue) })
      },
    })
    set({ enabled: true, handle })
  },

  stop() {
    get().handle?.stop()
    set({ enabled: false, handle: null })
  },

  enqueueLocalMutation(mutation) {
    const queue = enqueue(get().queue, mutation)
    set({ queue, pendingCount: pendingCount(queue) })
  },
}))

export function resetSyncStore(): void {
  useSyncStore.getState().handle?.stop()
  useSyncStore.setState({ enabled: false, handle: null, queue: emptyQueue(), pendingCount: 0 })
}
