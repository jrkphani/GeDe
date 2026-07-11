# 071: Every `/write` 502s — the caller's workspace is never provisioned in RDS, so the first project insert FK-fails

- **Status**: IMPLEMENTED (code-complete + verify:fast green; pending live deploy + smoke)
- **Milestone**: M11 — cloud write loop (production reliability)
- **Severity**: **Critical** — no signed-in user whose workspace wasn't provisioned at sign-up can save ANYTHING to the server. Every `POST /write` returns 502; data lives only in local PGlite and is lost on the 063 sign-out wipe. This is the true cause of the user report "project not saved, disappeared after logout."
- **Found via**: live e2e smoke of the 068 fix (2026-07-11) — the browser saw 5×`/write` 502; the Write Lambda's CloudWatch logs showed the exact Postgres error; a read-only code investigation confirmed the mechanism.

## Symptom (live evidence)

Write Lambda (`…WriteApiFunction…`), on every project insert:
```
Postgres 23503: insert or update on table "projects" violates foreign key
constraint "projects_workspace_id_workspaces_id_fk"
Key (workspace_id)=(8306e508-…-4b2497947d16) is not present in table "workspaces".
```
The uncaught throw becomes an unhandled Lambda error → ALB returns **502**. (Read-path 068 is fine — all `/sync` shape reads returned 200.)

## Root cause (confirmed in code)

1. **Provisioning is a one-shot Cognito `PostConfirmation` trigger, with no self-heal.** `provisionWorkspace()` (`src/server/provisionWorkspace/handler.ts:52-67`) idempotently inserts the `workspaces` row + owner `workspace_members` row. It's wired ONLY as `postConfirmation` on the user pool (`deploy/cdk/lib/auth-stack.ts:190`) — it fires exactly once, at initial account confirmation, **never on later sign-ins**. Failures are caught + logged silently (`provisionWorkspace/albAdapter.ts:107-121`), with no retry anywhere. Issue 050 explicitly put "backfill users who confirmed before this trigger existed" out of scope. So any account that predates the 2026-07-08 trigger deploy — or hit a transient blip during its single confirmation — has a **permanently unprovisioned** workspace.
2. **The write path never ensures the workspace.** `workspaces` is deliberately a non-mutable `FkReferenceTable` (`src/server/writeApi/store.ts:28-36`) — the client cannot create it. And `FK_SCHEMA.projects` is `{}` (`store.ts:45`), so the friendly FK pre-check (`resolveForeignKeys`) never validates `workspace_id`; the request sails into the raw `INSERT INTO projects` where the real Postgres FK constraint fires.
3. **The 502 (not a clean error):** `src/server/writeApi/albAdapter.ts` has no try/catch around `handleWriteRequest` (only around body parsing), so the thrown PG error is an uncaught Lambda failure → ALB 502.

## Fix direction (minimal, server-authoritative)

**Primary — self-heal the caller's OWN workspace on every write, before the mutation loop:**
1. Add `ensureOwnWorkspace(sub: string): Promise<void>` to the `WriteStore` interface (`src/server/writeApi/store.ts`).
2. `PgWriteStore.ensureOwnWorkspace` **reuses** `provisionWorkspace(sub, executor)` (import from `../provisionWorkspace/handler`) — wrap `PgWriteStore`'s own pg pool in a `ProvisionExecutor` (`{ query: (sql, params) => pool.query(sql, params) }`). Do NOT duplicate the two INSERTs. Ensures **both** `workspaces` and the owner `workspace_members` row (matching `provisionWorkspace`), so membership-dependent features also heal.
3. `InMemoryWriteStore.ensureOwnWorkspace` seeds its own workspace/membership sets for `workspaceIdForSub(sub)` (so `handler.test.ts` can assert orchestration without live Postgres).
4. In `handleWriteRequest` (`handler.ts`), right after `auth.ok` succeeds and **before** the `for` loop (line ~58): `await deps.store.ensureOwnWorkspace(auth.claims.sub)`. **Key it on the server-verified `auth.claims.sub` only — never `mutation.workspaceId`.** Idempotent + cheap (two `ON CONFLICT DO NOTHING` no-ops after the first write).

