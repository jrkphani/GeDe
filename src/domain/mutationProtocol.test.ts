import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { uuidv7 } from 'uuidv7'
import {
  isReplay,
  isUuidv7,
  isWellFormedEnvelope,
  resolveLastWriteWins,
  type MutationEnvelope,
} from './mutationProtocol'

function envelope(overrides: Partial<MutationEnvelope> = {}): MutationEnvelope {
  return {
    id: uuidv7(),
    workspaceId: 'ws-1',
    table: 'dimensions',
    op: 'update',
    entityId: uuidv7(),
    payload: { name: 'Renamed' },
    clientUpdatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('isUuidv7', () => {
  it('accepts ids produced by the repo uuidv7 generator', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(isUuidv7(uuidv7())).toBe(true)
      }),
    )
  })

  it('rejects a v4 uuid and arbitrary strings', () => {
    expect(isUuidv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false) // v4
    expect(isUuidv7('not-a-uuid')).toBe(false)
    expect(isUuidv7('')).toBe(false)
  })
})

describe('isWellFormedEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isWellFormedEnvelope(envelope())).toBe(true)
  })

  it('rejects a non-uuidv7 mutation id or entity id', () => {
    expect(isWellFormedEnvelope(envelope({ id: 'bad-id' }))).toBe(false)
    expect(isWellFormedEnvelope(envelope({ entityId: 'bad-id' }))).toBe(false)
  })

  it('rejects an empty workspace id or unparseable timestamp', () => {
    expect(isWellFormedEnvelope(envelope({ workspaceId: '  ' }))).toBe(false)
    expect(isWellFormedEnvelope(envelope({ clientUpdatedAt: 'not-a-date' }))).toBe(false)
  })
})

describe('resolveLastWriteWins', () => {
  it('applies when no row exists yet (fresh insert)', () => {
    expect(resolveLastWriteWins(null, envelope({ clientUpdatedAt: '2026-01-01T00:00:00.000Z' }))).toBe('apply')
  })

  it('applies when the incoming mutation is strictly newer', () => {
    const decision = resolveLastWriteWins(
      '2026-01-01T00:00:00.000Z',
      envelope({ clientUpdatedAt: '2026-01-02T00:00:00.000Z' }),
    )
    expect(decision).toBe('apply')
  })

  it('is stale when the incoming mutation is older or exactly tied (favors the existing row)', () => {
    expect(
      resolveLastWriteWins('2026-01-02T00:00:00.000Z', envelope({ clientUpdatedAt: '2026-01-01T00:00:00.000Z' })),
    ).toBe('stale')
    expect(
      resolveLastWriteWins('2026-01-01T00:00:00.000Z', envelope({ clientUpdatedAt: '2026-01-01T00:00:00.000Z' })),
    ).toBe('stale')
  })

  it('property: for any two timestamps, apply iff incoming > current', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000_000 }), fc.integer({ min: 0, max: 2_000_000_000_000 }), (a, b) => {
        const current = new Date(a).toISOString()
        const incoming = new Date(b).toISOString()
        const decision = resolveLastWriteWins(current, envelope({ clientUpdatedAt: incoming }))
        expect(decision).toBe(b > a ? 'apply' : 'stale')
      }),
    )
  })
})

describe('isReplay', () => {
  it('is false the first time and true once the id has been seen', () => {
    const seen = new Set<string>()
    const m = envelope()
    expect(isReplay(seen, m)).toBe(false)
    seen.add(m.id)
    expect(isReplay(seen, m)).toBe(true)
  })
})
