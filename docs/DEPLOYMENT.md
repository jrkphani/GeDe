# GeDe — Deployment Guide

> How GeDe is deployed to AWS. v1 (now) is a static, local-first PWA on S3 + CloudFront, provisioned with **AWS CDK**. This guide covers the architecture, prerequisites, step-by-step deploy, DNS, CI/CD, cost, and the **v2 architecture (private VPC + NAT gateway)**.
>
> Companion docs: `TECH_STACK.md` §6 (decision record), issue `040` (CDK app spec), issue `029` (OIDC CI pipeline). Deployment code lives in `deploy/cdk/` and `.github/workflows/` — those are the deployment contract; never click-ops or `aws s3 sync` by hand (`TECH_STACK §6.4`).

---

## 1. At a glance

| | test (now) |
| --- | --- |
| AWS account | `975049998516` (`test@quadnomics.in`) |
| Region | `us-east-1` (required for CloudFront/ACM certs) |
| CLI profile | `phani-quadnomics` |
| IaC | AWS CDK (TypeScript), `deploy/cdk/` |
| App URL | **https://d1nzod71m3rz6x.cloudfront.net** (live; CloudFront default domain — no custom domain yet, the Dns stack is a seam, §7) |
| Database | **None in AWS** — PGlite (WASM Postgres) runs in the browser, persisted to IndexedDB/OPFS |
| Cost | ~$0–1 / month |

**Key idea:** v1 has no server and no server-side database. The whole app — including its Postgres — ships in the browser bundle. AWS only serves static files. That is why v1 costs almost nothing and needs no VPC data path.

> **Note (2026-07-09):** this "v1 at a glance" row set still describes what the **live app actually runs on** (static PWA + in-browser PGlite) for a **signed-out / offline** visitor — that path is unchanged and still costs ~$0–1/mo. But the v2 backend (RDS + NAT + Fargate + Cognito + a write Lambda) is **also deployed alongside it, and the cloud write loop is now CLOSED and verified live** (milestone M11, issues 044–050): a signed-in user's edits actually flush to `/write` and land in RDS. So the real running cost is **~$30–60/mo**, and data *does* flow through the backend once a user signs in. The read-path (server → client streaming via ElectricSQL) is still **not** deployed — see **§9 / §9a** for the current topology and the accurate open/closed list.

---

## 2. Architecture — v1 (test)

```text
Developer  /  GitHub `main`
      │   npm run build  →  dist/  (hashed assets + service worker)
      ▼
AWS CDK  (deploy/cdk/, TypeScript)  ──  cdk deploy  (--profile phani-quadnomics)
      │
  ┌───┴──────────────────────────────────────────────────────────────┐
  │  Gede-Test-Network   VPC · 2 AZ · public + isolated subnets       │
  │                      NO NAT gateway  (unused by static v1 —       │
  │                      a forward-looking foundation for v2 compute) │
  │                                                                   │
  │  Gede-Test-Hosting   S3 bucket (PRIVATE, Origin Access Control)   │
  │                          │                                        │
  │                          ▼                                        │
  │                      CloudFront  (default *.cloudfront.net domain,│
  │                      default TLS cert · HTTP/3 · Brotli ·         │
  │                      hashed assets immutable 1y · index.html &    │
  │                      sw.js no-cache · SPA 403/404 → index.html)   │
  │                                                                   │
  │  Gede-Test-Dns       Route 53 SEAM — inert without a domain;      │
  │                      outputs the CloudFront URL (see §7)          │
  └───────────────────────────────────────────────────────────────────┘
      │
      ▼
Browser (installable PWA, works offline)
  • PWA shell + service worker  (registerType: 'prompt' — quiet "New version — Reload")
  • PGlite — PostgreSQL 17 compiled to WASM (~3 MB gz), runs in the page
  • Drizzle migrations apply at the edge on boot, before the store hydrates
      │
      ▼
  IndexedDB / OPFS  (idb://gede)  — all data stays on the device
```

**Stacks** (CDK, layered — deploy in this order):

