# 067: `workspace_members` is never streamed to clients — shared Members list diverges per user

- **Status**: SHIPPED
- **Milestone**: M9 — sharing correctness (consistent membership view)
- **Severity**: Medium — data-correctness on the Members UI; sharing delivers the *project* but not a consistent *membership* view.
- **Found via**: functional review of the open sharing issues (2026-07-10).

## Symptom / discrepancy

`workspace_members` is excluded from `SYNCED_TABLES` (`src/domain/syncScope.ts` — "invitations/workspace_members are deliberately NOT included"). 062 added `invitations` to the streamed set but left `workspace_members` out. The shape proxy queries `workspace_members` *server-side* to resolve scoping (correct, unchanged), but **no client ever receives member rows**. So:

- When an invitee accepts, they write + flush their own `workspace_members` row to RDS (057), but the **owner's client never receives it** → the owner's "Members" panel (`WorkspaceMembers.tsx`) doesn't show the new member appear.
- A seated invitee never receives the **other** members' rows → their Members list is incomplete.
- Each user's membership view is built from their own local PGlite and **diverges**. Role changes / removals made by the owner (which *do* flush, 056) also don't propagate to other members' views.

## Root cause

The membership table was intentionally kept out of the Electric-synced set (056/058 scope note), on the assumption the shape proxy only needed it server-side. But the client-facing Members UI needs the rows too, and once real sharing exists (060/062), multiple users must see a **consistent** membership list.

## Fix direction

Add `workspace_members` to `SYNCED_TABLES`, scoped **membership-only** (NOT email — unlike invitations): you must be a member of a workspace to see its member list.
- The scope rule already exists: `syncScope.ts` `workspace_members: 'workspace_id = ANY($1::text[])'` — keep it membership-scoped and **fail-closed on empty membership** (a non-member receives nothing; do not apply the by-email relaxation 062 added for invitations).
- The client already has an apply case for `workspace_members` (`src/db/sync.ts`, from 056); ensure the `WorkspaceMembers` store/panel refreshes when inbound member deltas apply (same pattern 062 used for invitations via `invitationsAppliedAt` → a `membersAppliedAt` bump, or reuse the workspace store's load).
- Migration: `workspace_members` will need `REPLICA IDENTITY FULL` for Electric to replicate it (mirror migrations 0012/0013) — one small migration, picked up by the existing runner Lambda (no new CDK resource); update the CDK migration-count tests accordingly.

## Test-first plan

- Scope/handler: a member of workspace W receives `workspace_members` rows for W; a **non-member receives nothing** (fail-closed) — no cross-workspace leak. Membership-only (a passed-in email must NOT widen it, unlike invitations).
- Client: after inbound `workspace_members` deltas apply, the Members panel reflects the new/changed/removed members (owner sees an accepted invitee appear; a role change propagates).
- Migration/CDK: the new replica-identity migration bumps the count; CDK migration tests updated; `cdk synth` green.

## Dependencies / ordering

Blocked by 062 (establishes the "add a table to SYNCED_TABLES + membership scoping + client refresh" pattern this mirrors) and 057 (the seat rows this streams). Do after 062/066. Completes the shared-membership half of 055/#8.

**References**: 062 (the streaming pattern + `syncScope.ts` changes this extends), 057 (seat mutation that writes `workspace_members`), 056 (`workspace_members` write-path + `db/sync.ts` apply case), 058 (Electric read-path + replica-identity migrations 0012/0013), `src/components/WorkspaceMembers.tsx` (the Members panel that needs the data).
