# 050: Close the write loop's last mile — auto-provision a workspace on sign-in + enable sync

- **Status**: SHIPPED — deployed + verified live 2026-07-08: a fresh Cognito sign-up provisioned a cloud workspace (`workspaces`/`workspace_members` rows via the PostConfirmation trigger), and a project created in the signed-in frontend flushed through `/write` and landed in RDS (`/debug/db/counts` `projects` ≥ 1). Four latent bugs surfaced by this live end-to-end test were hotfixed directly on `main` and are filed as issues 051–054.
- **Milestone**: M11 (Close the cloud write loop)
- **Blocked by**: 033 (Cognito — SHIPPED), 034 (workspaces/RLS — SHIPPED), 043/046 (write path — SHIPPED & LIVE), 048 (client flush — SHIPPED), 049 (debug API to verify — SHIPPED & LIVE)

## Slice

As a signed-in user, on first confirm the system **auto-creates my personal workspace in the cloud** (a `workspaces` row + my `workspace_members` owner row in RDS) and tells my client which workspace it is, so that when I create a project the client's write-queue **flushes to `/write`, passes tenancy, and the project lands in RDS** — verifiable via 049's `/debug/db/counts` flipping from 0 → ≥1.

## Motivation

The M11 write loop is deployed but **provably inert**: 049 shows 0 rows in every cloud domain table because three last-mile seams were never connected, and one required piece **doesn't exist at all**:

1. **No cloud-workspace-creation path.** The write path (`src/server/writeApi/store.ts`) only accepts `projects/tier1*/tier2*/dimensions/contexts/parameters/bindings` — **`workspaces`/`workspace_members` are excluded by design**, and `getOrCreateUserWorkspace(db, sub)` runs against **local PGlite only**. So the client physically cannot create a cloud workspace, and the write path **rejects** any project write whose workspace isn't already in RDS with the caller as a member (034 tenancy/RLS). This is the missing piece.
2. **Client never learns/sets its workspace.** Nothing calls `useSyncStore.setWorkspaceId(...)` (048's documented no-op seam) → `flush()` finds no workspace and never runs.
3. **Sync is off in the deployed build.** `isSyncEnabled()` reads `VITE_SYNC_ENABLED === 'true'`, which the deploy build never sets.

Result: a frontend action persists only to local PGlite. This issue supplies the missing server-side provisioning and connects the three seams so writes actually land.

## Ground truth (verified 2026-07-08 via the 049 debug API)

- `/debug/db/counts` (live): `workspaces: 0`, `workspace_members: 0`, `projects: 0`, `applied_mutations: 0` — nothing has ever flowed.
- Write path table allow-list excludes `workspaces`/`workspace_members` (`store.ts` `FK_RESOLUTION`/`MutationTable`).
- `src/db/workspaces.ts` `getOrCreateUserWorkspace` is the exact provisioning logic to reuse, but it targets a local `Database`.

## Scope

- **A deterministic personal-workspace id — a shared pure function `workspaceIdForSub(sub)`** (e.g. UUIDv5 over a fixed namespace + the `sub`), imported by BOTH the server trigger and the client. This is the keystone: because the id is a pure function of the `sub` (which is already in every token), the client knows its workspace id with **no Cognito schema change, no custom attribute, no `AdminUpdateUserAttributes`, and no lookup endpoint**. Deviating from the repo's UUIDv7 default here is deliberate and required (the id must be reproducible from the `sub`); document it.
- **Server-side workspace provisioning (the missing piece) — a Cognito Post-Confirmation Lambda trigger.** On confirm, connect to RDS (VPC, `pg` + pinned RDS CA, Secrets Manager creds — mirror `writeApi/albAdapter.ts`) and, idempotently: insert a `workspaces` row with `id = workspaceIdForSub(sub)` (`'My Workspace'`) + a `workspace_members` owner row for the user's `sub` (`ON CONFLICT DO NOTHING` so re-confirm/replay is a no-op).
- **Auth stack (CDK):** attach the Post-Confirmation trigger Lambda to the existing User Pool (a `LambdaConfig` change — **in-place, NOT a pool replacement**; do NOT alter the pool `Schema`); give the Lambda VPC config + the DB SG ingress rule + `secretsmanager:GetSecretValue` on the DB secret. **No custom attribute, no `AdminUpdateUserAttributes`** — verify via `cdk diff` that the User Pool is *modified*, never *replaced*.
- **Client wiring:** on sign-in, read `sub` from the decoded token, compute `workspaceIdForSub(sub)`, and call `setWorkspaceId(...)`; ensure a locally-created project while signed-in carries that `workspace_id` so the flushed `MutationEnvelope` is scoped correctly (034 denormalization). Signed-out / no-`sub` → stay local, no crash.
- **Enable sync in the build:** inject `VITE_SYNC_ENABLED=true` into the deploy build env (same mechanism as `VITE_COGNITO_*`).

Out of scope: multi-workspace UI/switching; sharing/invitations flows (035 already exists); the Electric read-path streaming those rows back (a separate concern — this issue proves the *write* lands via the 049 debug API, not the round-trip render); backfilling workspaces for users who confirmed before this trigger existed (fresh sign-up covers the test).

## Design brief

- **Provisioning is server-authoritative** (ADR-0010): the client can't be trusted to create tenancy rows, and the write path deliberately won't; a Cognito trigger is the natural server hook that runs exactly once per user, in-VPC, with least-privilege.
- **The workspace id is derived, not stored or fetched.** Both sides compute `workspaceIdForSub(sub)` from the token's `sub` — no side-channel, no Cognito schema change, no lookup, no risk of a User Pool replacement. The server trigger writes rows at that id; the client scopes writes to that id; they agree by construction.
- **Idempotent + safe.** Re-invocation (or an existing user) reuses the oldest membership rather than spawning duplicates (mirror `getOrCreateUserWorkspace`). A provisioning failure must not brick sign-in more than necessary — log + surface, don't corrupt.
- **Reuse the proven Lambda shape** (046/049): VPC + `pg` + pinned CA (verified TLS, `rejectUnauthorized: true`) + Secrets Manager. No new pattern.

**References**: 034 (`workspaces`/`workspace_members` schema + RLS + the `getOrCreateUserWorkspace` logic to lift server-side), 043/046 (write path + Lambda/pg/CA/secret pattern), 048 (`setWorkspaceId`/`flush` seam this finally drives), 033 (Cognito pool + token/`wireIdentity`), 049 (the debug API that verifies the write lands), 037 (local→cloud adoption — related but this is the minimal provisioning) · ADR-0009/0010 · DEPLOYMENT §9.

## Test-first plan

1. **`workspaceIdForSub` (unit)**: pure, deterministic, stable across calls, and identical when imported from the client vs the server path (same `sub` → same id); different `sub`s → different ids.
2. **Provisioning core (unit, injected pg)**: a PostConfirmation event → inserts exactly one workspace (`id = workspaceIdForSub(sub)`) + one owner membership; a second event for the same `sub` is idempotent (`ON CONFLICT`, no duplicate).
3. **Client wiring (unit)**: given a token with a `sub`, sign-in calls `setWorkspaceId(workspaceIdForSub(sub))`; signed-out / no `sub` → no crash, stays local (flush no-op).
3. **Project scoping (unit)**: a project created while signed-in with a workspace produces a `MutationEnvelope` carrying that `workspace_id`.
4. **CDK assertions**: Auth stack has the custom attribute + the Post-Confirmation trigger Lambda (VPC, DB SG, the three IAM grants); `ECS::Service` count unchanged.
5. **Live smoke (the whole point)**: fresh Cognito sign-up + confirm → `/debug/db/counts` shows `workspaces` and `workspace_members` = 1; then create a project in the frontend → counts show `projects` = 1 and `applied_mutations` ≥ 1. **This is the end-to-end proof.**

## Acceptance criteria

- [ ] A fresh confirmed user has exactly one cloud workspace + owner membership in RDS (idempotent); their token carries `custom:workspace_id`.
- [ ] Signed-in project creation flushes to `/write`, passes tenancy, and **lands in RDS** — `/debug/db/counts` proves `projects`/`applied_mutations` > 0.
- [ ] Signed-out / missing-claim paths are unchanged (local-first, no crash); `VITE_SYNC_ENABLED=true` in the deployed build.
- [ ] `npm run verify` + CDK assertions green; the live smoke passes (0 → non-zero in RDS through the real frontend).

## Implementation notes

- New `src/server/provisionWorkspace/{handler.ts (pure core, injected db + cognito),albAdapter.ts (Cognito PostConfirmation event → pg + AdminUpdateUserAttributes)}`; reuse `writeApi/albAdapter.ts`'s pg/CA/secret wiring and the RDS CA bundle copy hook.
- Auth stack custom attribute + trigger + IAM; this is the one place that needs `AdminUpdateUserAttributes`.
- Deploys via CI (`cdk deploy`) like every other stack — no ad-hoc Lambdas.
- The `custom:workspace_id` claim is read from the token the client already decodes (`src/auth/jwt.ts`/`wireIdentity`); thread it to `setWorkspaceId` in the sign-in path (`src/store/auth.ts`).