| Stack | Provisions | Notes |
| --- | --- | --- |
| `Gede-Test-Network` | VPC, 2 AZ, public + private-isolated subnets, **no NAT** | Not on the static app's path; the network baseline for v2 (§9). The no-NAT choice keeps idle cost ~$0. |
| `Gede-Test-Hosting` | Private S3 origin (OAC) + CloudFront distribution | Serves the built PWA over HTTPS at the CloudFront default domain. `BucketDeployment` (or the CI `cdk deploy`) publishes `dist/`. |
| `Gede-Test-Dns` | Route 53 seam | No hosted zone until a real domain exists; surfaces the CloudFront URL as the app address (§7). |

**Data locality:** no user data leaves the browser in v1. The portability/backup story is the in-app **Export / Import JSON** (issue 015), not a server.

---

## 3. Prerequisites

- **Node** 22 + npm (the app build) and the CDK CLI (`npm i -g aws-cdk`, or use `npx cdk`).
- **AWS CLI v2** with the `phani-quadnomics` profile configured (Account `975049998516`, region `us-east-1`). Verify:
  ```bash
  aws sts get-caller-identity --profile phani-quadnomics
  # → arn:aws:iam::975049998516:user/Phani-quadnomics
  ```
- IAM permissions for the deploying principal to create the stacks' resources (S3, CloudFront, Route 53, EC2/VPC, CloudFormation, IAM for OAC/roles).

---

## 4. One-time setup

```bash
# 1. Install the CDK app's own dependencies (kept separate from the web app)
cd deploy/cdk && npm ci

# 2. Bootstrap the account/region for CDK (creates the CDK toolkit stack)
npx cdk bootstrap aws://975049998516/us-east-1 --profile phani-quadnomics
```

`cdk bootstrap` is idempotent and only needs to run once per account/region. It
creates the `CDKToolkit` stack and the `cdk-hnb659fds-*` deploy / file-publishing /
lookup / cfn-exec roles that CI assumes below.

### 4a. GitHub OIDC deploy identity (one-time, done)

CI never holds long-lived AWS keys. Instead GitHub Actions federates into a
short-lived role via OIDC. This is provisioned **out of band** (not in the CDK
app) because it is the bootstrap credential the deploy itself uses — the deploy
role can't create the deploy role. Provisioned once with `--profile phani-quadnomics`:

```bash
# i. GitHub Actions OIDC identity provider (audience = sts.amazonaws.com)
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bba010e435a9e6c1e3a8b21b6d6f88

# ii. The CI deploy role — trusts ONLY jrkphani/GeDe's main branch, and can do
#     nothing but assume the CDK bootstrap roles (least privilege: it drives
#     cdk deploy, it does not touch the account directly).
#     trust-policy.json  → Federated principal = the OIDC provider above,
#                          condition sub = repo:jrkphani/GeDe:ref:refs/heads/main,
#                          aud = sts.amazonaws.com
#     assume-cdk.json    → Allow sts:AssumeRole on
#                          arn:aws:iam::975049998516:role/cdk-hnb659fds-*-975049998516-us-east-1
aws iam create-role --role-name github-actions-gede-deploy \
  --assume-role-policy-document file://trust-policy.json --max-session-duration 3600
aws iam put-role-policy --role-name github-actions-gede-deploy \
  --policy-name assume-cdk-bootstrap-roles --policy-document file://assume-cdk.json

# iii. Hand the role ARN to CI as a repo secret (no other secret is needed)
gh secret set AWS_DEPLOY_ROLE_ARN \
  --body arn:aws:iam::975049998516:role/github-actions-gede-deploy
```

**Provisioned:** role `github-actions-gede-deploy`
(`arn:aws:iam::975049998516:role/github-actions-gede-deploy`), OIDC provider
`token.actions.githubusercontent.com`, secret `AWS_DEPLOY_ROLE_ARN`. See §8.

---

## 5. Deploy (manual)

From `deploy/cdk/`, with the web app built:

