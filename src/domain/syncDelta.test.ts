import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  applyRowDelta,
  applyRowDeltas,
  assertBaseColumnsOnly,
  DerivedColumnInDeltaError,
  emptySyncState,
  liveRows,
  type RowDelta,
} from './syncDelta'

function delta(id: string, updatedAt: string, row: Record<string, unknown> = {}): RowDelta {
  return { table: 'contexts', id, updatedAt, row: { id, ...row } }
}

describe('applyRowDelta — LWW merge (test-first plan #1)', () => {
  it('a first delta for an id is simply adopted', () => {
    const state = applyRowDelta(emptySyncState(), delta('c1', '2026-01-01T00:00:01.000Z', { symbol: 'α' }))
    expect(state.contexts.c1?.row.symbol).toBe('α')
  })

  it('a newer updatedAt replaces the incumbent row', () => {
    let state = emptySyncState()
    state = applyRowDelta(state, delta('c1', '2026-01-01T00:00:01.000Z', { symbol: 'α' }))
    state = applyRowDelta(state, delta('c1', '2026-01-01T00:00:02.000Z', { symbol: 'α-renamed' }))
    expect(state.contexts.c1?.row.symbol).toBe('α-renamed')
  })

  it('an older updatedAt never overwrites a newer incumbent (out-of-order delivery)', () => {
    let state = emptySyncState()
    state = applyRowDelta(state, delta('c1', '2026-01-01T00:00:05.000Z', { symbol: 'newer' }))
    state = applyRowDelta(state, delta('c1', '2026-01-01T00:00:01.000Z', { symbol: 'stale' }))
    expect(state.contexts.c1?.row.symbol).toBe('newer')
  })

  it('re-delivering the identical delta is a no-op (idempotent)', () => {
    const d = delta('c1', '2026-01-01T00:00:01.000Z', { symbol: 'α' })
    const once = applyRowDelta(emptySyncState(), d)
    const twice = applyRowDelta(once, d)
    expect(twice).toEqual(once)
  })

  it('a soft-delete tombstone is just a row with deletedAt set — no special op', () => {
    let state = emptySyncState()
    state = applyRowDelta(state, delta('c1', '2026-01-01T00:00:01.000Z', { symbol: 'α', deletedAt: null }))
    state = applyRowDelta(
      state,
      delta('c1', '2026-01-01T00:00:02.000Z', { symbol: 'α', deletedAt: '2026-01-01T00:00:02.000Z' }),
    )
    expect(state.contexts.c1?.row.deletedAt).toBe('2026-01-01T00:00:02.000Z')
    expect(liveRows(state, 'contexts')).toEqual({})
  })
})

describe('assertBaseColumnsOnly — derived-state guard (test-first plan #4, ADR-0005)', () => {
  it('accepts a delta whose row is a subset of the table’s real columns', () => {
    expect(() =>
      assertBaseColumnsOnly(delta('c1', '2026-01-01T00:00:01.000Z', { symbol: 'α', justification: 'because' })),
    ).not.toThrow()
  })

  it.each(['x', 'y', 'canvasPosition', 'coverage', 'completeness'])(
    'rejects a derived column %s on the wire',
    (column) => {
      expect(() => assertBaseColumnsOnly(delta('c1', '2026-01-01T00:00:01.000Z', { [column]: 1 }))).toThrow(
        DerivedColumnInDeltaError,
      )
    },
  )

  it('applyRowDelta enforces the guard too — a derived column never merges in', () => {
    expect(() =>
      applyRowDelta(emptySyncState(), delta('c1', '2026-01-01T00:00:01.000Z', { x: 12, y: 34 })),
    ).toThrow(DerivedColumnInDeltaError)
  })
})

// ── Convergence property (test-first plan #2) ───────────────────────────────
// Applying a fixed delta set in ANY permutation must reach identical row
// state — the semilattice-join property claimed in the module doc.

const idPool = ['a', 'b', 'c'] as const

const arbDelta: fc.Arbitrary<RowDelta> = fc
  .record({
    id: fc.constantFrom(...idPool),
    tick: fc.integer({ min: 0, max: 30 }),
    symbol: fc.string({ minLength: 1, maxLength: 3 }),
  })
  .map(({ id, tick, symbol }) =>
    delta(id, `2026-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`, { symbol }),
  )

const arbDeltasAndPermutation = fc
  .array(arbDelta, { minLength: 1, maxLength: 14 })
  .chain((deltas) =>
    fc.tuple(
      fc.constant(deltas),
      fc.shuffledSubarray(deltas, { minLength: deltas.length, maxLength: deltas.length }),
    ),
  )

describe('convergence property (test-first plan #2)', () => {
  it('any permutation of a fixed delta set yields identical local row state', () => {
    fc.assert(
      fc.property(arbDeltasAndPermutation, ([deltas, shuffled]) => {
        const original = applyRowDeltas(emptySyncState(), deltas)
        const permuted = applyRowDeltas(emptySyncState(), shuffled)
        expect(permuted).toEqual(original)
      }),
    )
  })

  // Brute-force oracle (mirrors coverage.ts's convention, HANDOFF): for each
  // id, independently pick the delta with the max (updatedAt, then row JSON)
  // — not via applyRowDeltas at all — and assert the engine agrees.
  it('matches a brute-force per-id max-by-(updatedAt, row) oracle', () => {
    fc.assert(
      fc.property(fc.array(arbDelta, { minLength: 1, maxLength: 14 }), (deltas) => {
        const state = applyRowDeltas(emptySyncState(), deltas)
        const byId = new Map<string, RowDelta>()
        for (const d of deltas) {
          const prev = byId.get(d.id)
          if (
            !prev ||
            d.updatedAt > prev.updatedAt ||
            (d.updatedAt === prev.updatedAt && JSON.stringify(d.row) > JSON.stringify(prev.row))
          ) {
            byId.set(d.id, d)
          }
        }
        for (const [id, winner] of byId) {
          expect(state.contexts[id]?.row).toEqual(winner.row)
          expect(state.contexts[id]?.updatedAt).toEqual(winner.updatedAt)
        }
        expect(Object.keys(state.contexts)).toHaveLength(byId.size)
      }),
    )
  })
})
