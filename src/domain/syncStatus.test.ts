import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import {
  deriveSyncStatus,
  detectLostEdits,
  lostEditMessage,
  syncStatusLabel,
  SYNC_ERROR_GRACE_MS,
} from './syncStatus'
import { emptyQueue, enqueue, type QueuedMutation } from './mutationQueue'
import type { RowDelta } from './syncDelta'

// Issue 036, test-first plan #1: given each sync state 032 exposes, the pure
// derivation picks the correct status. This module is DB/store/React-free —
// like syncDelta.ts/mutationQueue.ts — so the state machine itself is
// unit-tested in isolation from the store wiring (src/store/sync.ts) and the
// UI (src/shell/SyncIndicator.tsx).
//
// Issue 086 — `hasError: boolean` was replaced by `errorSince: number | null`
// + `now: number` so the "Sync error" banner debounces: a genuine read error
// only surfaces once it has stayed unresolved for SYNC_ERROR_GRACE_MS. Time is
// passed as data (`now`), never read here — the function stays pure.

function input(overrides: Partial<Parameters<typeof deriveSyncStatus>[0]> = {}) {
  return {
    enabled: true,
    online: true,
    errorSince: null,
    now: 0,
    reconnecting: false,
    upToDate: true,
    pendingCount: 0,
    ...overrides,
  }
}

// A genuine error that began at t=0 and has now stayed unresolved past the
// grace window — the only shape that should surface the banner.
function pastGrace(overrides: Partial<Parameters<typeof deriveSyncStatus>[0]> = {}) {
  return input({ errorSince: 0, now: SYNC_ERROR_GRACE_MS, ...overrides })
}

describe('deriveSyncStatus — state mapping (test-first plan #1)', () => {
  it('sync not enabled (v1 default) -> disabled, regardless of other flags', () => {
    expect(deriveSyncStatus(pastGrace({ enabled: false, online: false }))).toBe('disabled')
  })

  it('enabled + fully caught up + nothing pending -> synced', () => {
    expect(deriveSyncStatus(input())).toBe('synced')
  })

  it('enabled + browser offline -> offline, even if an error is also past its grace window', () => {
    expect(deriveSyncStatus(pastGrace({ online: false }))).toBe('offline')
  })

  it('enabled + online + a batch failed to apply, unresolved past the grace window -> error', () => {
    expect(deriveSyncStatus(pastGrace())).toBe('error')
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

  it('an error past its grace while reconnecting is still truthfully reported as error', () => {
    expect(deriveSyncStatus(pastGrace({ reconnecting: true }))).toBe('error')
  })
})

// Issue 086, test-first plan #1 — the debounce grace window. A genuine read
// error must NOT flash the banner instantly; it only becomes 'error' after it
// has stayed unresolved for SYNC_ERROR_GRACE_MS. During the grace it falls
// through to calm activity (reconnecting/syncing), never to a dishonest
// 'synced'. `errorSince === null` is never an error at any `now`.
describe('deriveSyncStatus — error debounce grace window (issue 086)', () => {
  it('within the grace window a genuine error is NOT yet reported as error', () => {
    const status = deriveSyncStatus(input({ errorSince: 1000, now: 1000 + SYNC_ERROR_GRACE_MS - 1 }))
    expect(status).not.toBe('error')
  })

  it('within the grace window an otherwise-idle store reports syncing, never a dishonest synced', () => {
    // upToDate + nothing pending would be 'synced' without an error — but an
    // unresolved (still-debouncing) error means something IS in flight.
    const status = deriveSyncStatus(
      input({ errorSince: 1000, now: 1000 + SYNC_ERROR_GRACE_MS - 1, upToDate: true, pendingCount: 0 }),
    )
    expect(status).toBe('syncing')
  })

  it('reconnecting still takes priority over a within-grace error', () => {
    const status = deriveSyncStatus(
      input({ errorSince: 1000, now: 1000 + SYNC_ERROR_GRACE_MS - 1, reconnecting: true }),
    )
    expect(status).toBe('reconnecting')
  })

  it('once the grace window has fully elapsed the error surfaces', () => {
    expect(deriveSyncStatus(input({ errorSince: 1000, now: 1000 + SYNC_ERROR_GRACE_MS }))).toBe('error')
  })

  it('errorSince === null is never an error, no matter how large now is', () => {
    expect(deriveSyncStatus(input({ errorSince: null, now: 1e12 }))).toBe('synced')
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
