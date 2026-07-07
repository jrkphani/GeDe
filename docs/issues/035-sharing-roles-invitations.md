# 035: Sharing — roles & invitations

- **Status**: SHIPPED (branch `feat/035-sharing-roles`, migration `0009`) — pending orchestrator review/merge
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 034 (workspaces + RLS enforcement), 033 (auth) — both merged to `main` prior to this work.

## Slice

As a workspace owner I invite collaborators by email and grant a **role** (owner / editor / viewer); they accept and get exactly the access the role allows — RLS (034) enforces it, this issue is the granting UX and the invitation flow on top of it.

## Motivation

034 builds the *enforcement* (workspace membership + RLS + a role enum) but no way to *grant* it. Collaboration is inert until a user can bring another person into a workspace. SPEC §1's "workspace" model implies membership management; this is it.

## Scope

- **Invitations**: create an invite (email + role) → a pending membership → an accept flow that binds the invited identity (033) to the workspace with that role. Revoke/resend; expiry.
- **Roles** (the enum from 034): **owner** (manage members + all data), **editor** (read/write data), **viewer** (read-only) — mapped to the RLS policies 034 already keys on.
- **Member management UI**: list members + roles, change a role, remove a member — quiet chrome composed from `ui/` primitives (STYLE_GUIDE §2.2/§4; `command` buttons per 026).
- **Read-only affordance**: a viewer's register/canvas/tiers render but writes are disabled *visibly* (not just rejected) — the phantom rows, compose, promote, edit-in-place all reflect the role.

Out of scope: org/team hierarchy above workspaces, per-object (project-level) permissions finer than workspace role, public share links (revisit later), presence (038).

## Design brief

- **Grant maps 1:1 to enforcement**: every role the UI offers corresponds to an RLS policy (034) — the UI never promises access the database won't back.
- **Read-only reads as calm, not broken** (STYLE_GUIDE §9): a viewer sees a coherent read surface with edit affordances absent, not error toasts on every attempt.
- **Least surprise on revoke**: removing a member stops their sync (034/032) at the boundary; document what a currently-connected removed client sees.

**References**: SPEC §1 (workspace model) · STYLE_GUIDE §2.2/§4/§9/§10 · issues 034 (RLS + role enum — the enforcement this grants), 033 (identity), 026 (command button), 016 (shell). 

## Test-first plan

1. Invite → accept → the new member's RLS scope now includes the workspace (cross-checks 034's isolation test from the other side).
2. Role enforcement: a **viewer** cannot write (UI disables it *and* RLS rejects a crafted write); an **editor** can; only an **owner** can manage members.
3. Revoke: a removed member loses read/sync access at the DB boundary.
4. Read-only UI: viewer surfaces render without phantom rows / compose / promote / in-place edit.

## Acceptance criteria

- [x] Owners invite by email + role; invitees accept and receive exactly the RLS-backed access; revoke/resend work.
- [x] The three roles map to 034's policies; viewer read-only is visible in the UI and enforced by RLS.
- [x] Member management composes `ui/` primitives; `npm run verify` green.

## Shipped notes (implementation summary)