```bash
# Build the PWA first — the Hosting stack publishes deploy/cdk/../../dist
cd <repo-root> && npm run build

cd deploy/cdk
export AWS_PROFILE=phani-quadnomics

npx cdk synth            # render CloudFormation; sanity-check the diff
npx cdk diff             # what will change

# Phase 1 → 2 → 3 (Hosting yields the live URL)
npx cdk deploy Gede-Test-Network
npx cdk deploy Gede-Test-Hosting     # outputs the CloudFront domain
npx cdk deploy Gede-Test-Dns

# or all at once once you trust it:
npx cdk deploy --all
```

The **CloudFront distribution domain** is printed as a stack output (e.g. `https://d1234abcd.cloudfront.net`) — that is the test URL.

**Smoke test:** open the CloudFront URL → the app boots (`[data-db-ready]` flips true, you can create a project), `index.html` is served `no-cache`, hashed assets `immutable`. A failing PGlite boot means the wasm/asset MIME or cache policy is wrong.

---

## 6. Tagging strategy

Every resource carries these tags, set **once** on the CDK `App` (`Tags.of(app).add(...)`) so all stacks/resources inherit them:

| Tag | Value |
| --- | --- |
| `Organization` | `quadnomics` |
| `Application` | `GeDe` |
| `Environment` | `test` |
| `ManagedBy` | `CDK` |

Activate these as **cost-allocation tags** in the Billing console so spend is attributable per org / app / environment. A future `prod` environment reuses the same app with `Environment=prod`.

---

## 7. DNS & custom domain

There is **no registered public domain yet**, so:

- The app is served over HTTPS at CloudFront's **default `*.cloudfront.net` domain**, using CloudFront's default viewer certificate. No ACM cert and no Route 53 hosted zone are created (a hosted zone without a delegated domain is inert; an ACM cert for a domain you don't own can't be validated).
- The `Gede-Test-Dns` stack is a **seam**: it outputs the CloudFront URL today, and is written so that supplying a `domainName` context later performs a **one-config-value cutover** — it will then create/use a public hosted zone, a **DNS-validated ACM certificate in `us-east-1`**, add the domain as a CloudFront alternate name, and create A/AAAA **alias** records pointing at the distribution.

**To go live on a real domain later:** register the domain (Route 53 or elsewhere → delegate NS to the hosted zone), set the `domainName` context, and redeploy `Gede-Test-Dns` + `Gede-Test-Hosting`. No rebuild of the app or the other stacks.

---

## 8. CI/CD (issue 029)

Manual `cdk deploy` is fine for bring-up; the steady state is **GitHub Actions only** (`TECH_STACK §6.4`, issue 029). The pipeline lives in `.github/workflows/deploy.yml`:

- **On push to `main`**, and **only after `verify.yml` completes successfully** for that commit, the `deploy` job runs (`workflow_run` trigger — "one gate, reused": deploy never re-runs the checks, it refuses to run unless `verify` already went green). It checks out the exact `head_sha` verify validated, runs `npm run build`, then `cd deploy/cdk && npx cdk deploy --all --require-approval never`.
- **On pull requests**, a separate `cdk-validate` job runs `cdk synth` + the CDK assertion/snapshot tests (and a best-effort `cdk diff` on same-repo PRs). **PRs never mutate AWS.**
- **AWS access is via GitHub OIDC federation** — no long-lived keys anywhere. CI assumes role **`github-actions-gede-deploy`** (`arn:aws:iam::975049998516:role/github-actions-gede-deploy`), whose ARN is the `AWS_DEPLOY_ROLE_ARN` repo secret. The role:
  - **trusts only** the subject `repo:jrkphani/GeDe:ref:refs/heads/main` (audience `sts.amazonaws.com`) — so only a workflow running on this repo's `main` can assume it. PR builds can't (their subject is `pull_request`), which is why the PR `cdk diff` step is best-effort and skips cleanly.
  - **can do exactly one thing:** `sts:AssumeRole` on `cdk-hnb659fds-*-975049998516-us-east-1`. It has no direct S3/CloudFront/CloudFormation permissions of its own — it drives `cdk deploy`, which assumes the CDK bootstrap roles that carry the real permissions. Least privilege, scoped to the `Gede-*` stacks, not account-admin.
