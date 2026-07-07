// Issue 036 (sync state + offline reconciliation UI) — the pure state
// machine + copy this issue renders. Like syncDelta.ts/mutationQueue.ts (032),
// this module is DB/store/React-free: src/store/sync.ts owns wiring it to the
// live engine's callbacks and browser online/offline events; src/shell's
// SyncIndicator only ever reads the derived SyncStatus + label, never
// recomputes it — so the state machine itself is unit-tested in isolation.
import type { MutationQueue } from './mutationQueue'
import type { RowDelta, TableName } from './syncDelta'

export type SyncStatus = 'disabled' | 'offline' | 'reconnecting' | 'syncing' | 'error' | 'synced'

export interface SyncStatusInput {
  // Whether the sync engine is running at all (isSyncEnabled(), issue 032).
  // v1's default — the indicator doesn't mount when this is false (no status
  // to be honest or dishonest about).
  readonly enabled: boolean
  // Browser network reachability (navigator.onLine + online/offline events).
  readonly online: boolean
  // A batch failed to apply, or a message failed to normalize, since the
  // last successful apply/control message (src/sync/syncEngine.ts's
  // onError). Self-heals on the next successful onApplied/onControl.
  readonly hasError: boolean
  // Set the moment the browser comes back online after having gone offline,
  // cleared once the engine has both caught up (upToDate) and drained the
  // local queue (pendingCount === 0). Distinguishes "just reconnected, still
  // catching up" from ordinary mid-session "syncing" (test-first plan #2).
  readonly reconnecting: boolean
  // True once every synced table (src/sync/config.ts's SYNCED_TABLES) has
  // reported Electric's `up-to-date` control message at least once since the
  // engine last (re)started or reconnected.
  readonly upToDate: boolean
  // Locally-queued optimistic writes not yet reconciled with an authoritative
  // delta (src/domain/mutationQueue.ts).
  readonly pendingCount: number
}

// Priority order (most to least urgent), each returned unconditionally once
// its guard is met — "truthful over reassuring" (issue design brief): never
// report `synced` while any of these are still true.
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  if (!input.enabled) return 'disabled'
  if (!input.online) return 'offline'
  if (input.hasError) return 'error'
  if (input.reconnecting) return 'reconnecting'
  if (!input.upToDate || input.pendingCount > 0) return 'syncing'
  return 'synced'
}

// Numerate voice (STYLE_GUIDE §9) — the issue's own quoted examples, verbatim.
export function syncStatusLabel(status: SyncStatus, pendingCount: number): string {
  switch (status) {
    case 'disabled':
      return ''
    case 'synced':
      return 'Synced'
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return `Offline · ${pendingCount} pending`
    case 'reconnecting':
      return 'Reconnecting…'
    case 'error':
      return 'Sync error'
  }
}

export interface LostEditNote {
  readonly table: TableName
  readonly rowId: string
}

// A pending mutation's optimistic row only carries the fields the local write
// actually touched (see mutationQueue.ts's QueuedMutation.row doc) — an
// authoritative row snapshot always carries every base column, so comparing
// full-row equality would false-positive on every ordinary echo. Comparing
// only the shared keys the local write set is what makes this a genuine
// conflict detector rather than a diff of unrelated columns.
function sharedKeysMatch(
  optimisticRow: Readonly<Record<string, unknown>>,
  authoritativeRow: Readonly<Record<string, unknown>>,
): boolean {
  return Object.keys(optimisticRow).every((key) => authoritativeRow[key] === optimisticRow[key])
}

// Surfaces a *lost* local edit (design brief: LWW resolves silently by
// default, but a local write actually overwritten by a newer remote one gets
// a quiet note — never a modal, never a blocking conflict-resolution UI,
// that's explicitly out of scope). Deliberately separate from
// mutationQueue.ts's reconcileWithDelta, which never compares row VALUES by
// design (043/ADR-0010 owns deciding an LWW winner) — this only DETECTS, for
// UI purposes, that the round-trip echo differs from what was sent.
export function detectLostEdits(
  queue: MutationQueue,
  deltas: readonly RowDelta[],
): LostEditNote[] {
  const notes: LostEditNote[] = []
  for (const delta of deltas) {
    for (const entry of queue.entries) {
      if (entry.status !== 'pending') continue
      if (entry.table !== delta.table || entry.rowId !== delta.id) continue
      if (!(delta.updatedAt > entry.optimisticUpdatedAt)) continue
      if (sharedKeysMatch(entry.row, delta.row)) continue
      notes.push({ table: delta.table, rowId: entry.rowId })
    }
  }
  return notes
}

// Numerate, no exclamation (STYLE_GUIDE §9) — one quiet status-bar note
// (useStatusStore.announce), never a toast or modal.
export function lostEditMessage(count: number): string {
  if (count <= 0) return ''
  if (count === 1) return 'A local change was replaced by a newer update.'
  return `${count} local changes were replaced by newer updates.`
}
