# 057: Shared-workspace membership / accept-seat model (break 1-user ↔ 1-workspace)

- **Status**: OPEN
- **Milestone**: M9 (Identity & tenancy)
- **Blocked by**: 056 (mutation protocol + write-path must carry `invitations`/`workspace_members` before an accept can be represented as a mutation), 034 (workspaces + RLS — the `workspace_members` table, roles, and RLS policies this issue authorizes against already exist and must not be re-derived)

## Slice

Part 2 of the 055 sharing fix (056 → **057** → 058, plus optional 059). This issue closes 055's **Cause 3**, the deepest of the three: even with the protocol fixed (056) and the read-path deployed (058), an invited user today has **no workspace to join** — `workspaceIdForSub(sub)` (`src/domain/workspaceId.ts:41-43`) derives one workspace per Cognito `sub`, used identically by the server provisioning trigger (050) and the client (`src/store/auth.ts`) and by the write-path's own tenancy derivation (`src/server/writeApi/jwt.ts:59`: `workspaceId: workspaceIdForSub(sub)`). Every distinct `sub` is permanently scoped to its own personal workspace; nothing today lets an invited user's session attach to the **inviter's** workspace instead.

This is explicitly **the invariant-breaking core** of the whole 055 fix — call it out to the human reviewer, don't quietly absorb it into a "just add a table" change.

## Problem / Goal

From 055's "Fix direction" item 3 and `docs/HANDOFF.md`'s "Clear next steps" #3:

> Sharing needs the workspace to come from the **mutation envelope + a membership check** (RLS), not the sub — revisit `jwt.ts`/`handler.ts` tenancy when 035 goes live.

Today's tenancy chain, end to end:

1. `src/server/writeApi/jwt.ts:59` — `verifyBearerToken` returns `claims.workspaceId = workspaceIdForSub(sub)`, a **pure function of the caller's own identity**, never looked up against any membership table.
2. `src/server/writeApi/tenancy.ts:46` — `checkTenancy` rejects any mutation whose `envelope.workspaceId !== claims.workspaceId`. Since `claims.workspaceId` is always the caller's OWN personal workspace, **a mutation targeting any other workspace is unconditionally rejected**, no matter how legitimately the caller was invited into it.
3. `src/store/auth.ts` / `src/store/sync.ts:160-163` (`setWorkspaceId`) — the client scopes every outgoing mutation's `workspaceId` to the signed-in user's own `workspaceIdForSub(sub)` too, so even client-side, there is no code path that lets a client emit a mutation envelope claiming the inviter's workspace.

**Goal**: an invited user, after accepting, can write into the **inviter's** workspace — the write-path derives/authorizes the target workspace from **(a)** the mutation envelope's declared `workspaceId` **and (b)** a server-side `workspace_members` row (RLS-backed, from 034) proving that `(sub, workspaceId)` is a real, accepted membership — not from `workspaceIdForSub(sub)` alone.

## Design brief

This is part of the 055 sharing fix (056 → 057 → 058, plus optional 059 as an immediate mitigation) — 057 is the model change that makes a shared workspace nameable and joinable at all.

