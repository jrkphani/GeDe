import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { deriveSyncStatus, detectLostEdits, lostEditMessage, syncStatusLabel } from './syncStatus'
import { emptyQueue, enqueue, type QueuedMutation } from './mutationQueue'
import type { RowDelta } from './syncDelta'

// Issue 036, test-first plan #1: given each sync state 032 exposes, the pure
// derivation picks the correct status. This module is DB/store/React-free —
// like syncDelta.ts/mutationQueue.ts — so the state machine itself is
// unit-tested in isolation from the store wiring (src/store/sync.ts) and the
// UI (src/shell/SyncIndicator.tsx).

function input(overrides: Partial<Parameters<typeof deriveSyncStatus>[0]> = {}) {
  return {
    enabled: true,
    online: true,
    hasError: false,
    reconnecting: false,
    upToDate: true,
    pendingCount: 0,
    ...overrides,
  }
}

describe('deriveSyncStatus — state mapping (test-first plan #1)', () => {
  it('sync not enabled (v1 default) -> disabled, regardless of other flags', () => {
    expect(deriveSyncStatus(input({ enabled: false, hasError: true, online: false }))).toBe(
      'disabled',
    )
  })

  it('enabled + fully caught up + nothing pending -> synced', () => {
    expect(deriveSyncStatus(input())).toBe('synced')
  })

  it('enabled + browser offline -> offline, even if an error is also latent', () => {
    expect(deriveSyncStatus(input({ online: false, hasError: true }))).toBe('offline')
  })

  it('enabled + online + a batch failed to apply -> error', () => {
    expect(deriveSyncStatus(input({ hasError: true }))).toBe('error')
  })

  it('enabled + online + first catch-up not finished yet -> syncing', () => {
    expect(deriveSyncStatus(input({ upToDate: false }))).toBe('syncing')
  })

  it('enabled + online + local writes still pending acknowledgement -> syncing', () => {
    expect(deriveSyncStatus(input({ pendingCount: 3 }))).toBe('syncing')
  })

  it('enabled + online + reconnecting flag set (post-offline catch-up) -> reconnecting', () => {
    expect(deriveSyncStatus(input({ reconnecting: true, upToDate: false, pendingCount: 2 }))).toBe(
      'reconnecting',
    )
  })

  it('reconnecting takes priority over plain syncing while both are true', () => {
    expect(deriveSyncStatus(input({ reconnecting: true, upToDate: false }))).toBe('reconnecting')
  })

  it('an error while reconnecting is still truthfully reported as error', () => {
    expect(deriveSyncStatus(input({ reconnecting: true, hasError: true }))).toBe('error')
  })
})

describe('syncStatusLabel — numerate voice (STYLE_GUIDE §9)', () => {
  it('synced', () => {
    expect(syncStatusLabel('synced', 0)).toBe('Synced')
  })
  it('syncing', () => {
    expect(syncStatusLabel('syncing', 0)).toBe('Syncing…')
  })
  it('offline shows the pending count', () => {
    expect(syncStatusLabel('offline', 3)).toBe('Offline · 3 pending')
    expect(syncStatusLabel('offline', 0)).toBe('Offline · 0 pending')
  })
  it('reconnecting', () => {
    expect(syncStatusLabel('reconnecting', 1)).toBe('Reconnecting…')
  })
  it('error', () => {
    expect(syncStatusLabel('error', 0)).toBe('Sync error')
  })
  it('disabled renders no text (the indicator does not mount at all)', () => {
    expect(syncStatusLabel('disabled', 0)).toBe('')
  })
})

function mutation(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
  return {
    id: uuidv7(),
    table: 'contexts',
    rowId: 'ctx-1',
    op: 'upsert',
    row: { id: 'ctx-1', symbol: 'α', name: 'Stake' },
    optimisticUpdatedAt: '2026-01-01T00:00:01.000Z',
    enqueuedAt: '2026-01-01T00:00:01.000Z',
    status: 'pending',
    ...overrides,
  }
}

function delta(overrides: Partial<RowDelta> = {}): RowDelta {
  return {
    table: 'contexts',
    id: 'ctx-1',
    row: { id: 'ctx-1', symbol: 'α', name: 'Stake' },
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  }
}

describe('detectLostEdits — conflict surfacing (test-first plan #3)', () => {
  it('the authoritative echo of the exact write the client just made is NOT a lost edit', () => {
    const queue = enqueue(emptyQueue(), mutation())
    const notes = detectLostEdits(queue, [delta({ updatedAt: '2026-01-01T00:00:02.000Z' })])
    expect(notes).toEqual([])
  })

  it('a strictly newer authoritative delta whose shared fields differ IS a lost edit', () => {
    const queue = enqueue(emptyQueue(), mutation())
    const notes = detectLostEdits(queue, [
      delta({ row: { id: 'ctx-1', symbol: 'α', name: 'Someone else' }, updatedAt: '2026-01-01T00:00:02.000Z' }),
    ])
    expect(notes).toEqual([{ table: 'contexts', rowId: 'ctx-1' }])
  })

  it('extra columns present only on the authoritative row (not part of the local write) never count as a conflict', () => {
    const queue = enqueue(
      emptyQueue(),
      mutation({ row: { id: 'ctx-1', symbol: 'α' } }),
    )
    const notes = detectLostEdits(queue, [
      delta({
        row: { id: 'ctx-1', symbol: 'α', name: 'unrelated field the write never touched' },
        updatedAt: '2026-01-01T00:00:02.000Z',
      }),
    ])
    expect(notes).toEqual([])
  })

  it('a delta no newer than the optimistic write is never a conflict', () => {
    const queue = enqueue(emptyQueue(), mutation())
    const notes = detectLostEdits(queue, [
      delta({ row: { id: 'ctx-1', symbol: 'α', name: 'Someone else' }, updatedAt: '2026-01-01T00:00:01.000Z' }),
    ])
    expect(notes).toEqual([])
  })

  it('already-acknowledged entries are ignored', () => {
    const queue = enqueue(emptyQueue(), mutation({ status: 'acknowledged' }))
    const notes = detectLostEdits(queue, [
      delta({ row: { id: 'ctx-1', symbol: 'α', name: 'Someone else' }, updatedAt: '2026-01-01T00:00:02.000Z' }),
    ])
    expect(notes).toEqual([])
  })

  it('a delta for a different table/row never matches', () => {
    const queue = enqueue(emptyQueue(), mutation())
    const notes = detectLostEdits(queue, [
      delta({ table: 'dimensions', id: 'ctx-1', updatedAt: '2026-01-01T00:00:02.000Z' }),
      delta({ table: 'contexts', id: 'other-row', updatedAt: '2026-01-01T00:00:02.000Z' }),
    ])
    expect(notes).toEqual([])
  })
})

describe('lostEditMessage — quiet, numerate note (STYLE_GUIDE §9, never a modal)', () => {
  it('no notes -> empty string', () => {
    expect(lostEditMessage(0)).toBe('')
  })
  it('singular', () => {
    expect(lostEditMessage(1)).toBe('A local change was replaced by a newer update.')
  })
  it('plural, numerate', () => {
    expect(lostEditMessage(3)).toBe('3 local changes were replaced by newer updates.')
  })
})
