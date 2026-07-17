// Issue 036 (sync state + offline reconciliation UI) — the pure state
// machine + copy this issue renders. Like syncDelta.ts/mutationQueue.ts (032),
// this module is DB/store/React-free: src/store/sync.ts owns wiring it to the
// live engine's callbacks and browser online/offline events; src/shell's
// SyncIndicator only ever reads the derived SyncStatus + label, never
// recomputes it — so the state machine itself is unit-tested in isolation.
import type { MutationQueue } from './mutationQueue'
import type { RowDelta, TableName } from './syncDelta'

export type SyncStatus =
  | 'disabled'
  | 'offline'
  | 'reconnecting'
  | 'syncing'
  | 'error'
  | 'write-stalled'
  | 'synced'

// Issue 086 — a genuine read error must stay unresolved this long before the
// "Sync error" banner surfaces. The observed flicker (docs/issues/086: boot-
// race 401s, aborted long-polls, and the boot-time cross-table FK race) all
// self-heal within 1–3s, so a ~5s debounce keeps the footer calm through them
// while still surfacing a sustained failure. Tuning knob, not a contract —
// see the issue's "Open tension" note.
export const SYNC_ERROR_GRACE_MS = 5000

// Issue 087 — the WRITE-side mirror of SYNC_ERROR_GRACE_MS above. A genuine
// write-outbox failure (expired token, server 5xx, write API down) must stay
// unresolved this long before the "Changes not saving" status surfaces, so a
// single transient flush blip that a backoff retry resolves within a second or
// two never flashes it. Same tuning-knob philosophy as the read grace, kept a
// DISTINCT constant so the two windows can diverge without entangling 086/087.
export const WRITE_STALL_GRACE_MS = 5000

export interface SyncStatusInput {
  // Whether the sync engine is running at all (isSyncEnabled(), issue 032).
  // v1's default — the indicator doesn't mount when this is false (no status
  // to be honest or dishonest about).
  readonly enabled: boolean
  // Browser network reachability (navigator.onLine + online/offline events).
  readonly online: boolean
  // Issue 086 — the timestamp (ms) the current GENUINE, still-unresolved read
  // error began, or `null` when there is none. Transient/boot-race read blips
  // (src/sync/syncEngine.ts's isIgnorableReadError) never set this; a real
  // apply/parse failure does. Kept as data (not a live clock read) so this
  // function stays pure and unit-testable. Cleared to `null` by the store on
  // the next successful onApplied/onControl. Replaces 036's `hasError`.
  readonly errorSince: number | null
  // Issue 087 — the timestamp (ms) the current sustained WRITE-outbox failure
  // began, or `null` when the outbox is healthy. Set by the store the first
  // time a flush() fails to reach the server (network-error / auth-rejected,
  // src/store/sync.ts) and cleared the moment a flush lands — the write twin of
  // `errorSince` above. Kept as data (not a live clock read) so this function
  // stays pure. Only surfaces past WRITE_STALL_GRACE_MS AND with a real backlog
  // (pendingCount > 0): an empty outbox has nothing unsaved to warn about.
  readonly writeStalledSince: number | null
  // Issue 086 — the current wall-clock time (ms), passed in by the caller so
  // the grace-window comparison below is a pure function of its inputs (the
  // store plumbs `Date.now()`; tests pass a fixed value / fake-timer clock).
  readonly now: number
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
  // Issue 087 — a SUSTAINED write-outbox failure with edits still unsaved is
  // the most urgent honest signal short of being offline: the user's changes
  // are genuinely not reaching the server (worse than a read stall — that only
  // delays inbound updates). Surfaces only once the failure has persisted the
  // full grace window AND a real backlog remains; within the grace, or with an
  // already-drained outbox, it falls through to calm activity below. Ranked
  // above the read `error` so "Changes not saving" wins when both are true.
  if (
    input.writeStalledSince !== null &&
    input.pendingCount > 0 &&
    input.now - input.writeStalledSince >= WRITE_STALL_GRACE_MS
  )
    return 'write-stalled'
  // Issue 086 — only surface the banner once a genuine error has stayed
  // unresolved for the full grace window; within it, fall through to calm
  // activity below (never an instant flash).
  if (input.errorSince !== null && input.now - input.errorSince >= SYNC_ERROR_GRACE_MS) return 'error'
  if (input.reconnecting) return 'reconnecting'
  if (!input.upToDate || input.pendingCount > 0) return 'syncing'
  // Issue 086 — a still-debouncing error (within grace) means something IS in
  // flight; reporting 'synced' here would be reassuring-over-truthful. Report
  // calm activity ('syncing') instead until it either clears or surfaces.
  if (input.errorSince !== null) return 'syncing'
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
    // Issue 087 — a DISTINCT, specific label from the read 'error' above: this
    // one names the actual consequence (the user's edits aren't reaching the
    // server), per STYLE_GUIDE §9 ("say what happened"). Quiet and numerate —
    // the pending count already rides the adjacent chrome, so no count here.
    case 'write-stalled':
      return 'Changes not saving'
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
