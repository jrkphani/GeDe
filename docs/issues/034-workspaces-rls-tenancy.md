# 034: Workspaces + Postgres RLS multi-tenancy

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 032 (sync), 033 (auth)

## Slice

As a collaborator my data lives in a **workspace**, and the server enforces — via **Postgres Row-Level Security** — that I only ever read or sync rows in workspaces I belong to. Isolation is a database guarantee, not app-layer trust: even a buggy client or a crafted sync request cannot cross the tenant boundary.

## Motivation

SPEC §1 defines v2 as "workspace RLS + realtime row-delta sync", and TECH_STACK §2 chose Postgres specifically because "RLS policies … written in v1 carry over verbatim" and its RLS is more mature than the alternatives' (§2 rejections of MySQL/Aurora). This issue introduces the workspace as the tenancy unit and the RLS policies that make sync safe for more than one user.

## Scope

- **Workspace model** (migration): a `workspaces` table + membership (`workspace_members` with a user↔workspace role), and a `workspace_id` on the tenant-scoped tables (projects and everything under them). UUIDv7 keys + the standard timestamps/soft-delete, consistent with every other table (§3).
- **RLS policies**: enable RLS on all tenant tables; policies scope `select`/`insert`/`update`/`delete` to the authenticated user's workspace memberships (identity from 033). The **sync stream (032) must run under RLS** so a client only ever receives its workspaces' deltas.
- **Migration of existing single-user data**: v1 projects have no workspace — provide a personal/default workspace so existing rows get a home (dovetails with 037's local→cloud adoption).
- **Same migrations everywhere**: policies live in the Drizzle migration history and apply to both PGlite (where they're inert/permissive for the single local user) and server Postgres (where they enforce) — no dialect fork.

Out of scope: sharing/invitations/role UX (035 — this issue is the *enforcement* layer; 035 is the *granting* UX), org/billing hierarchy above workspaces, per-row ACLs finer than workspace membership.

## Design brief

- **Isolation is a DB invariant**: RLS is the backstop — the app may also scope queries, but correctness must not depend on the client behaving. A cross-tenant read is impossible at the Postgres layer.
- **Carry over, don't reinvent** (§2): the policies are written against the schema that was designed for them; the v2 boundary adds tenancy columns + policies, not a redesign.
- **Local stays simple**: on PGlite (single local user) the workspace is a formality — one personal workspace, policies permissive — so the local-first app is unchanged (SPEC §1).
- **Least privilege by role**: membership carries a role (owner/editor/viewer) that 035 grants and RLS can read; define the role enum here even though the granting UX is 035.

**References**: SPEC §1 (workspace RLS + realtime sync), §3 (schema invariants) · TECH_STACK §2 (Postgres-for-RLS rationale, "carry over verbatim"), §6.3 · issues 032 (sync must respect RLS), 033 (identity), 037 (adopt local data into a workspace), 015 (export envelope may need a `workspace_id` field bump → `formatVersion: 2`).

## Test-first plan

1. **Isolation (integration, the load-bearing test)**: a client in workspace A cannot `select`/sync any workspace-B row — via query *and* via the sync stream (032). Attempted cross-tenant writes are rejected by RLS, not just the app.
2. **Membership scoping**: adding/removing a member changes exactly which workspaces' rows they can reach; role differences (viewer cannot write) enforced by policy.
3. **Migration parity**: the workspace tables + RLS policies apply from the Drizzle history to both PGlite (permissive) and server Postgres (enforcing) — no hand-edited DDL.
4. **Single-user preserved**: with one local user + a default workspace, every existing test passes (tenancy is transparent locally).

## Acceptance criteria

- [ ] A `workspaces` + membership model with `workspace_id` on tenant tables; RLS enabled and enforcing on the server for select/insert/update/delete.
- [ ] The sync stream (032) delivers only the client's workspaces' rows — proven by a cross-tenant isolation test at both the query and sync boundaries.
- [ ] Policies ship as migrations applying to PGlite (inert) and Postgres (enforcing); existing single-user data gets a default workspace with no regression.
- [ ] `npm run verify` green.

## Implementation notes

- If Supabase is the engine (031), its RLS + policy tooling is the native path; if Electric, author policies directly and confirm Electric honors them on the sync boundary (this was a 031 scoring criterion — hold it to that).
- Export/import (015) gains a `workspace_id` and bumps to `formatVersion: 2`; keep the v1 envelope importable (remap into the importer's chosen workspace) so backups survive the boundary.
- The role enum (owner/editor/viewer) defined here is consumed by 035's invitation/granting UX — keep it minimal until a real permission need appears.
