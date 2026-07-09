# 060: Invitee cannot accept an invitation — no UI wired to `acceptInvitation` (blocks the read-path delivery)

- **Status**: SHIPPED — `src/components/PendingInvitations.tsx` (mounted unconditionally in `AppShell`, not gated on a project being open) lists pending invitations addressed to the signed-in user's email with Accept/Decline; `useWorkspaceStore.loadMyInvitations`/`declineInvitation` are new, `acceptInvitation` (057) is reused unchanged. `npm run verify:fast` green (995/998 vitest, 3 pre-existing skips; typecheck + eslint + stylelint clean). Live two-Cognito-identity smoke test (the real proof #8 needs) is **deferred to the orchestrator** — see "What shipped / what's deferred" below.
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

## What shipped

1. **`src/db/workspaces.ts`: `getWorkspace(db, id)`** — a best-effort single-row lookup (mirrors `invitations.ts`'s `getInvitation`), used to show a workspace name alongside a pending invite when this local PGlite already has that row (it commonly won't, pre-accept — see "residual gaps" below).
2. **`src/store/workspace.ts`**:
   - `myInvitations: MyInvitationView[]` (`InvitationRow` + best-effort `workspaceName`), independent of the existing `workspaceId`/`members`/`invitations` (those stay scoped to whichever workspace's *owner* panel is open).
   - `loadMyInvitations()` — reads `useAuthStore.getState().user?.email`, calls `listPendingInvitationsForEmail` (migration 0009's by-email RLS SELECT), resolves each row's workspace name best-effort. No-op (empty list) when signed out.
   - `declineInvitation(id)` — reuses `revokeInvitation` (db layer) then reloads `myInvitations`. Mirrors the owner-side `revokeInvitation` store action's own behavior (no separate sync-enqueue) — see residual gap #2 below.
   - `acceptInvitation` (057, unchanged in shape) now additionally: awaits the seat mutation's `flush()` before restarting the read-path (narrows, doesn't eliminate, a race — see gap #1); calls `useProjectsStore.refreshProjects()`; reloads `myInvitations` so the just-accepted invite drops out of the pending list.
3. **`src/store/projects.ts`: `refreshProjects()`** — re-lists local projects AND, if the read-path is enabled, **restarts** it (`stop()` + `start()`). A restart matters, not just a re-list: 058's shape proxy re-resolves the caller's memberships fresh per *shape request*, but an already-open `ShapeStream` keeps polling the *same* shape (table + `where` + Electric `handle`) it was granted at subscribe time — a membership gained mid-session never retroactively widens an open shape's scope.
4. **`src/components/PendingInvitations.tsx`** — the invitee-facing surface: a Popover trigger (`Invitations · N`) that lists each pending invite (workspace name if locally known, role, Accept/Decline). Gated on signed-in + ≥1 pending invite; renders nothing otherwise. Mounted in `src/shell/AppShell.tsx`'s app-bar cluster **unconditionally** (not inside the `projectId !== null` gates that scope `WorkspaceMembers`/`PresenceRoster`/`ProjectMenu`) — an invitee may have no project open yet. Also gated on `useProjectsStore`'s `status === 'ready'` before its load effect fires, since (unlike `WorkspaceMembers`) it can mount before `App.tsx`'s `init()`/`hydrate()` race resolves (found via a real unhandled-rejection in `shell.test.tsx` during implementation, fixed before shipping).

## Residual gaps (not closed by this issue)

1. **Accept→restart race.** `refreshProjects()`'s restart fires right after `acceptInvitation` `await`s one `flush()` call — this narrows but does not eliminate the race between "seat mutation reaches RDS" and "read-path re-subscribes." A slow/offline flush still leaves the newly-shared project undelivered until `useSyncStore`'s own retry/backoff (048) eventually lands and a *later* refresh/reload picks it up. Only the live two-identity smoke (this issue's own test-first plan, deferred to the orchestrator) proves the common-case timing is actually fine in the deployed environment.
2. **`declineInvitation` doesn't sync the decline to RDS.** It mirrors the pre-existing owner-side `revokeInvitation` store action, which *also* never enqueues a sync mutation (confirmed: `invite()`/`changeRole()`/`removeMember()`/`acceptInvitation()` all enqueue; `revokeInvitation()`/`resendInvitation()` do not). This is a pre-existing gap in 056's mutation-protocol coverage, not something 060 introduced — flagging it here rather than silently fixing it out-of-scope. A decline today is real (the local row is tombstoned, `canAccept` excludes it from `myInvitations`) but stays local-only until something else revokes/expires it server-side too.
3. **Workspace name context is best-effort.** `getWorkspace` reads the LOCAL PGlite; a not-yet-accepted invitee's browser has typically never synced the inviter's `workspaceId` row (`workspaces`/`workspace_members` aren't Electric-synced tables at all per `src/sync/config.ts`'s `SYNCED_TABLES`), so the invite commonly renders with the "a shared workspace" fallback instead of a real name. Not a correctness bug — Accept/Decline still act on the right `invitation.id` — just a UX quality gap a future issue could close by including the inviting workspace's name directly on the invitation row (denormalized) rather than requiring a live lookup.
