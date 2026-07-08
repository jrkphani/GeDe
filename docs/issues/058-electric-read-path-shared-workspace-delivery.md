# 058: Deploy the ElectricSQL read-path so seated members receive the shared workspace's rows

- **Status**: OPEN
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 057 (an invited user must be a real, authorized member of the shared workspace before there is anything meaningful to stream to them), 032 (the read-path client code — `src/sync/{electricProtocol,syncEngine,config}.ts` — already exists and is merely gated off; this issue does not rebuild it)

## Slice

Part 3 of the 055 sharing fix (056 → 057 → **058**, plus optional 059). This is the **outermost blocker** 055 names on the recipient side: even with the invitation delivered (056) and the invitee properly seated in the inviter's workspace (057), the invitee's browser has no mechanism to *receive* the shared project's rows, because **no ElectricSQL service is deployed at all**.

## Problem / Goal

From 055's root-cause note and `docs/DEPLOYMENT.md §9a`'s "What is still open":

> Separately, the ElectricSQL **read-path is not deployed at all** today — the `sync` Fargate service is an `nginx:alpine` stub, `VITE_SYNC_URL` is empty, the client read-path is gated off — so no server→client streaming of any row happens yet. This is the outermost blocker on the recipient side.

And from `docs/HANDOFF.md`'s "Clear next steps" #2:

> **Deploy the ElectricSQL read-path** (server→client streaming). Today cloud sync is **write-only**... Multi-device / real-time collab needs a real Electric service behind the ALB + `VITE_SYNC_URL` set in the build; then un-gate the read-path.

Concretely, three things are true today and must each change:

1. **`sync` Fargate service is a stub.** (`docs/DEPLOYMENT.md §2`/`§9` — the compute-tier service that should run ElectricSQL is provisioned as `nginx:alpine`, not the real Electric sync engine image.)
2. **`VITE_SYNC_URL` is empty in the deployed build**, so `src/sync/config.ts`'s `syncBaseUrl()` returns `''`.
3. **The client read-path is explicitly gated off** — `src/store/sync.ts:165-175` (`start()`): `if (syncBaseUrl() === '' && !options.streamFactory) return` — a deliberate fix from bug **051** (enabling sync crashed the app because the read-path threw on an empty `VITE_SYNC_URL`). This gate must be safely removable once `VITE_SYNC_URL` is real, without reintroducing 051's crash for any environment where sync is enabled but the URL is still unset (defense-in-depth: the gate should probably stay as a guard, just naturally pass once the URL is populated, rather than being deleted outright).

**Goal**: a seated member's client establishes a real ElectricSQL shape subscription against a live Electric service, scoped to their (possibly shared, per-057) workspace, and inbound row-deltas apply via the already-built `src/db/sync.ts` (`applyInboundDeltas`, extended by 056 to cover `invitations`/`workspace_members` too) so the shared project's rows — and the accepted membership row itself — actually render in the invitee's UI.

## Design brief

This is part of the 055 sharing fix (056 → 057 → 058, plus optional 059 as an immediate mitigation) — 058 is the deployment/infra issue that finally makes "the invitee sees the project" observably true, closing the pipeline diagram in 055 end to end.

