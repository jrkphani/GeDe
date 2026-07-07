import { describe, expect, it } from 'vitest'
import { canAccept, canRevoke, canResend, invitationStatus, type InvitationTimestamps } from './invitation'

const NOW = new Date('2026-07-07T12:00:00.000Z')
const FUTURE = '2026-07-08T00:00:00.000Z'
const PAST = '2026-07-01T00:00:00.000Z'

function inv(overrides: Partial<InvitationTimestamps> = {}): InvitationTimestamps {
  return { expiresAt: FUTURE, acceptedAt: null, deletedAt: null, ...overrides }
}

describe('invitationStatus (pure, derived — mirrors documentedStatus/isComplete)', () => {
  it('is pending when unexpired, unaccepted, unrevoked', () => {
    expect(invitationStatus(inv(), NOW)).toBe('pending')
  })

  it('is accepted once acceptedAt is set, even past expiry', () => {
    expect(invitationStatus(inv({ acceptedAt: '2026-07-02T00:00:00.000Z' }), NOW)).toBe('accepted')
    expect(invitationStatus(inv({ acceptedAt: '2026-07-02T00:00:00.000Z', expiresAt: PAST }), NOW)).toBe('accepted')
  })

  it('is revoked once deletedAt is set — takes priority over expiry', () => {
    expect(invitationStatus(inv({ deletedAt: '2026-07-02T00:00:00.000Z' }), NOW)).toBe('revoked')
    expect(invitationStatus(inv({ deletedAt: '2026-07-02T00:00:00.000Z', expiresAt: PAST }), NOW)).toBe('revoked')
  })

  it('accepted takes priority over revoked if somehow both are set (accept is a completed fact)', () => {
    expect(
      invitationStatus(inv({ acceptedAt: '2026-07-02T00:00:00.000Z', deletedAt: '2026-07-03T00:00:00.000Z' }), NOW),
    ).toBe('accepted')
  })

  it('is expired when past expiresAt and neither accepted nor revoked', () => {
    expect(invitationStatus(inv({ expiresAt: PAST }), NOW)).toBe('expired')
  })
})

describe('canAccept / canRevoke / canResend', () => {
  it('only a pending invitation can be accepted', () => {
    expect(canAccept('pending')).toBe(true)
    expect(canAccept('accepted')).toBe(false)
    expect(canAccept('revoked')).toBe(false)
    expect(canAccept('expired')).toBe(false)
  })

  it('pending or expired can be revoked; accepted/already-revoked cannot', () => {
    expect(canRevoke('pending')).toBe(true)
    expect(canRevoke('expired')).toBe(true)
    expect(canRevoke('accepted')).toBe(false)
    expect(canRevoke('revoked')).toBe(false)
  })

  it('pending or expired can be resent (extends expiry); accepted/revoked cannot', () => {
    expect(canResend('pending')).toBe(true)
    expect(canResend('expired')).toBe(true)
    expect(canResend('accepted')).toBe(false)
    expect(canResend('revoked')).toBe(false)
  })
})
