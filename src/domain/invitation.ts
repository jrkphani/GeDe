// Issue 035 — invitation status is DERIVED, never stored (matches this
// schema's existing convention — `documentedStatus`/`isComplete`, issue 005/
// SPEC invariant 1 — of computing a live status from timestamps rather than
// duplicating state that can drift). The DB's invitations table (migration
// 0009) has no `status` column; this is the one place that reads
// accepted_at/deleted_at/expires_at and names what they mean, so app code and
// tests always agree with each other and with the RLS policies' own
// `accepted_at IS NULL AND deleted_at IS NULL AND expires_at > now()` guard.
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export interface InvitationTimestamps {
  expiresAt: string
  acceptedAt: string | null
  deletedAt: string | null
}

/**
 * Pure status derivation. Priority: accepted (a completed fact — even if the
 * row was later soft-deleted or has since expired) > revoked (the tombstone
 * convention, SPEC §3) > expired > pending.
 */
export function invitationStatus(inv: InvitationTimestamps, now: Date = new Date()): InvitationStatus {
  if (inv.acceptedAt !== null) return 'accepted'
  if (inv.deletedAt !== null) return 'revoked'
  if (new Date(inv.expiresAt).getTime() <= now.getTime()) return 'expired'
  return 'pending'
}

/** Only a still-pending invitation can be redeemed. */
export function canAccept(status: InvitationStatus): boolean {
  return status === 'pending'
}

/** A pending or expired invitation can be revoked (an accepted membership is
 *  removed via `removeWorkspaceMember`, not by revoking the invite that
 *  granted it; an already-revoked one is a no-op, not re-revocable). */
export function canRevoke(status: InvitationStatus): boolean {
  return status === 'pending' || status === 'expired'
}

/** Resend extends the expiry — valid for the same pending/expired states as
 *  revoke; an accepted or revoked invitation must be re-issued fresh instead. */
export function canResend(status: InvitationStatus): boolean {
  return status === 'pending' || status === 'expired'
}
