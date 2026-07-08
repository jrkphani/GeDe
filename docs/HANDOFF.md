# HANDOFF — 2026-07-09 (v2 cloud write-loop CLOSED + verified live)

For the next agent/session. Read this, then `docs/issues/README.md`, then the relevant issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public; `main`). Live at **https://d1nzod71m3rz6x.cloudfront.net** (AWS acct `975049998516`, `us-east-1`; OIDC CI deploys `main` after `verify` is green).

**The v2 cloud write loop is now CLOSED and PROVEN end-to-end.** As of the last handoff it was "infra live but no data flows"; that gap is now shut. **Verified live (2026-07-08):** a fresh Cognito sign-up auto-provisioned a personal workspace in RDS → SRP sign-in → a project created *in the browser* flushed to the `/write` API (`200 applied`) → **the row landed in the RDS Postgres** (`projects`/`applied_mutations` 0→1), confirmed by querying the DB through the new inspection API. A frontend action provably persists to the cloud database.

What shipped to get there (all live; issues in `docs/issues/done/` or filed):

- **M11 (044–048) — close the write loop.**
  - **044** frontend Cognito config: the deployed build now carries `VITE_COGNITO_*` (sourced from **GitHub repo variables** `vars.VITE_COGNITO_*` — the least-priv OIDC deploy role can't `describe-stacks`), so `/login` actually signs in.
  - **045** a one-shot **in-VPC migration-runner Lambda** (new `Gede-Test-Migrations` stack) applied migrations `0000–0011` to the RDS (the DB was empty before).
  - **046** deployed the **real write-path Lambda** (`src/server/writeApi`) replacing the 503 inline stub; `COGNITO_ISSUER` is a cross-stack ref to the real pool.
  - **047** HTTPS for the API: `/write*` (and later `/debug/db/*`) are fronted by the **existing CloudFront distribution** (same-origin HTTPS, no-cache) — no ACM cert / domain needed.
  - **048** the client optimistic-write queue **flushes to `/write`** with the Cognito JWT.
- **049 — read-only DB inspection API** (`/debug/db/*`: counts / rows / guarded SELECT). Secret-gated (`x-debug-token`, secret in Secrets Manager `DebugTokenSecretArn`), **test-env-only** (CDK `debugApi` flag, off by default; CI deploys with `-c debugApi=true`), read-only in depth (SELECT-only guard + `SET TRANSACTION READ ONLY` + row cap). This is the observability tool that proves whether writes land.
- **050 — auto-provision a personal workspace on sign-in.** A Cognito **Post-Confirmation trigger Lambda** (Auth stack) writes the user's `workspaces`+`workspace_members` rows to RDS. The workspace id is **deterministic from the Cognito `sub`** (`workspaceIdForSub`, a shared pure fn in `src/domain/`) so the client and server agree with **no Cognito custom attribute** (which would force a User Pool replacement — verified via `cdk diff`: pool is *Modify*, not *Replace*). Also injects `VITE_SYNC_ENABLED=true`.
- **Bugs 051–054** — found *during* the live e2e test and fixed (all SHIPPED, now regression-tested):
  - **051** enabling sync crashed the app — `VITE_SYNC_ENABLED` also started the (undeployed) Electric read-path, which threw `Failed to construct 'URL'` on an empty `VITE_SYNC_URL`. Fixed: read-path only starts when a sync URL (or test factory) is present; the write flush is independent.
  - **052** `/write` → `401 missing_claims` — `jwt.ts` required a `custom:workspace_id` claim (043's design); now **derives `workspaceId` from `sub`** (matches 050).
  - **053 / 054** two latent `PgWriteStore` SQL bugs — duplicate `id` column (42701) and camelCase-vs-snake_case columns (42703). The `PgWriteStore` had **never run against a real Postgres** (its contract test used a fake `pg` client that doesn't parse SQL). Fixed + now covered by `pgWriteStore.contract.test.ts` (SQL-string assertions) and a guarded `pgWriteStore.live.test.ts` (real `postgres:17`, skips without Docker).

All 7 CloudFormation stacks (`Network`/`Data`/`Api`/`Hosting`/`Auth`/`Dns`/`Migrations`) are `*_COMPLETE`. RDS schema applied. The v2 cost gate (RDS + NAT, ~$30–60/mo) is active.

## You have an AWS MCP server — use it

This session has an **AWS MCP server** (`mcp__aws-api__call_aws`) authenticated to the **GeDe account** (`975049998516`, `us-east-1`). Use it to inspect the live system directly — it was essential this session:

- **CloudWatch logs are the fastest debugger.** The `/write` 502s were diagnosed by reading the write-Lambda log group (`/aws/lambda/Gede-Test-Api-WriteApiFunction…`) — each Postgres error (42701, 42703) named the exact bug. `aws logs filter-log-events --log-group-name <grp> --start-time <ms> --filter-pattern ERROR`.
- **Inspect anything**: `cloudformation describe-stacks`, `lambda get-function-configuration`/`get-function` (download code), `rds describe-db-instances`, `elbv2 describe-listeners`, `cognito-idp describe-user-pool-client`, etc.
- **Inspect the RDS** (isolated subnet, no bastion): the **049 debug API** over HTTPS — fetch the token into a var and pipe it in (don't print it): `TOKEN=$(aws secretsmanager get-secret-value --secret-id <DebugTokenSecretArn> --query SecretString --output text); curl -H "x-debug-token: $TOKEN" https://…cloudfront.net/debug/db/counts`.
- **Two gotchas**: (1) the **Bash `aws` default profile is a DIFFERENT account** (`675379425271`) — use `AWS_PROFILE=phani-quadnomics` for the GeDe account in the shell (the MCP tool already targets the right account). (2) The **auto-mode safety classifier blocks mutating AWS** — IAM edits, stack deletes, `create-function`, DB writes, Cognito user creation (sometimes), and printing secret values. **Deploy via CI (push to `main`), never hand-deploy or ad-hoc `create-function`.** If a mutation is genuinely needed, hand the user a `!` command.

## Clear next steps (highest-leverage first)

1. **Extend the write loop past project-create.** Only `createProject`/`adoptProject` enqueue to the sync queue today; verify the *other* mutations (dimensions, parameters, contexts, tier1/tier2, bindings) enqueue + flush + land in RDS, and test each (use the 049 debug API's `rows` op). The write path (043) already allow-lists these tables.
2. **Deploy the ElectricSQL read-path** (server→client streaming). Today cloud sync is **write-only**: the `sync` Fargate service is still an `nginx:alpine` stub, `VITE_SYNC_URL` is empty, and the client read-path is gated off (051). Multi-device / real-time collab needs a real Electric service behind the ALB + `VITE_SYNC_URL` set in the build; then un-gate the read-path.
3. **Shared / multi-workspace writes (035).** The model is currently **personal-workspace-only** — `workspaceIdForSub(sub)` derives one workspace per user, and `jwt.ts` derives the write scope from `sub`. Sharing needs the workspace to come from the **mutation envelope + a membership check** (RLS), not the sub — revisit `jwt.ts`/`handler.ts` tenancy when 035 goes live.
4. **Hardening**: a dedicated `app_readonly` Postgres role for the 049 debug API (today it relies on `SET TRANSACTION READ ONLY` + statement_timeout + the SELECT-only guard); make **absolutely sure prod never sets `debugApi=true`**; add a jest `globalTeardown` that removes `$TMPDIR/cdk.out*` (CDK synth/jest scatter temp dirs that accumulate to ~100 GB and exhaust disk — see gotchas).
5. **Earlier follow-ups still open**: Google Workspace federation (033 fast-follow, Cognito IdP); cross-network presence (038 — real WebSocket/Electric transport).

## How to work (non-negotiables)

1. **TDD, red first.** Each issue has a *Test-first plan* — write those tests, watch them fail, then implement.
2. **`npm run verify`** green before SHIPPED. Husky **pre-push runs `verify:fast`** (typecheck → eslint → stylelint → vitest, no e2e); CI runs full `verify` (adds Playwright) then `cdk deploy --all -c debugApi=true`.
3. **Deploy = push to `main`.** CI (`verify.yml` → `deploy.yml`) is the only deploy path; humans/agents never hand-`cdk deploy` (TECH_STACK §6.4) — and the classifier blocks it anyway. Watch a deploy by polling `gh run list`/CloudFormation.
4. **Schema only via `npm run db:generate`** — migrations `0000`–`0011`; pre-assign the next slot before parallel work. `src/db/migrate.ts` runs them in the browser (PGlite); the **045 migration-runner Lambda** applies the same `.sql` files to RDS on deploy.
5. **Layer boundaries are lint-enforced** (components can't import `src/db/**`; server logic in `src/server/**`, shared pure logic in `src/domain/**`; no raw `<button>/<input>/<select>` or cmdk/radix outside `src/components/ui/`; no hardcoded CSS colors).
6. **Ship ritual**: Status → SHIPPED, `git mv` to `docs/issues/done/`, README index row ✅, one commit per issue.
7. **Parallel work via worktree-isolated subagents** on **disjoint file sets** (docs vs CDK vs client); integrate by cherry-pick/merge, then **one combined `verify`** (combined-verify > per-agent verify).

## Architecture facts

- **DB**: PGlite in-browser (`idb://gede`, `memory://` in tests), singleton `getDatabase()`; server **RDS Postgres 17** (isolated subnet). Same Drizzle migration history both places.
- **Stores** (Zustand): projects/dimensions/parameters/contexts/status + v2's `sync`/`auth`/`workspace`.
- **v2 auth** (033): `src/auth/*` (Cognito SRP client, jwt decode, `wireIdentity.getAuthHeaders()` → ID token); `src/store/auth.ts` sign-in/hydrate now calls `setWorkspaceId(workspaceIdForSub(sub))` (050).
- **v2 write-path** (043/046, LIVE): `src/server/writeApi/{albAdapter,handler,store,jwt,rejection}.ts` — Lambda behind the ALB (via CloudFront `/write*`), validates the Cognito JWT (derives workspace from `sub`), enforces tenancy + domain invariants + LWW + idempotency (`applied_mutations` ledger, migration `0010`), writes RDS as the owner role over TLS (pinned RDS CA). `store.ts` converts camelCase payload keys → snake_case columns and excludes server-stamped columns.
- **v2 client flush** (048): `src/sync/writeTransport.ts` + `src/store/sync.ts` `flush()` — drains the mutation queue to `/write` with the JWT, retry/backoff, reconnect-flush; gated on `isSyncEnabled()` + signed-in + `workspaceId` set. `createProject` (050) scopes new projects to the workspace + enqueues.
- **v2 provisioning** (050): `src/server/provisionWorkspace/*` (Cognito Post-Confirmation adapter + pure handler); `src/domain/workspaceId.ts` (`workspaceIdForSub` = UUIDv5 of the sub over a fixed namespace) + `src/domain/uuidv5.ts`.
- **v2 read-path** (032, code present, NOT deployed): `src/sync/{electricProtocol,syncEngine,config}.ts`; `syncBaseUrl()` (`VITE_SYNC_URL`) empty → read-path engine stays off (051). `SQL_TO_JS_COLUMNS` maps snake↔camel.
- **v2 debug API** (049): `src/server/debugApi/{sqlGuard,operations,handler,albAdapter}.ts` — read-only, secret-gated, test-env-only, via CloudFront `/debug/db/*`.
- **v2 tenancy** (034): `src/db/{workspaces,tenantContext}.ts`; RLS in migration `0008` (server Postgres; inert on PGlite/owner). `createProject` seeds a local mirror workspace row (`ensureWorkspaceRow`) to satisfy the local FK.

## Gotchas already paid for (don't rediscover)

- **`PgWriteStore` was never run against a live DB** until M11 — its contract test uses a **fake `pg` client that doesn't parse SQL**, so 2 SQL bugs shipped (dup `id`, camelCase columns). Now guarded by SQL-string assertions + `pgWriteStore.live.test.ts` (real `postgres:17`). Any raw-SQL store change needs the live/SQL test, not just the fake client.
- **`VITE_SYNC_ENABLED` turns on BOTH** the write flush *and* the Electric read-path; the read-path throws on an empty `VITE_SYNC_URL`. Keep them decoupled.
- **Cognito custom attributes force a User Pool replacement** in CloudFormation (wipes users, changes the pool id) — use a **deterministic id from `sub`** or a Pre-Token-Generation trigger, never a `Schema` change. Always `cdk diff` the Auth stack: it must be *Modify*, not *Replace*.
- **RDS TLS**: node-`pg` rejects RDS's AWS-managed CA as "self-signed" unless you pin it — bundle `rds-global-bundle.pem` into the Lambda (`ssl: { ca, rejectUnauthorized: true }`), copied via the `NodejsFunction` `afterBundling` hook.
- **The least-priv OIDC deploy role can't call `cloudformation:DescribeStacks`** — the frontend's Cognito ids come from **GitHub repo variables**, not `describe-stacks` in the workflow.
- **The isolated RDS has no bastion** — inspect it via the 049 debug API (read-only) or a throwaway in-VPC Lambda (reuse the migration-runner's role/SG); the auto-mode classifier blocks the latter, so hand the user a `!` script.
- **CDK synth/jest scatter `cdk.out*` temp dirs in `$TMPDIR`** that accumulate (thousands, ~100 GB) and exhaust disk → `ENOSPC` freezes the shell (commands can't even write output). Periodically `rm -rf /private/var/folders/*/*/T/cdk.out*` (and `deploy/cdk/cdk.out`); a jest globalTeardown would prevent it.
- **Bash `aws` default profile ≠ GeDe account** — use `AWS_PROFILE=phani-quadnomics` (acct `975049998516`); the default is a different account.
- **A deploy that fails mid-way** leaves a stack in `ROLLBACK_COMPLETE` (must be deleted before recreate — CDK auto-deletes it on the next deploy). VPC-Lambda deletes are slow (~20 min ENI teardown), so a *failed* deploy runs long; a *successful* one is quick.
- (v1 gotchas from earlier handoffs — capture-phase shortcuts, `flexRender` component identity, d3 arc centering, jsdom polyfills, `load()` id-first + generation counter, stable module-level selector fallbacks — all still apply; see git history / prior issues.)

## Docs map

`docs/SPEC.md` (domain + invariants) · `docs/TECH_STACK.md` (stack/deploy/decisions) · `docs/STYLE_GUIDE.md` · `docs/SITEMAP.md` · `docs/adr/` (0008 v2 backend, 0009 Cognito, 0010 tiers) · `docs/DEPLOYMENT.md` (§9 v2 topology + deployed reality) · `docs/issues/` (README = index + working agreement; `done/` = shipped).

A local knowledge graph lives in `graphify-out/` (gitignored): `graph.html` to browse, `/graphify query "…"` to ask, `/graphify --update` after large changes.
