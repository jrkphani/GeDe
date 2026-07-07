import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import {
  acknowledge,
  emptyQueue,
  enqueue,
  pending,
  pendingCount,
  prune,
  reconcileWithDelta,
  reconcileWithDeltas,
  rejectMutation,
  type QueuedMutation,
} from './mutationQueue'
import type { RowDelta } from './syncDelta'

function mutation(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
  return {
    id: uuidv7(),
    table: 'contexts',
    rowId: 'ctx-1',
    op: 'upsert',
    row: { id: 'ctx-1', symbol: 'α' },
    optimisticUpdatedAt: '2026-01-01T00:00:01.000Z',
    enqueuedAt: '2026-01-01T00:00:01.000Z',
    status: 'pending',
    ...overrides,
  }
}

describe('mutation queue — enqueue (UUIDv7 idempotency)', () => {
  it('adds a new mutation', () => {
    const m = mutation()
    const queue = enqueue(emptyQueue(), m)
    expect(pending(queue)).toEqual([m])
  })

  it('re-enqueuing the same mutation id replaces it in place, never duplicates', () => {
    const id = uuidv7()
    let queue = emptyQueue()
    queue = enqueue(queue, mutation({ id, row: { id: 'ctx-1', symbol: 'α' } }))
    queue = enqueue(queue, mutation({ id, row: { id: 'ctx-1', symbol: 'α-retry' } }))
    expect(queue.entries).toHaveLength(1)
    expect(queue.entries[0]?.row.symbol).toBe('α-retry')
  })

  it('distinct mutation ids for the same row both queue (043 may batch)', () => {
    let queue = emptyQueue()
    queue = enqueue(queue, mutation({ id: uuidv7() }))
    queue = enqueue(queue, mutation({ id: uuidv7() }))
    expect(queue.entries).toHaveLength(2)
  })
})

describe('acknowledge / prune', () => {
  it('acknowledge flips status without removing; prune then drops it', () => {
    const m = mutation()
    let queue = enqueue(emptyQueue(), m)
    expect(pendingCount(queue)).toBe(1)
    queue = acknowledge(queue, m.id)
    expect(queue.entries).toHaveLength(1)
    expect(queue.entries[0]?.status).toBe('acknowledged')
    expect(pendingCount(queue)).toBe(0)
    queue = prune(queue)
    expect(queue.entries).toHaveLength(0)
  })

  it('rejectMutation drops the entry outright (rollback-on-reject seam)', () => {
    const m = mutation()
    let queue = enqueue(emptyQueue(), m)
    queue = rejectMutation(queue, m.id)
    expect(queue.entries).toHaveLength(0)
  })
})

describe('reconcileWithDelta — reconciliation, not resolution (test-first plan #1/#5)', () => {
  it('an authoritative delta at least as new as the optimistic write resolves (drops) the queue entry', () => {
    const m = mutation({ optimisticUpdatedAt: '2026-01-01T00:00:01.000Z' })
    let queue = enqueue(emptyQueue(), m)
    const authoritative: RowDelta = {
      table: 'contexts',
      id: 'ctx-1',
      row: { id: 'ctx-1', symbol: 'α' },
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    queue = reconcileWithDelta(queue, authoritative)
    expect(queue.entries).toHaveLength(0)
  })

  it('does not adjudicate value — resolves the entry even if the authoritative row differs (client accepts it, ADR-0010)', () => {
    const m = mutation({ row: { id: 'ctx-1', symbol: 'α-local' } })
    let queue = enqueue(emptyQueue(), m)
    const authoritative: RowDelta = {
      table: 'contexts',
      id: 'ctx-1',
      row: { id: 'ctx-1', symbol: 'β-server-truth' },
      updatedAt: '2026-01-01T00:00:05.000Z',
    }
    queue = reconcileWithDelta(queue, authoritative)
    expect(queue.entries).toHaveLength(0)
  })

  it('a delta strictly OLDER than the optimistic write resolves nothing (round-trip for THIS write hasn’t arrived)', () => {
    const m = mutation({ optimisticUpdatedAt: '2026-01-01T00:00:10.000Z' })
    let queue = enqueue(emptyQueue(), m)
    const stale: RowDelta = {
      table: 'contexts',
      id: 'ctx-1',
      row: { id: 'ctx-1', symbol: 'stale' },
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    queue = reconcileWithDelta(queue, stale)
    expect(pendingCount(queue)).toBe(1)
  })

  it('a delta for an unrelated row leaves the queue untouched', () => {
    const m = mutation({ rowId: 'ctx-1' })
    let queue = enqueue(emptyQueue(), m)
    const other: RowDelta = {
      table: 'contexts',
      id: 'ctx-2',
      row: { id: 'ctx-2', symbol: 'β' },
      updatedAt: '2026-01-01T00:00:10.000Z',
    }
    queue = reconcileWithDelta(queue, other)
    expect(pendingCount(queue)).toBe(1)
  })

  it('reconcileWithDeltas folds a batch, resolving every matching entry', () => {
    let queue = emptyQueue()
    queue = enqueue(queue, mutation({ id: uuidv7(), rowId: 'ctx-1', optimisticUpdatedAt: '2026-01-01T00:00:01.000Z' }))
    queue = enqueue(queue, mutation({ id: uuidv7(), rowId: 'ctx-2', optimisticUpdatedAt: '2026-01-01T00:00:01.000Z' }))
    const deltas: RowDelta[] = [
      { table: 'contexts', id: 'ctx-1', row: { id: 'ctx-1' }, updatedAt: '2026-01-01T00:00:02.000Z' },
      { table: 'contexts', id: 'ctx-2', row: { id: 'ctx-2' }, updatedAt: '2026-01-01T00:00:02.000Z' },
    ]
    queue = reconcileWithDeltas(queue, deltas)
    expect(queue.entries).toHaveLength(0)
  })
})

describe('undo/redo isolation (test-first plan #5)', () => {
  it('reconciling a delta never touches anything outside the queue itself (pure, no shared mutable state)', () => {
    const m = mutation()
    const before = enqueue(emptyQueue(), m)
    const authoritative: RowDelta = {
      table: 'contexts',
      id: 'ctx-1',
      row: { id: 'ctx-1', symbol: 'α' },
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    const after = reconcileWithDelta(before, authoritative)
    // The input queue object is untouched — a remote delta reconciling mid-session
    // cannot mutate any other structure (e.g. the command log) out from under it.
    expect(before.entries).toHaveLength(1)
    expect(after.entries).toHaveLength(0)
  })
})