- A red `verify` blocks the deploy (same gate as local).
- Service-worker updates are `registerType: 'prompt'` — a quiet status-line "New version — Reload", never an auto-reload (an in-place edit must not be lost). Deploys are atomic from a user's view: hashed immutable assets stay valid until the new `no-cache` shell references new hashes.

> **Hardening note:** `cdk bootstrap` used the default `AdministratorAccess` cfn-exec policy. Since CI can only *assume* the CDK roles (not use them arbitrarily) and CloudFormation is what wields that policy, the CI blast radius is bounded by the stacks it deploys. Tightening the cfn-exec role to a `Gede-*`-scoped policy (re-bootstrap with `--cloudformation-execution-policies`) is a future hardening step, tracked separately.

---

## 9. v2 architecture — **private VPC + NAT gateway** (decided: ADR-0008; issue 030 built, PR #3)

> **When GeDe gains a server (v2 — collaboration: sync, auth, workspaces), it moves into a private VPC with a NAT gateway.** v1's static frontend is unchanged; v2 adds a backend tier behind it. This supersedes the earlier Lightsail sketch in `TECH_STACK §6.3` for a CDK-managed, AWS-native account.
>
> **Status (2026-07-09):** the v2 backend is **deployed and live** ([ADR-0008](adr/0008-v2-backend-cdk-rds-electricsql.md)) — CDK VPC + NAT + RDS 17.9 (private) + Fargate, RLS authored in Postgres. **Auth is [Amazon Cognito](adr/0009-auth-cognito-over-better-auth.md)** (ADR-0009, superseding ADR-0008's better-auth): a managed User Pool **outside the VPC**, email/password first then Google Workspace federation (issue 033, still open). This **removes the `auth` Fargate service** — only the `sync` (Electric) task remains in the compute tier. **The cloud write loop is now closed and verified live** (milestone M11, issues 044–050, §9a) — a signed-in user's edits persist to RDS through a real write-path Lambda. The **read-path is not**: the `sync` Fargate service is still an `nginx:alpine` stub (ElectricSQL itself is not yet deployed), so there is no server→client streaming yet.

### 9a. Deployment reality — the cloud write loop is CLOSED and verified live (2026-07-08/09)

> Milestone M11 (issues 044–050) took the v2 backend from "documented seams, never joined" to a **proven end-to-end write path**: browser → Cognito auth → `/write` Lambda → RDS. This was verified directly against AWS account `975049998516` / `us-east-1`, not inferred from code — see the live test at the end of this section.

**What closed the loop (issue → what it fixed):**

| # | Fix | Detail |
| --- | --- | --- |
| **044** | Frontend has real Cognito ids | The build now injects `VITE_COGNITO_USER_POOL_ID` / `_CLIENT_ID` / `_REGION` in CI. These come from **GitHub repo variables** (`vars.VITE_COGNITO_*` in `.github/workflows/deploy.yml`), **not** a live `cloudformation describe-stacks` call — the least-privilege OIDC deploy role (§8) can only `sts:AssumeRole` into the CDK bootstrap roles, it can't read stack outputs directly. `/login` now mints real JWTs against User Pool `us-east-1_d0qKGDQmC`. |
| **045** | RDS has a schema | A new **`Gede-Test-Migrations`** stack: a one-shot, VPC-attached migration-runner Lambda (private subnets, DB-facing SG, Secrets Manager creds) applies the Drizzle SQL files `0000`–`0011` to the deployed RDS in filename order, idempotently. 034's RLS policies are now live policy, not inert files. |
| **046** | `/write` runs the real handler | `api-stack.ts` now deploys the real bundled `src/server/writeApi/*` Lambda (replacing the `Code.fromInline` 503 stub). `COGNITO_ISSUER` is wired as a **cross-stack reference** to the `Gede-Test-Auth` User Pool — no more `PLACEHOLDER_USER_POOL_ID`. |
| **047** | HTTPS reachable, no mixed content | The write API is fronted through the **existing CloudFront distribution** as a second origin/behavior for `/write*` (HTTP to the ALB, HTTPS to the browser, caching disabled — a mutating POST must never be cached). Same-origin, no new ACM cert, no custom domain needed. |
| **048** | Client actually flushes writes | The 032 client mutation queue now has a transport: it `fetch()`s batches to `/write` with the Cognito JWT, with retry/backoff and rejection→rollback reconciliation. |

**Observability added alongside the loop:**

- **049** — a **read-only DB inspection API** at `/debug/db/*` (table counts, recent rows, a guarded SELECT-only query), routed through the same CloudFront path pattern as 047. Test-env only: gated behind a CDK `debugApi` context flag (off by default; CI deploys with `-c debugApi=true`), Lambda lives in the Api stack, and every request requires a shared secret (`x-debug-token`, stored in Secrets Manager — never in the repo, missing/wrong → `401`). Read-only is enforced in depth: an app-layer SELECT-only parser, `SET TRANSACTION READ ONLY` + a `statement_timeout` on the connection, with a dedicated `app_readonly` Postgres role still a deferred hardening step (today the guard is app-layer + transaction-mode only). **Prod must never enable `debugApi`.**
- **050** — **auto-provisioning a personal workspace on sign-in**, the last missing piece (without it, every write was rejected — no workspace existed in RDS to write into). A Cognito **Post-Confirmation trigger Lambda** (attached to the existing User Pool in the Auth stack — an in-place `LambdaConfig` change, confirmed via `cdk diff` to be a pool **Modify, not Replace**) inserts `workspaces` + `workspace_members` rows idempotently on confirm. The workspace id is **not** a Cognito custom attribute (that path was considered and rejected — it would force a User Pool replacement) — it's **deterministic from the Cognito `sub`** via a shared pure function `workspaceIdForSub(sub)`, imported by both the server trigger and the client, so both sides agree on the id with no lookup and no schema change. Also flips `VITE_SYNC_ENABLED=true` in the deployed build.

**Shared infra note:** the write Lambda, the 045 migration runner, and the 050 provisioning trigger all pin **Amazon's RDS CA bundle** (`deploy/cdk/lib/rds-global-bundle.pem`, `ssl.rejectUnauthorized: true`) — required because node-`pg` otherwise rejects RDS's CA as self-signed.

**Proven end-to-end, live (2026-07-08):** a fresh Cognito sign-up → the Post-Confirmation trigger provisioned the workspace in RDS → SRP sign-in in the browser → created a project → the client's write-queue flushed to `/write` (200, `applied`) → the row landed in RDS (`projects` / `applied_mutations` 0 → 1), confirmed via the 049 debug API (`/debug/db/counts`).

**Bugs the live test found and fixed** (filed as issues 051–054, all SHIPPED same-day):

- **051** — enabling sync (`VITE_SYNC_ENABLED`) crashed the signed-in app: the flag gated both the write flush (wanted) and the Electric **read-path** engine, which threw on an empty `VITE_SYNC_URL`. Fixed by skipping read-path start when no sync URL is configured.
- **052** — `/write` returned `401 missing_claims` for a validly-signed JWT — the server originally expected a `custom:workspace_id` claim that was never issued; fixed by deriving the workspace id from `sub` (`workspaceIdForSub`) instead, matching 050's actual design.
- **053** — `502`, Postgres `42701` (`column "id" specified more than once`) — `PgWriteStore`'s INSERT duplicated the `id` column; fixed by excluding server-stamped columns.
- **054** — `502`, Postgres `42703` (`column "workspaceid" does not exist`) — `PgWriteStore` was passing camelCase payload keys straight through as SQL columns; fixed by converting to snake_case. A regression test (issue 043 follow-up) now covers this SQL-parsing gap directly.

**What is still open** (don't over-claim — the loop closes *writes*, not the full sync story):

- **Read-path (ElectricSQL) is not deployed.** The `sync` Fargate service is still an `nginx:alpine` stub; `VITE_SYNC_URL` is empty; the client's read-path engine is deliberately gated off (051). So cloud sync today is **write-only** — a signed-in user's own edits reach RDS, but there is no server→client streaming, i.e. no live multi-device/multi-user rendering yet. That needs a real Electric service + a populated `VITE_SYNC_URL`.
- **Personal-workspace-only.** The workspace id is deterministic from the signed-in user's own `sub` — there's no shared/multi-workspace write path yet (035's sharing model would need the workspace to come from the mutation envelope + a membership check, not the caller's `sub`).
- **Debug API hardening deferred.** A dedicated least-privilege `app_readonly` Postgres role for 049 is not yet built (today's guard is app-layer SELECT-only parsing + `SET TRANSACTION READ ONLY` + `statement_timeout`); `debugApi` must stay off in any real prod environment.
- **Google Workspace federation** (033 fast-follow) is still not wired.

**Operator/agent inspection tools for the live system:**

- **049's debug API** — `curl` `/debug/db/*` with the shared secret header (`x-debug-token`, value in Secrets Manager) for table counts / recent rows / a guarded SELECT, without a bastion.
- **CloudWatch Logs + an AWS MCP server** — this is how the 053/054 SQL bugs above were actually diagnosed: the write Lambda's logs surfaced the exact Postgres error codes (`42701`/`42703`) behind the `502`s.

The network wiring underneath all of this was correct from the start (issue 030): the DB security group admits `:5432` from the write Lambda's SG and the sync SG; the Lambda carries `DATABASE_ENDPOINT` + `DATABASE_SECRET_ARN`. M11 was wiring + config + one migration-runner + one provisioning trigger, not new network infrastructure.

**Why a private VPC + NAT for v2 (and not for v1):**

- v1 is 100% static (S3 + CloudFront) with the database in the browser — there is **no server to place in a network**, so its VPC is an unused foundation and carries **no NAT** (a NAT gateway is ~$32/mo per AZ for nothing).
- v2 introduces **compute** (the API / sync / auth services) and a **managed PostgreSQL**. Those run in **private subnets with no public IPs** for security (nothing internet-reachable except through the load balancer). Private instances still need **outbound** internet — pulling container images, OS/package updates, ACME/cert refresh, calling external APIs — and that egress path is exactly what a **NAT gateway** provides. Hence v2 *requires* the private VPC + NAT that v1 deliberately omits.

**v2 topology:**

```text
                     CloudFront  +  S3   (static PWA — UNCHANGED from v1)
                            │   api.<domain>   (Route 53 → ALB)
                            ▼
   ┌─────────────────────── VPC  (private, multi-AZ) ────────────────────────┐
   │  PUBLIC subnets      Application Load Balancer (TLS, api ingress)        │
   │                      NAT Gateway  ◄── the outbound path for private tiers│
   │                                                                         │
   │  PRIVATE subnets     Compute (ECS Fargate) — no public IP:             │
   │                        • sync engine  (ElectricSQL — ADR-0008)          │
   │                      (auth is Cognito — managed, OUTSIDE the VPC;        │
   │                       no auth task here — ADR-0009)                      │
   │                      egress to the internet via the NAT Gateway         │
   │                                                                         │
   │  ISOLATED subnets    PostgreSQL 17 (RDS) — same Drizzle migrations as   │
   │                        v1's PGlite; workspace Row-Level Security (034);  │
   │                        no internet route at all                         │
   └─────────────────────────────────────────────────────────────────────────┘

   Sync model: server Postgres ⇄ client PGlite, row-deltas, last-write-wins
   (issue 032). The client stays local-first; the server is the shared source.
```

> **Ingress reality check (2026-07-09):** the diagram's `api.<domain>` hostname is still the *future*, custom-domain path (§7 seam, unactivated). **Today**, the write and debug APIs are reached the way 047 shipped them — as **additional CloudFront behaviors** on the same `d1nzod71m3rz6x.cloudfront.net` distribution (`/write*` → the ALB → the write Lambda; `/debug/db/*` → the ALB → the 049 debug Lambda, test-env only). Same-origin HTTPS, no separate hostname, no CORS, caching disabled on both paths.

**v2 components & security:**

- **Ingress:** CloudFront/S3 frontend unchanged; an ALB sits in the public subnets. `api.<domain>` (Route 53 alias, §7) is the eventual custom-domain path, still a seam. **Live today:** CloudFront itself fronts the ALB via path-routed behaviors — `/write*` and `/debug/db/*` — so the browser's own HTTPS origin reaches both APIs directly (issue 047). Only the ALB and NAT gateway live in public subnets.
- **Compute (private subnets, no public IP):** the sync engine (**ElectricSQL** — ADR-0008, issue 032) on ECS Fargate. Egress via the **NAT gateway** only; ingress only from the ALB via security groups. Still shipped as an `nginx:alpine` stub behind path-routed `/sync*` — Electric itself is not yet deployed (§9a).
- **Write path (serverless — [ADR-0010](adr/0010-tier-responsibilities-local-first-inversion.md), issues 043/046):** Electric is read-path only, so client writes persist through a **Lambda** write-API behind the ALB that validates the Cognito JWT + workspace scope + **domain invariants**, then writes to Postgres. This is **live**: the real bundled handler (`src/server/writeApi/*`) replaced the 503 stub in 046, with `COGNITO_ISSUER` cross-stack-wired to the Auth stack. **`$0` idle** — no always-on task for writes; keeps Tier 2 to the single Electric Fargate task plus a serverless write path.
- **Schema/migrations (issue 045):** a dedicated **`Gede-<Env>-Migrations`** stack — a one-shot, VPC-attached Lambda that applies the Drizzle SQL history (`0000`–`0011`) to RDS idempotently on deploy. No bastion; the applier runs inside the VPC and goes to the data.
- **Observability (issue 049, test-env only):** a **read-only DB inspection Lambda**, deployed in the Api stack and routed through the same CloudFront `/debug/db/*` path as the write API. Gated behind a CDK `debugApi` context flag (off unless `-c debugApi=true`); every request requires a shared secret (`x-debug-token`, Secrets Manager); reads are guarded by a SELECT-only parser plus `SET TRANSACTION READ ONLY` + a `statement_timeout`. **Never enabled in prod.**
- **Auth (managed, outside the VPC):** **Amazon Cognito** User Pool ([ADR-0009](adr/0009-auth-cognito-over-better-auth.md), issue 033) — the SPA authenticates against it directly over the internet (OIDC+PKCE); the sync/API validates the Cognito JWT via JWKS. No Fargate auth task, no VPC path. Email/password first; Google Workspace federation is still a fast-follow, not yet wired. The build's Cognito ids are injected via **GitHub repo variables** (`vars.VITE_COGNITO_*`), not a live CloudFormation lookup (issue 044 — the least-priv OIDC deploy role can't call `describe-stacks`).
- **Workspace provisioning (issue 050):** a **Cognito Post-Confirmation trigger Lambda**, attached to the Auth stack's existing User Pool (`LambdaConfig` only — confirmed via `cdk diff` to be a pool *Modify*, never a *Replace*). On confirm it idempotently inserts the new user's `workspaces` + `workspace_members` rows into RDS. The workspace id is **deterministic from the Cognito `sub`** (`workspaceIdForSub`, a shared pure function used by both the trigger and the client) — no custom Cognito attribute, no schema change to the pool.
- **Database (isolated subnets):** managed **PostgreSQL 17** (RDS `db.t4g.micro`, single-AZ for `test`; T5 resolved to RDS, ADR-0008). It runs the **same Drizzle migration history** as v1's PGlite (the "one dialect, no migration cliff" bet, `TECH_STACK §2` — proven by `deploy/migration-parity/`, and now actually applied live by 045) and enforces **workspace RLS** (issue 034), which is live policy, not inert files, as of 045. No internet route — reachable only from the compute security group; credentials in Secrets Manager. Both the write Lambda and the migration runner pin **Amazon's RDS CA bundle** (`deploy/cdk/lib/rds-global-bundle.pem`, `rejectUnauthorized: true`) for TLS.
- **Security groups:** ALB → compute → database, one hop each; the database SG admits only the compute SG; nothing admits `0.0.0.0/0` except the ALB (443 via CloudFront) and NAT egress.
- **Backups:** automated RDS snapshots + point-in-time recovery (or `pg_dump → S3 → Glacier` if self-managed), per `TECH_STACK §6.3`.
- **Sync (tier model — [ADR-0010](adr/0010-tier-responsibilities-local-first-inversion.md)):** ElectricSQL **read-path** is meant to stream RLS-scoped Postgres rows into client PGlite (LWW on `updated_at`, 032) but is **not yet deployed** (§9a); **writes** go through the 043/046 Lambda write-API and are **live** (048 flushes the client queue to it). The client is authoritative **offline** (local-first, instant edits); the server is authoritative for **shared writes** it has actually received (validates + can reject) — but until Electric ships, those writes don't yet stream back out to other clients/devices. Domain logic stays client-side (thick client); the server tier is deliberately thin.

**v2 cost:** materially higher than v1 — a NAT gateway (~$32/mo per AZ + data processing), the compute tier, and RDS. Budget on the order of **$30–60+/month** depending on AZ count and instance sizes, versus v1's ~$0–1. Right-size AZs (one NAT gateway for `test`, multi-AZ NAT only for `prod`), and prefer Fargate/RDS smallest tiers until load justifies more.

**v2 CDK shape:** the `Gede-<Env>-Network` stack gained a **NAT gateway** + a private compute subnet tier alongside the existing isolated tier; `Gede-<Env>-Data` (RDS) + `Gede-<Env>-Api` (Fargate Electric-sync stub behind an internet-facing ALB) were added. This is **issue 030, shipped** (PR #3 + deploy fixes #4/#5/#6 — all five stacks live & verified). **Auth adds a `Gede-<Env>-Auth` (Cognito) stack** and **removes the `auth` Fargate service/route** from the Api stack (ADR-0009, issue 033); it later gains the **Post-Confirmation provisioning trigger** (issue 050). A sixth stack, **`Gede-<Env>-Migrations`**, was added for the one-shot schema applier (issue 045). The Api stack's write Lambda moved from an inline 503 stub to the real bundled handler (issue 046), and both it and the Hosting stack's CloudFront distribution gained the `/write*` + `/debug/db/*` path routing (issues 047/049). The tagging strategy (§6) and env-parameterization carry over unchanged; downstream sync/tenancy slices are issues 032–038 plus the M11 write-loop closure 044–050 (see `docs/issues/README.md`, ADR-0008/0009 for the wave plan).

---

## 10. Rollback & teardown

- **Rollback:** CloudFormation/CDK rolls back a failed `cdk deploy` automatically. To revert app content, redeploy a previous `dist/` build (hashed assets mean old and new coexist until the shell flips). CloudFront invalidation targets only `index.html` + `sw.js`.
- **Teardown (test):** `npx cdk destroy --all --profile phani-quadnomics`. The S3 bucket may need emptying first if not set to auto-delete; confirm nothing else depends on the VPC before destroying `Gede-Test-Network`.

---

## 11. Quick reference

```bash
aws sts get-caller-identity --profile phani-quadnomics     # confirm identity
cd deploy/cdk && npm ci                                     # CDK deps
npx cdk bootstrap aws://975049998516/us-east-1 --profile phani-quadnomics
cd <repo-root> && npm run build                            # build the PWA
cd deploy/cdk && AWS_PROFILE=phani-quadnomics npx cdk deploy --all
# → open the CloudFront URL from the Hosting stack output
```
