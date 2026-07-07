import { and, desc, eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Database } from './client'
import { firstOrThrow } from './util'
import { invitations, workspaceMembers } from './schema'
import type { WorkspaceRole } from '../domain/workspaceRole'
import { canAccept, canRevoke, canResend, invitationStatus } from '../domain/invitation'
import type { WorkspaceMemberRow } from './workspaces'

// Issue 035 (done/034 deviation #3, ADR-0009) — the granting path 034
// deferred: an owner invites by EMAIL (not a Cognito `sub` — they don't have
// one for someone who hasn't signed up yet), and the invitee's accept binds
// their real identity once it exists. Migration 0009 is the DB/RLS half;
// this module is the ordinary app-side path a trusted server/local context
// uses to manage invitations — RLS (migration 0009) is the enforcing
// backstop, mirroring workspaces.ts's own convention (see that file's header).

export type InvitationRow = typeof invitations.$inferSelect

const DEFAULT_TTL_DAYS = 7

function now(): string {
  return new Date().toISOString()
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

// Typed rejections (mirrors src/domain/projectEnvelope.ts's NotGeDeExportError
// family) so callers (the store/UI) render a calm, specific message instead
// of a generic thrown string.
export class InvitationNotFoundError extends Error {
  constructor() {
    super('Invitation not found')
    this.name = 'InvitationNotFoundError'
  }
}

export class InvitationEmailMismatchError extends Error {
  constructor() {
    super('This invitation was sent to a different email address')
    this.name = 'InvitationEmailMismatchError'
  }
}

export class InvitationNotAcceptableError extends Error {
  readonly status: ReturnType<typeof invitationStatus>
  constructor(status: ReturnType<typeof invitationStatus>) {
    super(
      status === 'accepted'
        ? 'This invitation has already been accepted'
        : status === 'revoked'
          ? 'This invitation has been revoked'
          : 'This invitation has expired',
    )
    this.name = 'InvitationNotAcceptableError'
    this.status = status
  }
}

export async function createInvitation(
  db: Database,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
  invitedBySub: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<InvitationRow> {
  const rows = await db
    .insert(invitations)
    .values({
      id: uuidv7(),
      workspaceId,
      email: email.trim().toLowerCase(),
      role,
      invitedBySub,
      expiresAt: addDays(ttlDays),
    })
    .returning()
  return firstOrThrow(rows)
}

// Every invitation ever sent for a workspace (pending/accepted/revoked/
// expired all included — status is derived live, src/domain/invitation.ts) so
// the member-management UI can show a full history, most recent first.
// Ordered by id (not createdAt): UUIDv7 is itself time-sortable to
// sub-millisecond precision, so it stays stable even when two invitations
// are created within the same `timestamp` tick (createdAt alone ties).
export async function listInvitations(db: Database, workspaceId: string): Promise<InvitationRow[]> {
  return db.select().from(invitations).where(eq(invitations.workspaceId, workspaceId)).orderBy(desc(invitations.id))
}

export async function getInvitation(db: Database, id: string): Promise<InvitationRow | null> {
  const rows = await db.select().from(invitations).where(eq(invitations.id, id))
  return rows[0] ?? null
}

// The accept flow (test-first plan #1): binds the invited identity (033) to
// the workspace with the invited role, and marks the invitation redeemed —
// both in one transaction so a crash between the two never leaves a "used
// but not seated" or "seated but re-usable" invitation. RLS's own tightened
// workspace_members INSERT policy (migration 0009) requires exactly this
// pairing from a non-owner connection; this is the trusted-context version
// of the same rule.
export async function acceptInvitation(
  db: Database,
  invitationId: string,
  userSub: string,
  userEmail: string,
): Promise<WorkspaceMemberRow> {
  const invitation = await getInvitation(db, invitationId)
  if (!invitation) throw new InvitationNotFoundError()

  const status = invitationStatus(invitation)
  if (!canAccept(status)) throw new InvitationNotAcceptableError(status)
  if (invitation.email !== userEmail.trim().toLowerCase()) throw new InvitationEmailMismatchError()

  return db.transaction(async (tx) => {
    const memberRows = await tx
      .insert(workspaceMembers)
      .values({ id: uuidv7(), workspaceId: invitation.workspaceId, userSub, role: invitation.role })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userSub],
        set: { role: invitation.role, deletedAt: null, updatedAt: now() },
      })
      .returning()
    await tx.update(invitations).set({ acceptedAt: now(), updatedAt: now() }).where(eq(invitations.id, invitationId))
    return firstOrThrow(memberRows)
  })
}

// Soft-delete (mirrors workspaces.ts's removeWorkspaceMember / SPEC §3
// tombstone convention) — a revoke is itself a row-delta the sync stream can
// propagate, not a silent disappearance.
export async function revokeInvitation(db: Database, invitationId: string): Promise<void> {
  const invitation = await getInvitation(db, invitationId)
  if (!invitation) throw new InvitationNotFoundError()
  const status = invitationStatus(invitation)
  if (!canRevoke(status)) throw new InvitationNotAcceptableError(status)
  await db
    .update(invitations)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(invitations.id, invitationId))
}

// Extends a still-live invitation's expiry (least-surprise resend, design
// brief) rather than issuing a new row/id — the same accept link keeps working.
export async function resendInvitation(
  db: Database,
  invitationId: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<InvitationRow> {
  const invitation = await getInvitation(db, invitationId)
  if (!invitation) throw new InvitationNotFoundError()
  const status = invitationStatus(invitation)
  if (!canResend(status)) throw new InvitationNotAcceptableError(status)
  const rows = await db
    .update(invitations)
    .set({ expiresAt: addDays(ttlDays), updatedAt: now() })
    .where(eq(invitations.id, invitationId))
    .returning()
  return firstOrThrow(rows)
}

// Pending (accept-eligible right now) invitations for a given email — the
// invitee's-own-view lookup, scoped by RLS's email-match SELECT policy on
// the server; used locally by any future "invitations for me" affordance.
export async function listPendingInvitationsForEmail(db: Database, email: string): Promise<InvitationRow[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, email.trim().toLowerCase())))
    .orderBy(desc(invitations.createdAt))
  return rows.filter((r) => canAccept(invitationStatus(r)))
}
