# 080: Accepting an invitation is rejected `cross_tenant` — the write-path tenant guard blocks the very mutation that creates the membership

- **Status**: OPEN — **root cause diagnosed & code-verified; fix not yet scoped (awaiting decision).** Diagnosis only; no code changed.
- **Milestone**: M9/M8 — sharing (055/#8) accept/seat path
- **Severity**: **Critical** — the next (and likely last) blocker in the sharing chain. With 078 + 079 fixed, an invitee now *receives* the invite, but **accepting it never persists**, so they never join the workspace or see the shared project. Blocks every invitee, deterministically.

## Symptom (live two-account e2e, after 079 fix)

Invitee B accepts the pending invite. The client POSTs to `/write` a `workspace_members` insert for the **inviter's** workspace (`8306e508`, which B is not yet a member of). Server returns **HTTP 200** but rejects the mutation:
```json
{"outcomes":[{"status":"rejected","reason":"cross_tenant",
  "message":"That change is outside your workspace and was not saved."}]}
```
The client optimistically sets `invitations.accepted_at` locally, but the membership never persists server-side → B never joins → the shared project never appears. Captured payload: `scratchpad/e2e-079-share/debug9-write-requests.json`.

## Root cause — the tenant guard gates the seating mutation on the seat it would create

`src/server/writeApi/checkTenancy` (`tenancy.ts:75-83`), called from `handler.ts:90` before `applyIfNew`:
```ts
if (mutation.workspaceId !== claims.workspaceId) {
  const isMember = await resolver.isMember(mutation.workspaceId, claims.sub) // store.ts:399-410
  if (!isMember) return { ok: false, reason: 'cross_tenant' }
}
if (mutation.op === 'insert') return { ok: true }   // insert's ONLY gate is isMember
```
For a first-time accept, `mutation.workspaceId` (inviter's) ≠ `claims.workspaceId` (invitee's own), and `isMember` is **necessarily false** — because the `workspace_members` insert being authorized *is itself* the row that would make it true. `checkTenancy` always runs strictly before the row exists, so **every first-time accept hits this**; it's inherent to the ordering, not an edge case.

There is **no carve-out** in `tenancy.ts`/`handler.ts`/`store.ts` for `workspace_members` inserts or `invitations` updates — they're treated exactly like `projects`/`dimensions` edits.

## What the accept flow emits (`store/workspace.ts:241-291`, `db/invitations.ts:106-131`)

1. `dbAcceptInvitation` applies **locally** (PGlite): validates the invite (exists, acceptable, `invitation.email === userEmail`), upserts `workspace_members`, sets `invitations.accepted_at`.
2. Enqueues **one** sync mutation: `{table:'workspace_members', op:'upsert', workspaceId: <inviter's>}` (the rejected one).
3. **Secondary gap**: the `invitations.accepted_at` update is **never enqueued** — it stays local-only. So even after the membership insert is fixed, the invite's accepted state won't reach RDS by this path (mirrors 060's residual decline/accept sync gap).
4. No dedicated accept endpoint exists (`src/server` has no `*accept*`); accept goes through the fully generic `/write` → `checkTenancy` path.

## Was this supposed to be handled? — intended by 057, never actually implemented for the real case

`docs/issues/done/057-shared-workspace-accept-seat-model.md` states the goal ("an invited user, after accepting, can write into the inviter's workspace… proving (sub, workspaceId) is a real, accepted membership") and claims `checkTenancy` + the accept enqueue shipped green. But the tests codify the gap:
- `handler.test.ts:380-396` — the "membership relaxation" test **pre-seeds** `seedMembership(WS_A,'user-b')`, i.e. only covers a write by an **already-seated** member.
- `handler.test.ts:398-414` — *"rejects the identical shape as cross_tenant when the caller has NO membership row"* asserts **`rejected/cross_tenant` as the correct outcome** — this is B's exact live payload, codified as intended behavior.

So 057 conflated "accept enqueues the mutation" with "the mutation will be authorized," never noticing `isMember` must run before the seating row exists. 057/060's own live two-identity smoke was **deferred** and only ran now (via 060's UI wiring), which is what exposed it. Not a regression — an unimplemented carve-out.

## Security requirements for a correct fix

The carve-out must be **authorization, not a hole**: permit a `workspace_members` self-insert (`payload.userSub === claims.sub`) into a foreign workspace **only when** a valid pending invitation authorizes it —
- a live (`deleted_at IS NULL`), non-expired, not-already-accepted `invitations` row,
- whose `workspace_id` = `mutation.workspaceId`,
- whose `lower(email)` = `lower(claims.email)` — the **server-verified** JWT email (`jwt.ts:36,69-70`), never client-supplied.
- **Fail closed**: if `claims.email` is absent (confirm the deployed token flow against `/write` actually carries `email`), reject — never fall back to trusting unverified input.

Missing primitive: the write store has **no invitation lookup** (`store.ts` `FK_SCHEMA` only checks the workspace FK exists, never invite content). A new `findPendingInvitation(workspaceId, email)` is required — none of the fixes can be built from existing primitives. RLS (034) should independently enforce the same invariant (defense-in-depth, per 057's own framing).

## Candidate fixes (choose after review — none implemented)

1. **Server-side accept carve-out in checkTenancy/handler** — when `table==='workspace_members' && op==='insert' && payload.userSub===claims.sub`, authorize iff `findPendingInvitation(mutation.workspaceId, claims.email)` matches; ideally mark the invitation accepted in the same server tx (closing the §2 `accepted_at` sync gap too). Tradeoff: modifies the single load-bearing tenancy check (057 flagged it for "RLS-level scrutiny") — must be narrowly scoped + red-first tested + RLS-backed.
2. **Dedicated `/accept` endpoint** (shape like `provisionWorkspace`) that verifies JWT, loads + validates the invite, and does the membership insert + invite update server-authoritatively, bypassing the generic guard. Tradeoff: cleaner isolation of the security-critical path, but duplicates auth/DB wiring + new route/deploy surface, and the client accept must call it (or a new queue envelope).
3. **Handler-level special-case for these two tables** before `checkTenancy` — keep the tenancy primitive generic/minimal, run the invite-validated authorization in `handleWriteRequest`. Tradeoff: two authorization paths a reviewer must know to check together.

All three need the same new **verified-email-gated pending-invitation lookup**.

## Test-first plan (red first)

- Flip `handler.test.ts:398-414` from asserting `rejected/cross_tenant` to asserting the accept is **applied** when a matching pending invite exists for the caller's verified email; add negatives: **no** matching invite → still `cross_tenant`; email mismatch → rejected; expired/accepted/deleted invite → rejected; `payload.userSub !== claims.sub` (seating someone else) → rejected; `claims.email` absent → rejected (fail closed).
- Add a test that the `invitations.accepted_at` update reaches the server (whichever path the fix chooses).

**References**: `src/server/writeApi/{tenancy.ts:70-94, handler.ts:90-129, store.ts:399-410,58, rejection.ts, jwt.ts:36,69-70}`, `src/store/workspace.ts:241-291`, `src/db/invitations.ts:106-131`, `docs/issues/done/{056,057,060}-*.md`, tests `handler.test.ts:378-414`, `tenancy.test.ts:73-78`. Evidence: `scratchpad/e2e-079-share/debug9-write-requests.json`.
