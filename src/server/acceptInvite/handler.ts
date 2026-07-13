// The dedicated `/accept` endpoint's pure core (issue 080). Mirrors
// src/server/writeApi/handler.ts's split (ADR-0010): this is the runtime-
// agnostic heart of the Lambda — pure orchestration over injected ports (JWT
// verifier, accept store) — fully unit-testable without AWS/ALB/Postgres/
// Cognito. `albAdapter.ts` is the thin, AWS-event-shaped wrapper.
//
// WHY A DEDICATED ENDPOINT (issue 080): the generic `/write` path's
// `checkTenancy` gates a `workspace_members` insert on the caller already
// BEING a member of the target workspace — which is necessarily false for a
// first-time accept, since the insert IS the row that would make it true.
// Rather than carve an exception into that single, load-bearing tenancy
// check, this endpoint is a narrowly-scoped, server-authoritative seam whose
// ENTIRE job is: verify identity, load the ONE invitation that authorizes
// this exact seat, and apply it — nothing else routes through here.
//
// SECURITY-CRITICAL (issue 080's own framing): RLS is currently a no-op in
// prod (every Lambda — this one included — connects as the `gede_admin`
// table owner, bypassing RLS). This handler's own logic is therefore the
// SOLE authorization boundary for "can this caller join this workspace" —
// treat any change here with the same scrutiny as
// src/server/writeApi/tenancy.ts's checkTenancy.
import { verifyBearerToken, type JwtVerifierConfig } from '../writeApi/jwt'
import type { AcceptStore } from './store'
import type { WorkspaceRole } from '../../domain/workspaceRole'

export interface AcceptInviteRequest {
  readonly authorizationHeader: string | undefined
  readonly invitationId: string
  readonly workspaceId: string
  // Deliberately NO userSub/actorSub/email field: the seated identity is
  // derived ONLY from the verified JWT claims below (`auth.claims.sub` /
  // `auth.claims.email`) — there is no request field a caller could use to
  // seat a different user, by construction of this type.
}

export type AcceptRejectionReason =
  | 'missing_token'
  | 'invalid_token'
  | 'expired_token'
  | 'missing_claims'
  // Issue 080 fail-closed requirement: claims.email absent — kept DISTINCT
  // from every other rejection reason (never conflated with
  // 'invitation_not_found') so a caller/operator can tell "your token has no
  // email" apart from "no invitation matched".
  | 'missing_email'
  // Covers every other way an accept is not authorized: no invitation
  // exists for (workspaceId, verified email), the requested invitationId
  // doesn't match the one found, it's expired, revoked, or already accepted
  // by someone else. Deliberately ONE reason for all of these (not four) —
  // distinguishing them in the response would let an unauthenticated-in-
  // intent caller enumerate which of those states applies to an invitation
  // addressed to an email they don't actually control.
  | 'invitation_not_found'

export interface AcceptRejection {
  readonly reason: AcceptRejectionReason
  readonly message: string
}

function rejection(reason: AcceptRejectionReason, message: string): AcceptRejection {
  return { reason, message }
}

export type AcceptOutcome =
  | { readonly status: 'applied'; readonly workspaceId: string; readonly role: WorkspaceRole }
  | { readonly status: 'rejected'; readonly reason: AcceptRejectionReason; readonly message: string }

export type AcceptApiResult =
  | { readonly status: 401 | 403; readonly rejection: AcceptRejection }
  | { readonly status: 200; readonly outcome: AcceptOutcome }

export interface AcceptInviteDeps {
  readonly jwt: JwtVerifierConfig
  readonly store: AcceptStore
}

const INVITATION_NOT_FOUND_MESSAGE =
  'This invitation is no longer valid — it may have expired, been revoked, or already been used.'

