# 035: Sharing — roles & invitations

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 034 (workspaces + RLS enforcement), 033 (auth)

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

- [ ] Owners invite by email + role; invitees accept and receive exactly the RLS-backed access; revoke/resend work.
- [ ] The three roles map to 034's policies; viewer read-only is visible in the UI and enforced by RLS.
- [ ] Member management composes `ui/` primitives; `npm run verify` green.
