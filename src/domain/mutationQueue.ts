// The client optimistic-write queue's DATA STRUCTURE (issue 032, ADR-0010).
// Pure and store/DB-free, like syncDelta.ts. This module owns exactly what the
// issue pins as "the integration contract between 032 and 043": a queued
// mutation is keyed by a UUIDv7 id (the idempotency key 043's replay protocol
// dedupes on), carries the row it optimistically wrote, and is resolved
// (acknowledged, then dropped) once an authoritative delta for the same row
// comes back on the read-path stream (src/domain/syncDelta.ts) with an
// updatedAt at least as new as when the mutation was enqueued.
//
// What this module deliberately does NOT do (out of scope, 043's job per
// ADR-0010): decide whether a write is legal, authenticate it, or pick an LWW
// winner on conflict. 032 "asserts the client accepts whatever authoritative
// delta arrives" (test-first plan #1) — reconcileWithDelta below does exactly
// that: it never compares row VALUES, only whether the round-trip completed.
import type { RowDelta, TableName } from './syncDelta'

// Issue 066 — 'update' joins 'upsert'/'delete' as its own explicit op for a
// producer that edits an ALREADY-SYNCED row in place (e.g. resendInvitation's
// expires_at bump) rather than either creating a fresh row or tombstoning
// one. This matters because src/sync/writeTransport.ts's toMutationEnvelope
// maps 'upsert' to the wire protocol's 'insert' (`ON CONFLICT (id) DO
// NOTHING`) — sending an existing row's edit as 'upsert' would silently
// no-op server-side instead of applying it. 'upsert' itself is unchanged
// (still maps to 'insert') for every pre-066 producer (invite/changeRole/
// removeMember/acceptInvitation) — see that module's own KNOWN LIMITATION
// note for the pre-existing producers this doesn't retroactively fix.
export type MutationOp = 'upsert' | 'update' | 'delete'

export interface QueuedMutation {
  // UUIDv7 — the 043 replay protocol's idempotency key. Re-enqueuing the same
  // id (e.g. a retried optimistic write) replaces the existing entry rather
  // than duplicating it (enqueue below), matching "idempotency via UUIDv7"
  // from the issue's scope line.
  readonly id: string
  readonly table: TableName
  // The domain row's own id — distinct from `id` above (043 may batch several
  // queued mutations that touch the same row; reconciliation below matches on
  // this, not on the mutation id).
  readonly rowId: string
  readonly op: MutationOp
  readonly row: Readonly<Record<string, unknown>>
  // The row's own updatedAt at the moment of the optimistic local write —
  // reconciliation resolves the entry once an authoritative delta for the
  // same rowId arrives with an updatedAt at least this new (the server has
  // seen a version at least as current as this write).
  readonly optimisticUpdatedAt: string
  readonly enqueuedAt: string
  readonly status: 'pending' | 'acknowledged'
  /**
   * Issue 057 — an explicit per-mutation workspace override. `useSyncStore`
   * scopes an entire flush to ONE global `workspaceId` (the signed-in sub's
   * own personal workspace, `sync.ts`'s "the workspace a flush's
   * MutationEnvelopes are scoped to") — that global is wrong for the one
   * mutation a multi-workspace member can enqueue that does NOT belong to
   * their own workspace: `acceptInvitation`'s seat mutation, which must land
   * in the INVITER's workspace. When set, `toMutationEnvelope`
   * (src/sync/writeTransport.ts) uses this instead of the flush's global
   * `workspaceId`. Omitted (undefined) for every other producer today
   * (invite/changeRole/removeMember, adoptProject, …), which all legitimately
   * target the currently-open/own workspace and keep relying on the global.
   */
  readonly workspaceId?: string
}

export interface MutationQueue {
  readonly entries: readonly QueuedMutation[]
}

export function emptyQueue(): MutationQueue {
  return { entries: [] }
}

// Idempotent enqueue (UUIDv7 idempotency, issue scope line): re-enqueuing the
// same mutation id replaces the existing entry in place rather than
// duplicating it, so a retried optimistic write never double-queues.
export function enqueue(queue: MutationQueue, mutation: QueuedMutation): MutationQueue {
  const withoutExisting = queue.entries.filter((e) => e.id !== mutation.id)
  return { entries: [...withoutExisting, mutation] }
}

export function pending(queue: MutationQueue): readonly QueuedMutation[] {
  return queue.entries.filter((e) => e.status === 'pending')
}

export function pendingCount(queue: MutationQueue): number {
  return pending(queue).length
}

// Mark a mutation acknowledged in place (kept, not dropped) — the seam a
// future sync-status UI (issue 036) could use to distinguish "queued" from
// "sent, awaiting the authoritative echo" before it's pruned.
export function acknowledge(queue: MutationQueue, id: string): MutationQueue {
  return {
    entries: queue.entries.map((e) => (e.id === id ? { ...e, status: 'acknowledged' } : e)),
  }
}

// Drop every acknowledged entry — nothing downstream needs a resolved
// mutation once its row is durably applied locally.
export function prune(queue: MutationQueue): MutationQueue {
  return { entries: queue.entries.filter((e) => e.status !== 'acknowledged') }
}

// Rollback-on-reject seam (issue scope line: "043 owns the replay protocol …
// rollback-on-reject"). 032 doesn't decide WHEN a mutation is rejected — no
// reject signal exists yet without 043 — but the queue's shape must support
// it: dropping a rejected entry here is what a future 043 client would call
// after it discards the optimistic write and reconciles to the authoritative
// row (which arrives separately via the normal read-path delta).
export function rejectMutation(queue: MutationQueue, id: string): MutationQueue {
  return { entries: queue.entries.filter((e) => e.id !== id) }
}

// Reconciliation, not resolution (issue design brief): an authoritative delta
// resolves every queued mutation for the same (table, rowId) whose optimistic
// write is no newer than the delta — the client does not adjudicate WHICH
// value wins (that's 043/DB, ADR-0010), it just recognizes the round-trip
// completed, acknowledges, and prunes the local queue entry. A delta strictly
// OLDER than the mutation's own optimistic timestamp resolves nothing (the
// authoritative round-trip for THIS write hasn't arrived yet).
export function reconcileWithDelta(queue: MutationQueue, authoritative: RowDelta): MutationQueue {
  const acknowledged = queue.entries.reduce((q, entry) => {
    const matches = entry.table === authoritative.table && entry.rowId === authoritative.id
    const resolved = matches && authoritative.updatedAt >= entry.optimisticUpdatedAt
    return resolved ? acknowledge(q, entry.id) : q
  }, queue)
  return prune(acknowledged)
}

export function reconcileWithDeltas(
  queue: MutationQueue,
  deltas: readonly RowDelta[],
): MutationQueue {
  return deltas.reduce(reconcileWithDelta, queue)
}