- **Reuse, don't rebuild, 032's client code.** `src/sync/{electricProtocol,syncEngine,config}.ts` is described in `docs/HANDOFF.md` as "code present, NOT deployed" — this issue is primarily **infrastructure** (a real Electric container image + ALB routing + `VITE_SYNC_URL` wiring in CI), not new client logic. Treat any client-side change here as a last-mile un-gating, not a rewrite.
- **Workspace-scoped shapes, not global ones.** ElectricSQL shapes subscribe to a filtered slice of a table (e.g. `WHERE workspace_id = $1`) — the shape definition/subscription must be parameterized per the caller's authorized workspace set (per-057, potentially plural once a user can belong to more than one workspace), never an unscoped `SELECT *` that would leak cross-tenant rows over the read-path the way 057 closes the gap on the write-path. This is the read-path's analogue of 057's tenancy check — don't let the read side quietly reopen what 057 just closed on the write side.
- **CDK / deploy-pipeline changes are the bulk of the work**: the `sync` Fargate task definition needs a real Electric image, task-level config (Postgres connection string, likely via the existing Secrets Manager wiring the write Lambda and migration runner already use — reuse, don't duplicate, per `docs/HANDOFF.md`'s "Shared infra note"), and the ALB/CloudFront routing for the shape-subscription HTTP(S) endpoint (mirroring how `047` fronted `/write*` through CloudFront rather than standing up a new domain/cert).
- **CI wiring**: `VITE_SYNC_URL` must be injected the same way `044` injected the Cognito ids — via GitHub repo variables into the build (`.github/workflows/deploy.yml`), not a live `describe-stacks` call (the least-privilege OIDC deploy role can't do that — same constraint `044` already documented).

## Files / layers touched

- `deploy/cdk/lib/*` — the `sync` Fargate service/task definition (currently `nginx:alpine`), ALB routing/target group, CloudFront behavior for the shape endpoint (parallel to `047`'s `/write*` behavior).
- `.github/workflows/deploy.yml` — inject `VITE_COGNITO_*`-style build-time `VITE_SYNC_URL`.
- `src/sync/config.ts` (`syncBaseUrl()`) — confirm it correctly resolves the newly-populated URL; likely no change needed if 032 built it correctly, but verify.
- `src/store/sync.ts:165-175` — the 051 gate; confirm behavior once `VITE_SYNC_URL` is real (should simply start working, no code change expected, but the gate's `!options.streamFactory` escape hatch should be re-read to make sure it doesn't accidentally suppress the real path too).
- `src/sync/electricProtocol.ts`/`syncEngine.ts` — confirm shape-subscription scoping is workspace-parameterized (per Design brief bullet 2); extend if the existing 032 implementation assumed a single always-own-workspace shape.

## Test-first plan

1. **Config/gate test**: `src/sync/config.test.ts` (or nearest existing test file) — `syncBaseUrl()` returns the injected `VITE_SYNC_URL` value once set; `src/store/sync.test.ts` — `start()` no longer short-circuits when `syncBaseUrl()` is non-empty (currently this path is exercised only via the `streamFactory` test seam per bug 051's fix — add/confirm a test for the "real URL, no injected factory" branch too).
2. **Shape-scoping unit test**: a test (likely in `src/sync/electricProtocol.test.ts` or `syncEngine.test.ts`) asserting the shape subscription URL/params are scoped to the caller's authorized workspace id(s) — not an unscoped table read. This is the read-path's tenancy-equivalent test to 057's `checkTenancy` tests; treat a passing-but-unscoped shape as a **failing** test even if data happens to come back correctly in a single-workspace dev setup.
3. **Infra smoke test** (not a unit test — a deploy-time verification, mirroring 050's live-test discipline): after CDK deploy, confirm the `sync` ECS service is running the real Electric image (`aws ecs describe-services` / CloudWatch), and a shape request against the CloudFront-fronted endpoint returns real row data for an authenticated, workspace-scoped query, not a stub 200/404.
4. **E2E (the deferred item from 055's own test-first plan)**: two-identity Playwright/integration test — user A invites user B (056), user B accepts (057), user B's client subscribes to the shared workspace's shape and the shared project renders in B's UI within a reasonable window. This is the test 055 explicitly named as "blocked on Cause 3 + read-path deploy" — this issue is what un-blocks it.

## Acceptance criteria

- [ ] `sync` Fargate service runs a real ElectricSQL image, not `nginx:alpine`.
- [ ] `VITE_SYNC_URL` is populated in the deployed build via CI (mirroring 044's Cognito-id injection pattern).
- [ ] The client read-path (`src/store/sync.ts`'s `start()`) successfully establishes a shape subscription in the deployed environment — bug 051's crash-on-empty-URL does not regress.
- [ ] Shape subscriptions are workspace-scoped (per Design brief) — verified by test-first plan item 2.
- [ ] The end-to-end E2E test (item 4) passes: two real identities, invite → accept → the invitee's UI renders the shared project.
- [ ] `npm run verify` green (including the new e2e coverage, mirroring the repo's `verify` = typecheck → eslint → stylelint → vitest, CI-only Playwright).

## Dependencies / ordering

Blocked by 057 (nothing meaningful to scope shapes to until membership is real) and 032 (client read-path code, already built, just gated/undeployed). This is intentionally the LAST issue in the 055 series — it is the most expensive (real infrastructure spend: an always-on Fargate task running Electric, versus the write path's serverless Lambda) and the least likely to be worth doing before 056/057 are proven correct in isolation.

## Risks

- **Cost**: unlike the write-path Lambda (pay-per-invocation), a real Electric Fargate service is an always-on task — `docs/DEPLOYMENT.md`'s "reality check" already notes v2's backend costs ~$30-60/mo without this; budget for the incremental always-on compute + likely NAT/data-transfer cost before committing to deploy. Flag this cost delta explicitly to the human before merging the CDK change (this is exactly the kind of infra decision CLAUDE.md's "senior dev override" says to surface, not silently absorb).
- **Cross-tenant leak on the read side mirrors 057's write-side risk**: an unscoped or mis-scoped shape subscription could stream another workspace's rows to a client that only proved membership in one workspace. This needs the same reviewer scrutiny as 057's tenancy relaxation — don't treat it as "just infra" when the actual query scoping is a security boundary.
- **051 regression risk**: the crash-on-empty-`VITE_SYNC_URL` gate exists for a reason (an empty-string `new URL()` throw). Confirm the fix path (real URL now present) doesn't silently mask a *different* empty-URL scenario (e.g. a preview/staging environment that intentionally has no sync URL yet) — the gate should stay defensive, not be deleted.
- **This issue has no code-only fallback.** Unlike 056/057, there is no way to "just write good tests and ship" — a real deploy against AWS is required to close it out, meaning it depends on CI/CD access and real cost, not just review bandwidth.

**References**: 055 (this bug, the ElectricSQL read-path note and the deferred E2E test-first-plan item), 032 (`done/032-sync-integration-row-delta.md` — the client read-path code this issue deploys, not rebuilds), 051 (`done/051-sync-read-path-crash-on-empty-url.md` — the exact gate this issue must not regress), 044 (`done/044-frontend-cognito-config-live-signin.md` — the CI build-variable injection pattern this issue's `VITE_SYNC_URL` wiring should mirror), 047 (`done/047-api-tls-https-endpoint.md` — the CloudFront-behavior-not-new-domain pattern for fronting the shape endpoint), `docs/HANDOFF.md` "Clear next steps" #2, `docs/DEPLOYMENT.md §9a` "What is still open" (read-path bullet) and §2/§9 (the `sync` Fargate stub).