/**
 * The CORE SECURITY CONTRACT (issue 080):
 *
 * 1. Verify the Cognito JWT (`verifyBearerToken`, reused verbatim from
 *    writeApi/jwt.ts) — an invalid/missing/expired token never reaches step 2.
 * 2. Derive `sub` AND `email` from the VERIFIED claims ONLY. `claims.email`
 *    absent -> fail closed (`missing_email`), never fall back to any
 *    client-supplied value (there isn't one — see `AcceptInviteRequest`'s
 *    own doc comment).
 * 3. Authorize the accept ONLY when `deps.store.findPendingInvitation`
 *    resolves a live, non-expired, not-yet-accepted invitation for
 *    `(request.workspaceId, claims.email)` WHOSE id matches
 *    `request.invitationId` — the extra id match is a tightening beyond the
 *    store's own (workspaceId, email) predicate: it ensures the specific
 *    invitation the client believes it is accepting is the one actually
 *    authorized, even in the (rare, e.g. revoke+reinvite) case where more
 *    than one invitation could exist for the same pair.
 * 4. If step 3 fails, check `findExistingMembership` for
 *    `(workspaceId, claims.sub)` — if the caller is ALREADY seated (the
 *    common cause: a retried accept after their own prior success already
 *    landed), this is a success-shaped no-op, never a rejection.
 * 5. Otherwise, apply `deps.store.acceptInvitation` (one atomic op) and
 *    report the result. `userSub` passed to the store is `auth.claims.sub`
 *    ONLY — there is no other source.
 */
/**
 * The idempotent-retry / fail-closed rejection path, shared by every way an
 * accept can end up unauthorized (test-first plan item 5): the caller may
 * already be seated because their OWN prior accept already landed (the
 * invitation is no longer pending precisely because it succeeded) — that's
 * success, not a rejection. Otherwise, one deliberately generic rejection
 * reason (`invitation_not_found`) covers every other cause, so a caller
 * cannot enumerate invitation state for an email they don't control.
 */
async function idempotentOrRejected(deps: AcceptInviteDeps, workspaceId: string, sub: string): Promise<AcceptApiResult> {
  const existingMembership = await deps.store.findExistingMembership(workspaceId, sub)
  if (existingMembership) {
    return {
      status: 200,
      outcome: { status: 'applied', workspaceId: existingMembership.workspaceId, role: existingMembership.role },
    }
  }
  return { status: 200, outcome: { status: 'rejected', reason: 'invitation_not_found', message: INVITATION_NOT_FOUND_MESSAGE } }
}

export async function acceptInvite(request: AcceptInviteRequest, deps: AcceptInviteDeps): Promise<AcceptApiResult> {
  const auth = await verifyBearerToken(request.authorizationHeader, deps.jwt)
  if (!auth.ok) {
    return {
      status: 401,
      rejection: rejection(auth.reason, 'Your session has expired or is invalid — sign in again to accept this invitation.'),
    }
  }

  // Trimmed, not just truthiness-checked: a token whose `email` claim is
  // present but whitespace-only (`"   "`) must fail closed the same way an
  // absent claim does, never fall through and get silently treated as "no
  // invitation matched" (a real but misleading-reason rejection).
  const email = auth.claims.email?.trim()
  if (!email) {
    return {
      status: 200,
      outcome: {
        status: 'rejected',
        reason: 'missing_email',
        message: 'Your account has no verified email on file — sign in again to accept this invitation.',
      },
    }
  }

  const invite = await deps.store.findPendingInvitation(request.workspaceId, email)
  const authorized = invite !== null && invite.id === request.invitationId

  if (!authorized) {
    return idempotentOrRejected(deps, request.workspaceId, auth.claims.sub)
  }

  const result = await deps.store.acceptInvitation(invite, auth.claims.sub)
  if (result === null) {
    // TOCTOU close: the invite was valid when findPendingInvitation ran, but
    // the store's own re-validation (immediately before applying anything)
    // found it no longer valid — revoked/expired/accepted by someone else in
    // that window. Treat exactly like the unauthorized path above: never
    // seat a fresh membership off a stale invitation snapshot.
    return idempotentOrRejected(deps, request.workspaceId, auth.claims.sub)
  }

  return { status: 200, outcome: { status: 'applied', workspaceId: result.member.workspaceId, role: result.member.role } }
}
