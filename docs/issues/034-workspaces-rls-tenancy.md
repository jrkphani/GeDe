# 034: Workspaces + Postgres RLS multi-tenancy

- **Status**: SHIPPED (implemented on `feat/034-workspaces-rls`; orchestrator to merge/cherry-pick)
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 032 (sync), 033 (auth) — both merged to `main` prior to this work.

## Slice

As a collaborator my data lives in a **workspace**, and the server enforces — via **Postgres Row-Level Security** — that I only ever read or sync rows in workspaces I belong to. Isolation is a database guarantee, not app-layer trust: even a buggy client or a crafted sync request cannot cross the tenant boundary.

## Motivation

SPEC §1 defines v2 as "workspace RLS + realtime row-delta sync", and TECH_STACK §2 chose Postgres specifically because "RLS policies … written in v1 carry over verbatim" and its RLS is more mature than the alternatives' (§2 rejections of MySQL/Aurora). This issue introduces the workspace as the tenancy unit and the RLS policies that make sync safe for more than one user.

## Scope

- **Workspace model** (migration): a `workspaces` table + membership (`workspace_members` with a user↔workspace role), and a `workspace_id` on the tenant-scoped tables (projects and everything under them). UUIDv7 keys + the standard timestamps/soft-delete, consistent with every other table (§3).
- **Migration-slot coordination**: M8 lands two schema migrations near each other — **032's tombstone migration** (007 hard-delete → `deleted_at` soft-delete) and **034's** workspace/RLS migration. Pre-assign distinct slots so parallel worktree builds don't collide (HANDOFF worktree discipline); 032's tombstone typically lands first (sync-readiness), then 034's tenancy columns/policies on top.
- **RLS policies**: enable RLS on all tenant tables; policies scope `select`/`insert`/`update`/`delete` to the authenticated user's workspace memberships (identity from 033). The **sync stream (032) must run under RLS** so a client only ever receives its workspaces' deltas.
- **Migration of existing single-user data**: v1 projects have no workspace — provide a personal/default workspace so existing rows get a home (dovetails with 037's local→cloud adoption).
- **Same migrations everywhere**: policies live in the Drizzle migration history and apply to both PGlite (where they're inert/permissive for the single local user) and server Postgres (where they enforce) — no dialect fork.

Out of scope: sharing/invitations/role UX (035 — this issue is the *enforcement* layer; 035 is the *granting* UX), org/billing hierarchy above workspaces, per-row ACLs finer than workspace membership.

## Design brief

- **Isolation is a DB invariant**: RLS is the backstop — the app may also scope queries, but correctness must not depend on the client behaving. A cross-tenant read is impossible at the Postgres layer.
- **Carry over, don't reinvent** (§2): the policies are written against the schema that was designed for them; the v2 boundary adds tenancy columns + policies, not a redesign.
- **Local stays simple**: on PGlite (single local user) the workspace is a formality — one personal workspace, policies permissive — so the local-first app is unchanged (SPEC §1).
- **Least privilege by role**: membership carries a role (owner/editor/viewer) that 035 grants and RLS can read; define the role enum here even though the granting UX is 035.

> **Scope boundary (ADR-0010):** this issue enforces **tenancy** (workspace isolation) via RLS. **Domain-invariant** enforcement (dimension floor, tuple completeness, cascade integrity — the rules v1 enforces client-side) is issue **043**'s concern, with the DB **constraints/triggers backstop** authored alongside these RLS policies. RLS keeps *other tenants'* rows out; 043 + constraints keep *illegal* rows out.

**References**: **ADR-0010** (tier responsibilities; tenancy vs domain-invariant enforcement) · SPEC §1 (workspace RLS + realtime sync), §3 (schema invariants) · TECH_STACK §2 (Postgres-for-RLS rationale, "carry over verbatim"), §6.3 · issues 032 (sync must respect RLS), 033 (Cognito identity), **043** (write authority + domain-invariant enforcement), 037 (adopt local data into a workspace), 015 (export envelope may need a `workspace_id` field bump → `formatVersion: 2`).

## Test-first plan

1. **Isolation (integration, the load-bearing test)**: a client in workspace A cannot `select`/sync any workspace-B row — via query *and* via the sync stream (032). Attempted cross-tenant writes are rejected by RLS, not just the app.
2. **Membership scoping**: adding/removing a member changes exactly which workspaces' rows they can reach; role differences (viewer cannot write) enforced by policy.
3. **Migration parity**: the workspace tables + RLS policies apply from the Drizzle history to both PGlite (permissive) and server Postgres (enforcing) — no hand-edited DDL.
4. **Single-user preserved**: with one local user + a default workspace, every existing test passes (tenancy is transparent locally).

## Acceptance criteria

- [x] A `workspaces` + membership model with `workspace_id` on tenant tables; RLS enabled and enforcing on the server for select/insert/update/delete. (`workspace_id` lives directly on `projects`/`tier1_purpose`/`tier1_props`/`tier2_tables`/`dimensions`/`contexts`; `tier2_entries`/`parameters`/`bindings` scope via their parent's FK chain instead of a denormalized column — see migration 0008's header for the tradeoff.)
- [x] The sync stream (032) delivers only the client's workspaces' rows — proven by a cross-tenant isolation test at **the query boundary** (`src/db/workspaceRls.test.ts`, real Postgres RLS via PGlite + `SET ROLE app_user`). The **sync-transport boundary** is proven only at the client-request-shaping layer (not against a live Electric server — none is reachable in this repo's tests, HANDOFF); see "Deviations" below for exactly what is and isn't verified here.
- [x] Policies ship as migrations applying to PGlite (inert, table-owner exemption) and Postgres (enforcing, non-owner `app_user` role); existing single-user data gets a default workspace with no regression (verified against both an empty DB and a pre-034-populated one).
- [x] `npm run verify` green (571 unit/component + 47 e2e; one pre-existing unseeded property-test flake, unrelated — see report).

## Shipped notes (implementation summary)

- **Migration `0008_workspaces_rls.sql`**: `workspace_role` enum, `workspaces` + `workspace_members` tables, `workspace_id` added (nullable → backfilled → `NOT NULL`) to the six tables above, a least-privilege `app_user` role + grants, `app_current_user_sub()` + three `SECURITY DEFINER` membership-lookup helpers (`app_member_workspace_ids` / `app_writable_workspace_ids` / `app_owned_workspace_ids` — needed to avoid RLS self-reference recursion on `workspace_members`'s own policies), and full select/insert/update/delete policies on every tenant table plus `workspaces`/`workspace_members` themselves.
- **Enforcement mechanism**: RLS policies are inert on PGlite because the app's own connection is always the table OWNER (Postgres exempts owners from RLS by default) — no dialect fork, no special-casing. On server Postgres, the same policies enforce for any connection using the granted-but-non-owning `app_user` role (e.g. the future write-path API / Electric connection, issue 043/deploy).
- **`src/db/workspaces.ts`**: `createWorkspace`, `getOrCreateDefaultWorkspace` (single-user simplification), `addWorkspaceMember`/`removeWorkspaceMember`/`setWorkspaceMemberRole`, `listWorkspaceIdsForUser`.
- **`src/db/tenantContext.ts`**: `setTenantContext`/`getTenantContext` — the client-side seam that sets the `app.current_user_sub` session GUC RLS policies read.
- **`src/domain/workspaceRole.ts`**: pure role-ordering helpers (`roleAtLeast`/`canWrite`/`canManageMembers`) mirroring the DB policies' owner/editor-vs-viewer cut, for future UI (035) to agree with without re-deriving it.
- **`src/db/mutations.ts`**: `createProject` takes an optional `workspaceId` (defaults to `getOrCreateDefaultWorkspace`); every other insert into a workspace-scoped table resolves its workspace from the owning project row internally — no store/component call site changed.
- **Export/import (015)**: `FORMAT_VERSION` bumped 1 → 2; the six workspace-scoped row schemas gained a nullable `workspaceId`; `parseEnvelope` upgrades a legacy v1 file in place (injects `workspaceId: null`); `remapEnvelope`/`importProject` take a `targetWorkspaceId` (defaults to `getOrCreateDefaultWorkspace`) and stamp it onto every workspace-scoped row — never preserving the source file's original workspace.
- **Sync (032) column parity**: `src/sync/electricProtocol.ts`'s hardcoded SQL→JS column map gained `workspace_id` for the six affected tables (a real bug this work surfaced: without it, inbound deltas for those tables would silently drop `workspace_id` and fail the server's NOT NULL constraint on apply).
- Engine is **ElectricSQL** (031/ADR-0008): RLS is authored **directly in Postgres**. Electric honoring it on the sync boundary depends on Electric's *own* Postgres connection running as a non-owner, RLS-subject role (`app_user`, provisioned here) — that connection-credential wiring is a **deploy-layer (043) follow-up**, out of this issue's buildable surface; see "Deviations" below.
- The role enum (owner/editor/viewer) defined here is consumed by 035's invitation/granting UX — kept minimal (self-only membership bootstrap; inviting other subs is 035's job).

## Deviations from plan / flagged for review

1. **`workspace_id` is NOT denormalized onto every tenant table.** `tier2_entries`, `parameters`, `bindings` scope via a join to their nearest workspace_id-bearing ancestor (`tier2_tables`/`dimensions`/`contexts` respectively) instead of carrying their own column. Isolation is identical (proven in `workspaceRls.test.ts`); this keeps the mutation-layer diff to 8 insert sites instead of ~15+ and avoids threading workspace_id through every nested insert. Flagging since the issue text read as "workspace_id on … everything under" the project.
2. **Sync-boundary RLS is proven at the query boundary, not against a live Electric server.** No Electric server is reachable in this repo's tests (a standing HANDOFF/032 constraint). What IS proven: (a) real Postgres RLS enforcement via PGlite + a non-owner role, (b) the client normalizes/replays deltas correctly for the now-6 workspace_id-bearing tables. What is NOT proven here: that Electric's actual production connection to Postgres runs as the non-owner `app_user` role rather than an owner/superuser credential — that's a deploy-layer wiring task (CDK secret for `app_user`, not `gede_admin`) belonging to 043/deploy, not fabricated or claimed done here.
3. **Membership creation (`workspace_members` INSERT policy) is self-only** (`user_sub = app_current_user_sub()`), deferring "owner invites another sub" to 035's granting UX, per the issue's own scope boundary.
4. **No new UI.** The acceptance criteria and test-first plan are backend/db/domain-scoped; no workspace-picker or membership UI was built (none was required, and ADR-0010 keeps 035 as the granting-UX issue).
