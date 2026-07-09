# 060: Invitee cannot accept an invitation — no UI wired to `acceptInvitation` (blocks the read-path delivery)

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy) — completes the 055 sharing fix's invitee side
- **Severity**: High — this is the missing half of #8. The write-path fix (056/057) persists the invitation to RDS, but a real invitee can never actually receive/open the shared project, so the reported bug ("project is not being shared with the intended users") is only half-resolved.
- **Found via**: Live two-identity smoke of the 056/057/058 deploy (2026-07-09) — see 055.

## Symptom

After the sharing fix deployed, an owner's invitation now reaches RDS (056 verified live: `invitations` 0→1). But a genuinely separate invitee, signing in on another device/account, **never sees the shared project**. Locally-cached data can make it *look* like it works in the same browser, but the server confirms no share is actually delivered.

## Root cause

The read-path (058, shape proxy) is — correctly — scoped strictly to **accepted `workspace_members` rows** (`listWorkspaceIdsForSub`, `src/server/shapeProxy/handler.ts:42-43`, `albAdapter.ts:76-81`; `src/domain/syncScope.ts`). An invitee therefore receives a shared workspace's rows **only after being seated as a member**.

Seating happens by *accepting* an invitation: `useWorkspaceStore.acceptInvitation` (`src/store/workspace.ts:170`) → `dbAcceptInvitation` (`src/db/invitations.ts:106`) self-inserts the `workspace_members` row (057 also enqueues that seat mutation to flush to RDS).

**But no component ever calls `acceptInvitation`.** A repo-wide grep (`grep -rn acceptInvitation src/`) finds only the store action, the db function, tests, and comments — **no UI entry point**. `WorkspaceMembers.tsx` is the *owner's* panel (it lists invitations they *sent*, with Resend/Revoke); there is no *invitee-facing* surface that shows "you've been invited to X — Accept / Decline".

Consequently invitees are never seated → the membership-scoped read-path returns nothing to them → the shared project never arrives.

## Live evidence (2026-07-09)

- `invitations`: 1 row, `accepted_at = null` (never redeemed).
- `workspace_members`: only owner rows — **no invitee seat**.
- The invited email had **no provisioned workspace** (invitee flow never completed server-side).
- Read-path confirmed membership-gated (no leak): a non-member gets zero shared rows.

## Fix direction (not yet implemented)

1. **Invitee-facing pending-invitations surface.** When a signed-in user has pending invitations addressed to their email (`listInvitations`/the by-email RLS SELECT already supports this, migration 0009), show an "Invitations" affordance (inbox, banner, or a modal on sign-in) listing each pending invite with **Accept** and **Decline** actions.
2. **Wire Accept → `useWorkspaceStore.acceptInvitation(id)`** (already exists; already enqueues the 057 seat mutation to flush to RDS). Decline → revoke/dismiss.
3. On accept, the client should (re)start the read-path scoped to the newly-joined workspace so the shared project streams in.
4. Decide the intended UX: explicit Accept/Decline (recommended, matches 035's invitation model) vs. auto-seat-on-sign-in. The tester expected *some* accept/decline step; today the project "just appears" only because of local data, which is misleading.

## Test-first plan

- **Component (red first):** a test that a signed-in user with a pending invitation to their email sees an Accept control, and clicking it calls `acceptInvitation` (currently red — no such component/handler exists).
- **Store:** `acceptInvitation` already has coverage (057) that it enqueues a seat mutation scoped to the inviter's workspace — reuse/extend it.
- **E2E (the real proof #8 needs):** two Cognito identities on **separate** browser profiles (no shared local PGlite) — A invites B; B signs in, sees the pending invite, clicks Accept; assert `workspace_members` gains B's seat in A's workspace (via 049 debug API) **and** B's client renders A's project (streamed via the shape proxy). This is the test that should gate closing #8.

**References**: 055 (the umbrella sharing bug), 056 (invite reaches RDS — the verified half), 057 (`acceptInvitation` seat mutation + membership-gated tenancy), 058 (membership-scoped read-path — only delivers to seated members), 035 (original invitations model), migration `0009` (by-email invitation SELECT RLS the invitee surface can use). Blocks a full close of **GitHub issue #8**.
