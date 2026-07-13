// The `/accept` endpoint's persistence port (issue 080). Mirrors
// src/server/writeApi/store.ts's split exactly: `AcceptStore` is the seam
// between the pure request-handling logic in handler.ts and whatever
// actually holds the shared rows.
//
// SECURITY-CRITICAL (issue 080's own framing): `/accept` is the ONLY place a
// caller can seat themselves into a workspace they don't own. RLS is
// currently a no-op in prod (every Lambda connects as the `gede_admin` table
// owner, bypassing RLS — see PgAcceptStore's own doc comment below), so this
// store's query predicates ARE the enforcement, not a defense-in-depth
// backstop. Any change here needs the same scrutiny as
// src/server/writeApi/tenancy.ts's checkTenancy.
//
// Two implementations, mirroring writeApi/store.ts:
//  - `InMemoryAcceptStore` — a Map-based fake, used by every vitest in this
//    directory. No live Postgres is reachable in tests (HANDOFF).
//  - `PgAcceptStore` — the real implementation (node-postgres), wired at
//    deploy time. Reviewed here but exercised (without a live database) only
//    by store.contract.test.ts's fake-pg-pool statement-sequence assertions.
import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { canAccept, invitationStatus } from '../../domain/invitation'
import type { WorkspaceRole } from '../../domain/workspaceRole'

/** A pending (accept-eligible) invitation row, as read from `invitations`. */
export interface PendingInvitation {
  readonly id: string
  readonly workspaceId: string
  /** Always the normalized (trimmed, lowercased) form, matching how
   *  src/db/invitations.ts's createInvitation stores it. */
  readonly email: string
  readonly role: WorkspaceRole
  readonly expiresAt: string
  readonly acceptedAt: string | null
  readonly deletedAt: string | null
}

/** A live `workspace_members` row, as read/written by an accept. */
export interface AcceptedMembership {
  readonly id: string
  readonly workspaceId: string
  readonly userSub: string
  readonly role: WorkspaceRole
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export interface AcceptInvitationResult {
  readonly member: AcceptedMembership
  /** The same invitation, now with `acceptedAt` set — returned for parity/
   *  debuggability; the pure handler does not currently read it. */
  readonly invitation: PendingInvitation
}

export interface AcceptStore {
  /**
   * The SOLE authorization primitive (issue 080's core security contract):
   * resolves to a live (`deletedAt === null`), non-expired
   * (`expiresAt > now()`), not-yet-accepted (`acceptedAt === null`)
   * invitation for `(workspaceId, email)` — `email` matched
   * case-insensitively against the row's own normalized email — or `null` if
   * no such invitation exists. Implementations MUST derive this via
   * `invitationStatus`/`canAccept` (src/domain/invitation.ts), never a
   * hand-rolled predicate, so the write-path's notion of "pending" can never
   * drift from the client's own (src/db/invitations.ts's acceptInvitation).
   */
  findPendingInvitation(workspaceId: string, email: string): Promise<PendingInvitation | null>
  /**
   * True iff `sub` already has a live `workspace_members` row for
   * `workspaceId` — the idempotent-retry primitive: a retried accept (the
   * SAME caller, after their own first accept already landed) finds no
   * PENDING invitation anymore (its `acceptedAt` is set), but this lets the
   * handler recognize "already seated, nothing to do" as a success-shaped
   * no-op instead of a rejection.
   */
  findExistingMembership(workspaceId: string, sub: string): Promise<AcceptedMembership | null>
  /**
   * Atomically seats `sub` into `invite.workspaceId` with `invite.role`, and
   * marks `invite` accepted — ONE atomic operation (a single Postgres
   * transaction in `PgAcceptStore`). `invite` MUST be a value already
   * returned by `findPendingInvitation` (the handler never constructs one
   * itself) — this method does not re-derive authorization, it applies a
   * decision already made.
   */
  acceptInvitation(invite: PendingInvitation, sub: string): Promise<AcceptInvitationResult>
}

// ── In-memory test double ───────────────────────────────────────────────────

export class InMemoryAcceptStore implements AcceptStore {
  private readonly invitations = new Map<string, PendingInvitation>() // keyed by invitation id
  private readonly memberships = new Map<string, AcceptedMembership>() // keyed `${workspaceId}:${userSub}`

  private membershipKey(workspaceId: string, sub: string): string {
    return `${workspaceId}:${sub}`
  }

  /** Test/setup helper — seeds an invitation row exactly as it would read
   *  from Postgres (mirrors InMemoryWriteStore.seed's convention). */
  seedInvitation(invitation: PendingInvitation): void {
    this.invitations.set(invitation.id, invitation)
  }

  /** Test/setup helper — seeds a live `workspace_members` row (mirrors
   *  InMemoryWriteStore.seedMembership's convention). */
  seedMembership(member: AcceptedMembership): void {
    this.memberships.set(this.membershipKey(member.workspaceId, member.userSub), member)
  }

  findPendingInvitation(workspaceId: string, email: string): Promise<PendingInvitation | null> {
    const target = email.trim().toLowerCase()
    for (const invitation of this.invitations.values()) {
      if (invitation.workspaceId !== workspaceId) continue
      if (invitation.email.trim().toLowerCase() !== target) continue
      if (!canAccept(invitationStatus(invitation))) continue
      return Promise.resolve(invitation)
    }
    return Promise.resolve(null)
  }