**Secondary — never surface a raw 502 again:** wrap the `handleWriteRequest` call in `src/server/writeApi/albAdapter.ts` in a try/catch that logs the error and returns a **500 with a typed JSON rejection** (mirror the existing body-parse catch), so a future write-path DB error is a diagnosable logged 500, not an opaque uncaught 502.

## Sharing-safety (must preserve 056/057)

`ensureOwnWorkspace(auth.claims.sub)` provisions only the **caller's own** workspace (derived from their verified sub), orthogonal to whichever workspace the mutation targets. An invitee writing into the owner's shared workspace never touches/re-provisions the owner's row; `checkTenancy` (`tenancy.ts:70-93`) still gates cross-workspace writes via `isMember`. Membership writes (056/057) are unaffected.

## Test-first plan (red first)

1. **`src/server/writeApi/handler.test.ts`** — new `describe('handleWriteRequest — own-workspace self-heal (071)')`: (a) *calls `store.ensureOwnWorkspace` with the caller's verified sub before processing any mutation* (spy on `InMemoryWriteStore`'s new method; assert called once, with `auth.claims.sub`, before the first `applyIfNew`); (b) *only ever with the caller's OWN sub — never a shared/member workspace id* (locks the sharing-safety property). **Fails today** (method doesn't exist). These run in CI (`verify`).
2. **`src/server/writeApi/pgWriteStore.contract.test.ts`** — assert `ensureOwnWorkspace` issues the two expected `ON CONFLICT DO NOTHING` statements against a fake pg client (mirror the file's existing SQL-shape assertions).
3. **`src/server/writeApi/pgWriteStore.live.test.ts`** (only if this suite actually runs in the local/CI harness — confirm; it needs a live PG): sibling to the fixture at ~85-90 that pre-inserts the workspace — *a first project write from a user whose workspace is NOT pre-inserted succeeds and creates the workspace + owner membership row*. If the live suite is skipped in CI, rely on 1+2 for the enforced gate.
4. Standing gate: `npm run verify:fast` green (typecheck → eslint → stylelint → vitest).

## Out of scope — but FILE as follow-ups (serious latent bugs this investigation surfaced)

Do NOT fix here, but must be tracked (candidate issue 072):
- **RLS is a no-op in production.** The write Lambda connects as the DB **owner** role (`gede_admin`) — the only credential the CDK creates (`data-stack.ts:102`, passed to the write Lambda at `api-stack.ts:432`). Postgres exempts the table owner from RLS, and migration 0008's `app_user` role has no `LOGIN`/password, so nothing connects as it. Despite doc comments claiming "connects as app_user, RLS enforced," the ADR-0010 RLS defense-in-depth **is not active**. (App-layer `checkTenancy` still enforces tenancy, so this is a defense-in-depth gap, not an open hole — but it's serious.)
- **Tenant-context key mismatch:** `PgWriteStore.withTenantContext` sets `app.current_user_id`/`app.current_workspace_id`, but RLS's `app_current_user_sub()` reads `app.current_user_sub` (`src/db/tenantContext.ts` uses the correct key). Masked by the owner-bypass; would break every write's RLS the moment the credential gap is fixed.

## Dependencies / ordering

No schema change, no migration (reuses existing `provisionWorkspace`). No CDK migration-count bump. Independent of 068/069/070 (server-side; those were client-side). **Deploy this, then re-run the persistence smoke** (`scratchpad/e2e-smoke/final/run.mjs`) — `projects` in RDS should go 2 → 3 and the project must survive sign-out/in. The two-user **sharing** test is gated on this landing (nothing persists to share without it).

**References**: `src/server/writeApi/{handler,store,albAdapter,tenancy,jwt}.ts`, `src/server/provisionWorkspace/handler.ts:52-67` (reused), `src/domain/workspaceId.ts` (`workspaceIdForSub`), `docs/issues/done/050-workspace-provisioning-sync-enablement.md` (the one-shot design this backstops), `src/db/migrations/0008_workspaces_rls.sql` (RLS policies + the credential gap noted above).