- **Migration `0009_invitations.sql`**: Drizzle-generated `invitations` table (`workspace_id`, `email` lowercased, `role`, `invited_by_sub`, `expires_at`, `accepted_at`, standard timestamps/soft-delete — SPEC §3), followed by hand-authored policies mirroring 0008's pattern exactly:
  - `app_current_user_email()` — the email half of the identity seam (ADR-0009), reading a new `app.current_user_email` session GUC (`src/db/tenantContext.ts`'s additive `setTenantEmail`/`getTenantEmail`).
  - Two new `SECURITY DEFINER` helpers (`app_workspace_has_any_member`, `app_has_valid_invitation`) breaking the same RLS self-reference recursion 0008 hit, this time on the *tightened* `workspace_members` INSERT policy (see Deviations #1 below).
  - Full select/insert/update/delete policies on `invitations`: owner manages; the invitee sees/accepts their own row by email match.
  - **A real bug fixed along the way** (Deviations #2): `workspace_members`'s SELECT policy needed a direct self-branch, not just the subquery-based membership check, or `INSERT ... RETURNING` (exactly what `addWorkspaceMember`/`acceptInvitation` do) fails under RLS — a self-referencing subquery can't see a row inserted earlier in the *same* command. Root-caused via a scratch debug test isolating the RETURNING clause, not by guessing.
  - Verified against **real Postgres 17** via Docker (`deploy/migration-parity/check-migrations.sh`), twice (once before, once after the SELECT-policy fix) — applies cleanly from empty both times.
- **`src/domain/invitation.ts`**: pure, derived `invitationStatus` (pending/accepted/revoked/expired from timestamps only — no stored `status` column, mirroring `documentedStatus`/`isComplete`, issue 005) + `canAccept`/`canRevoke`/`canResend` guards. Unit-tested.
- **`src/domain/workspaceRole.ts`** extended with `resolveEffectiveRole(members, userSub, authConfigured)` — the client-side role-gate for read-only UI (NOT the enforcement boundary; RLS is). Solo/local mode and "never seated" workspaces both default to `owner` so v1 behavior is unaffected; an authenticated stranger among real members defaults to `viewer` (least privilege).
- **`src/db/invitations.ts`**: `createInvitation`/`listInvitations`/`acceptInvitation`/`revokeInvitation`/`resendInvitation`/`listPendingInvitationsForEmail`, typed rejections (`InvitationNotFoundError`/`InvitationEmailMismatchError`/`InvitationNotAcceptableError`, mirroring `projectEnvelope.ts`'s pattern). `acceptInvitation` is one `db.transaction` (seat the member + mark accepted).
- **`src/store/workspace.ts`**: `useWorkspaceStore` (members/invitations/role for the open workspace; invite/changeRole/removeMember/revokeInvitation/resendInvitation/acceptInvitation) + `useWorkspaceRole(projectId)` hook other surfaces call directly.
- **Member management UI** (`src/components/WorkspaceMembers.tsx`): a `Share` trigger in the app bar (gated to a signed-in Cognito session — sharing needs a real identity to invite, mirroring `AccountMenu`'s own gate) opening a Popover panel: member list (role `Combobox` + remove, owner-only; read-only display for everyone else), pending-invitation list (resend/revoke, owner-only; accepted invitations are folded into the member list, not shown twice), and an invite form (email + role + "Invite"). Composed entirely from `ui/` primitives; calm inline error (mirrors `ProjectsList`'s `.import-error`).
- **Viewer read-only UI affordance** (test-first plan #4): `readOnly` threaded into the shared primitives so one change covers every surface —
  - `EditableGrid` gained a `readOnly` prop (disables click-to-edit/keyboard-editing for every cell kind, and the phantom row never renders regardless of what a caller passes) — covers `ContextRegister`, `FoundationSurface`'s table, and `ArchitectureSurface`'s per-table grid in one place.
  - `MultilineEdit`/`InlineEdit` (`ui/`) gained the same `readOnly` prop — covers `Composer`'s justification and `FoundationSurface`'s purpose statement and `ArchitectureSurface`'s table rename.
  - `DesignSurface` computes `readOnly = !canWrite(role)` and hides "New context" entirely (not just disables it) and guards `enterCompose` itself (belt-and-suspenders); `Composer` additionally never shows bind pickers even if a caller passed `composing=true`.
  - `ArchitectureSurface` hides select/add-child/delete/promote/add-table for a viewer (selection only ever fed the promote action, so it's gone too — the selection bar naturally never appears).
  - `FoundationSurface` swaps the drag-handle `RankCell` for a plain degree span and skips the `DndContext` wrapper entirely when read-only.

## Deviations from plan / flagged for review

1. **Tightened `workspace_members` INSERT beyond just "add the invitation path".** 034's self-only INSERT policy literally allowed any authenticated caller to self-seat into ANY workspace at ANY role (including `owner`, the column default) merely by knowing its id — done/034 itself calls this "self-bootstrap-only, deferring 'owner invites another sub' to 035" but the policy as shipped didn't actually gate joining an *existing* workspace at all. This migration closes that: self-insert is now allowed only when the workspace has zero members yet (bootstrap) OR a valid, role-matching invitation is being redeemed; an owner can still seat anyone directly. Covered by new tests proving both the closed gap (`invitationRls.test.ts`) and that bootstrap still works. **Please confirm this reading of 034's intent is correct** — I read the deferred scope note as meaning the self-branch should eventually require an invitation for joining someone else's workspace, but 034's own code/tests never actually exercised that boundary, so this is my inference, not a spec change 034 explicitly asked for.
2. **A real RLS bug in 034's `workspace_members` SELECT policy**, surfaced only because this issue's tests are the first to call `addWorkspaceMember`/`acceptInvitation` under the non-owner `app_user` role (034's own tests always used the superuser/table-owner path). Fixed in this migration (see Shipped notes) — flagging since it touches 034's shipped policy, not just new surface.
3. **Client-side role gating is a UX affordance, not enforcement.** This app's own PGlite connection is always the table owner (migration 0008's header), so RLS is inert against it locally regardless of `resolveEffectiveRole`'s answer — the real enforcement boundary is server Postgres RLS (proven via `SET ROLE app_user` in `workspaceRls.test.ts`/`invitationRls.test.ts`) behind 043's write-path API. `readOnly` in the UI exists so a viewer isn't invited to edit something that would be silently rejected (or lost) once sync tries to push it upstream — not because the local write is actually blocked today.
4. **No email resolution for member display.** `workspace_members` only stores a Cognito `sub`, not an email — the member list shows the raw sub (with "(you)" for the caller). Resolving subs to emails would need either a Cognito admin API call (out of scope, no live AWS calls in this codebase yet) or denormalizing email onto `workspace_members` at accept time (a real option, deliberately not done here to keep the migration's blast radius to exactly what the issue's test-first plan needed — flag if wanted as a fast-follow).
5. **Dimension/parameter structure management (`DimensionManager`) is NOT gated read-only for a viewer.** The design brief's read-only list ("phantom rows, compose, promote, edit-in-place") maps to content editing on the three tiers, which is fully gated; adding/removing dimensions is a structural operation I judged out of this issue's explicit scope (it's still backed by the same RLS write policies at the DB/server boundary either way). Flag if this should also be gated in a follow-up.
6. **No dedicated invitation-accept e2e/UI flow.** Accept is fully implemented and tested at the domain/db/store layer (`acceptInvitation` in `invitations.ts`/`workspace.ts`), including the RLS-boundary lifecycle test in `invitationRls.test.ts` — but there's no UI screen for "you got an email, click a link, land on an accept page" (that depends on 033's Google/email-link fast-follow and a real email-sending mechanism, both out of scope for this repo today, which has no live Cognito/AWS calls in tests per HANDOFF).