  findExistingMembership(workspaceId: string, sub: string): Promise<AcceptedMembership | null> {
    return Promise.resolve(this.memberships.get(this.membershipKey(workspaceId, sub)) ?? null)
  }

  acceptInvitation(invite: PendingInvitation, sub: string): Promise<AcceptInvitationResult> {
    const now = new Date().toISOString()
    const key = this.membershipKey(invite.workspaceId, sub)
    const existing = this.memberships.get(key)
    const member: AcceptedMembership = {
      id: existing?.id ?? uuidv7(),
      workspaceId: invite.workspaceId,
      userSub: sub,
      role: invite.role,
      updatedAt: now,
      deletedAt: null,
    }
    this.memberships.set(key, member)

    const acceptedInvitation: PendingInvitation = { ...invite, acceptedAt: now }
    this.invitations.set(invite.id, acceptedInvitation)

    return Promise.resolve({ member, invitation: acceptedInvitation })
  }
}

// ── Real (Postgres) implementation ──────────────────────────────────────────

export interface PgAcceptStoreConfig {
  readonly pool: Pool
}

/**
 * Real Postgres-backed AcceptStore. Connects as whatever role the Lambda's
 * pool was configured with — today that is the `gede_admin` table-owner
 * credential every Lambda in this repo shares (see docs/issues/
 * 080-accept-invite-rejected-cross-tenant.md's own framing: "RLS is
 * currently a no-op in prod"), so RLS enforces NOTHING against this
 * connection. Every predicate below (`deleted_at IS NULL`, `expires_at >
 * now()`, `accepted_at IS NULL`, the case-insensitive email match) is
 * therefore the ENTIRE authorization boundary, not defense-in-depth.
 */
export class PgAcceptStore implements AcceptStore {
  constructor(private readonly config: PgAcceptStoreConfig) {}

  private mapInvitationRow(row: Record<string, unknown>): PendingInvitation {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      email: row.email as string,
      role: row.role as WorkspaceRole,
      expiresAt: row.expires_at as string,
      acceptedAt: (row.accepted_at as string | null) ?? null,
      deletedAt: (row.deleted_at as string | null) ?? null,
    }
  }

  private mapMemberRow(row: Record<string, unknown>): AcceptedMembership {
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      userSub: row.user_sub as string,
      role: row.role as WorkspaceRole,
      updatedAt: row.updated_at as string,
      deletedAt: (row.deleted_at as string | null) ?? null,
    }
  }

  async findPendingInvitation(workspaceId: string, email: string): Promise<PendingInvitation | null> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<Record<string, unknown>>(
        'SELECT id, workspace_id, email, role, expires_at, accepted_at, deleted_at FROM invitations ' +
          'WHERE workspace_id = $1 AND lower(email) = lower($2) ' +
          'AND deleted_at IS NULL AND accepted_at IS NULL AND expires_at > now() ' +
          'ORDER BY id DESC LIMIT 1',
        [workspaceId, email],
      )
      const row = result.rows[0]
      return row ? this.mapInvitationRow(row) : null
    } finally {
      client.release()
    }
  }

  async findExistingMembership(workspaceId: string, sub: string): Promise<AcceptedMembership | null> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<Record<string, unknown>>(
        'SELECT id, workspace_id, user_sub, role, updated_at, deleted_at FROM workspace_members ' +
          'WHERE workspace_id = $1 AND user_sub = $2 AND deleted_at IS NULL',
        [workspaceId, sub],
      )
      const row = result.rows[0]
      return row ? this.mapMemberRow(row) : null
    } finally {
      client.release()
    }
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.config.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * ONE transaction: `SELECT ... FOR UPDATE` re-locks (and re-validates, via
   * the same full status predicate `findPendingInvitation` used) the exact
   * invite row, closing the retry race two concurrent accept requests for
   * the same invitation could otherwise hit — then the membership upsert and
   * the invitation's `accepted_at` stamp both happen inside that same lock,
   * so a crash between the two can never leave a "seated but not marked
   * accepted" or "marked accepted but not seated" invitation.
   */
  async acceptInvitation(invite: PendingInvitation, sub: string): Promise<AcceptInvitationResult> {
    return this.withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM invitations WHERE id = $1 AND deleted_at IS NULL AND accepted_at IS NULL AND expires_at > now() FOR UPDATE',
        [invite.id],
      )

      const memberResult = await client.query<Record<string, unknown>>(
        'INSERT INTO workspace_members (id, workspace_id, user_sub, role) VALUES ($1, $2, $3, $4) ' +
          'ON CONFLICT (workspace_id, user_sub) DO UPDATE SET role = $4, deleted_at = NULL, updated_at = now() ' +
          'RETURNING id, workspace_id, user_sub, role, updated_at, deleted_at',
        [uuidv7(), invite.workspaceId, sub, invite.role],
      )

      const acceptedAt = new Date().toISOString()
      await client.query('UPDATE invitations SET accepted_at = now(), updated_at = now() WHERE id = $1', [invite.id])

      const memberRow = memberResult.rows[0]
      if (!memberRow) throw new Error('acceptInvitation: workspace_members upsert returned no row')

      return {
        member: this.mapMemberRow(memberRow),
        invitation: { ...invite, acceptedAt },
      }
    })
  }
}