- **`workspaceIdForSub(sub)` does not go away.** It remains the mechanism for a user's own *personal* workspace (050's provisioning trigger still needs it, and a solo user with no collaborators keeps today's exact behavior — "signed-out / sync-off stays byte-for-byte unchanged" is this repo's recurring backward-compatibility bar, see `src/store/sync.ts:99-104`'s "sync is additive, never load-bearing" framing). What changes is that it becomes **one of potentially several** workspaces a `sub` may legitimately write into, not the *only* one.
- **Authorization moves from "derive" to "look up + check".** `checkTenancy` (`tenancy.ts:41-62`) must resolve *whether the caller is a member of the envelope's declared workspace*, not merely compare it against a derived id. This requires a new `WriteStore`/`WorkspaceScopeResolver` method — e.g. `isMember(workspaceId: string, sub: string): Promise<boolean>` — backed in `PgWriteStore` by a `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_sub = $2 AND deleted_at IS NULL` query, and in `InMemoryWriteStore` by a seeded membership set.
- **RLS is the backstop, the API check is defense-in-depth** — same posture 043/ADR-0010 already established for tenancy (`tenancy.ts`'s own header comment: "rejects cross-tenant writes independent of RLS (defense-in-depth)"). 034's RLS policies on `workspace_members`/`invitations` already enforce membership at the Postgres layer (`done/035-sharing-roles-invitations.md`'s migration `0009` notes); this issue's job is to make the **API-layer** check agree, not to touch RLS policy SQL itself unless a gap is found.
- **The accept flow itself.** `dbAcceptInvitation` (`src/db/invitations.ts`, called from `useWorkspaceStore.acceptInvitation`, `workspace.ts:127-139`) already seats the member locally in PGlite via one transaction. The gap is purely on the sync/write-path side: accepting needs to (a) enqueue a `workspaceMembers` upsert mutation (056 makes this representable) scoped to the **inviter's** workspace id (available on the `InvitationRow`), and (b) the write-path must accept that mutation despite the caller's JWT-derived `workspaceIdForSub(sub)` being a *different* id — which is exactly the membership-check relaxation above.
- **Client-side workspace selection**: once seated in more than one workspace, `useSyncStore`'s single `workspaceId` field (`sync.ts:104`, "the workspace a flush's MutationEnvelopes are scoped to") is no longer sufficient for a user who belongs to N workspaces — decide during implementation whether v1 of this issue scopes to "the workspace of whichever project is currently open" (mirroring `useWorkspaceRole`'s existing per-project resolution, `workspace.ts:146-156`) rather than building a full workspace-switcher UI, which is out of scope here.

## Files / layers touched

- `src/server/writeApi/tenancy.ts:41-62` (`checkTenancy`) — accept a mutation whose `workspaceId` differs from `workspaceIdForSub(sub)` IF a membership check passes.
- `src/server/writeApi/jwt.ts:24-27,59` (`CognitoClaims`) — reconsider whether `claims.workspaceId` should still be a single derived value, or whether tenancy should stop reading it altogether and instead resolve membership per-mutation from `claims.sub` + `mutation.workspaceId`. Document the chosen shape; this is the crux of the invariant break.
- `src/server/writeApi/store.ts` (`WriteStore`) — new `isMember`-style method; `InMemoryWriteStore` + `PgWriteStore` implementations.
- `src/db/workspaces.ts` — likely already has the query shape needed (`listMembers`); confirm and reuse rather than duplicating.
- `src/store/workspace.ts:127-139` (`acceptInvitation`) — enqueue the seat mutation on accept.
- `src/store/sync.ts` — workspace-scoping for a multi-workspace-member client (see Design brief's last bullet); may need `workspaceId` to become resolvable per-mutation/per-project rather than one global store field, depending on how far this issue goes.

## Test-first plan

1. **Tenancy unit test (the invariant-break assertion)**: `src/server/writeApi/tenancy.test.ts` — a mutation whose `workspaceId` is NOT `workspaceIdForSub(claims.sub)` but where the store has a seeded `workspace_members` row for `(workspaceId, claims.sub)` is **accepted** (`ok: true`) — currently red, `checkTenancy` rejects it outright as `cross_tenant` today (`tenancy.ts:46-48`). A second test: the same shape WITHOUT a seeded membership row is still rejected (`cross_tenant`) — proving the relaxation is membership-gated, not a blanket removal of tenancy.
2. **Write-path contract test**: `src/server/writeApi/handler.test.ts` — an authenticated caller (JWT `sub` = user B) submits a `workspaceMembers` upsert mutation targeting user A's workspace, having been seeded as a member of it; asserts `status: 'applied'`. A parallel test with NO seeded membership asserts `status: 'rejected', reason: 'cross_tenant'`.
3. **Accept-flow store test**: `src/store/workspace.test.ts` — `acceptInvitation` enqueues a mutation whose `workspaceId` is the invitation's (inviter's) workspace, not the accepting user's own `workspaceIdForSub(sub)`.
4. **RLS cross-check** (mirrors 035's own `invitationRls.test.ts` discipline): confirm (via a new or extended `src/db/workspaceRls.test.ts` case) that a real `SET ROLE app_user` session for the invited sub can read/write within the shared workspace post-accept, and NOT before.
5. **E2E (deferred until 058 read-path exists, but the write-side half can be verified now)**: two-identity test — user A invites user B; user B accepts; user B's next mutation (e.g. renaming a shared project) is `applied`, not `rejected`, and is verifiable via the 049 debug API. Full "B *sees* A's project" assertion waits on 058.

## Acceptance criteria

- [ ] `checkTenancy` authorizes a mutation into a non-own workspace given a real, seeded membership row; rejects it otherwise.
- [ ] `acceptInvitation` enqueues a `workspace_members` seat mutation scoped to the inviter's workspace.
- [ ] All Test-first plan items 1-4 pass (item 5's full assertion may remain partially blocked on 058, but the write-half must be independently verifiable).
- [ ] `npm run verify` green.
- [ ] Live smoke: two real Cognito identities, A invites B, B accepts, B's write against A's workspace returns `applied` from `/write` (verified via 049 debug API), not `401`/`403`.

## Dependencies / ordering

Blocked by 056 (need `workspaceMembers` representable in the protocol before an accept can enqueue it) and 034 (the `workspace_members` table/RLS this issue authorizes against). Blocks 058 (the read-path's per-workspace scoping needs a real notion of "which workspaces is this sub a member of" — the same membership check this issue introduces).

## Risks

- **This is the one issue in the 055 series that changes a load-bearing security invariant**, not just adds a table. `checkTenancy`'s current single-line comparison (`mutation.workspaceId !== claims.workspaceId`) is the ENTIRE defense-in-depth tenancy check today; relaxing it to "or a verified membership row exists" must be reviewed with the same scrutiny as the RLS policies themselves — a bug here is a cross-tenant data leak, not a UX bug. **Flag for explicit human sign-off before merge**, not just green tests.
- **`workspaceIdForSub(sub)` callers elsewhere may implicitly assume "one sub, one workspace."** Audit `src/store/auth.ts`, `src/server/provisionWorkspace/handler.ts`, and any other caller (`grep -rn workspaceIdForSub src`) to confirm none of them silently break once a sub can be a member of more than one workspace — this issue must not just fix the write-path in isolation while leaving another module's assumption stale (CLAUDE.md Rule 12 — grep every reference type, not just the obvious call site).
- **Client-side multi-workspace scoping is genuinely unresolved design**, not just an implementation detail — `useSyncStore.workspaceId` is a single global value today (`sync.ts:104`). Deciding "which workspace does THIS mutation belong to" for a multi-workspace member touches `projects.ts`'s `workspaceId` per project (already present, `projectEnvelope.ts:49-57`) more than a new global — prefer deriving per-mutation from the project's own `workspaceId` column over introducing a global "current workspace" concept, but confirm during implementation; don't guess architecture under this issue without checking back against 037's on-ramp model (which also touches multi-workspace membership) for consistency.

**References**: 055 (this bug, Cause 3 and "Fix direction" item 3), 034 (`done/034-workspaces-rls-tenancy.md` — RLS + role enum this issue must not re-derive), 035 (`done/035-sharing-roles-invitations.md`, Deviation #1 — the `workspace_members` INSERT-policy tightening already anticipates "an owner invites another sub", which is exactly what this issue's seat-mutation exercises server-side for the first time), 050 (`workspaceIdForSub`, provisioning trigger), 043/ADR-0010 (tenancy check is defense-in-depth alongside RLS — the posture this issue extends, not replaces), `docs/HANDOFF.md` "Clear next steps" #3, `docs/DEPLOYMENT.md §9a` "What is still open" ("Personal-workspace-only... 035's sharing model would need the workspace to come from the mutation envelope + a membership check, not the caller's sub").
