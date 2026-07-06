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
> **Status (2026-07-06):** the two open decisions are **made in [ADR-0008](adr/0008-v2-backend-cdk-rds-electricsql.md)** — backend is **CDK VPC + NAT + RDS + Fargate** (T5 → RDS, superseding Lightsail/Compose), sync is **ElectricSQL** (T6), auth is **better-auth**, RLS authored in Postgres. **Issue 030** implements the network+RDS+Fargate foundation and is open as **PR #3 — reviewed but not yet merged: merging auto-deploys and starts v2 spend (~$30–60/mo) and mutates the live `Gede-Test-Network` in place to add the NAT gateway.** The stubbed `sync`/`auth` Fargate services are filled by issues 032 (Electric) / 033 (better-auth).

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
   │                        • auth         (better-auth — ADR-0008)          │
   │                      egress to the internet via the NAT Gateway         │
   │                                                                         │
   │  ISOLATED subnets    PostgreSQL 17 (RDS) — same Drizzle migrations as   │
   │                        v1's PGlite; workspace Row-Level Security (034);  │
   │                        no internet route at all                         │
   └─────────────────────────────────────────────────────────────────────────┘

   Sync model: server Postgres ⇄ client PGlite, row-deltas, last-write-wins
   (issue 032). The client stays local-first; the server is the shared source.
```

**v2 components & security:**

- **Ingress:** CloudFront/S3 frontend unchanged; `api.<domain>` (Route 53 alias) → an ALB in the public subnets. Only the ALB and NAT gateway live in public subnets.
- **Compute (private subnets, no public IP):** the sync engine (**ElectricSQL** — ADR-0008, issue 032) and auth (**better-auth** — ADR-0008, issue 033), on ECS Fargate. Egress via the **NAT gateway** only; ingress only from the ALB via security groups. (In PR #3 both are stubbed with an `nginx:alpine` placeholder behind path-routed `/sync*` `/auth*`.)
- **Database (isolated subnets):** managed **PostgreSQL 17** (RDS `db.t4g.micro`, single-AZ for `test`; T5 resolved to RDS, ADR-0008). It runs the **same Drizzle migration history** as v1's PGlite (the "one dialect, no migration cliff" bet, `TECH_STACK §2` — proven by `deploy/migration-parity/`) and enforces **workspace RLS** (issue 034). No internet route — reachable only from the compute security group; credentials in Secrets Manager.
- **Security groups:** ALB → compute → database, one hop each; the database SG admits only the compute SG; nothing admits `0.0.0.0/0` except the ALB (443) and NAT egress.
- **Backups:** automated RDS snapshots + point-in-time recovery (or `pg_dump → S3 → Glacier` if self-managed), per `TECH_STACK §6.3`.
- **Sync:** row-delta, last-write-wins between server Postgres and client PGlite (issue 032) — the client remains offline-capable and local-first; the server is the shared, RLS-scoped source of truth.

**v2 cost:** materially higher than v1 — a NAT gateway (~$32/mo per AZ + data processing), the compute tier, and RDS. Budget on the order of **$30–60+/month** depending on AZ count and instance sizes, versus v1's ~$0–1. Right-size AZs (one NAT gateway for `test`, multi-AZ NAT only for `prod`), and prefer Fargate/RDS smallest tiers until load justifies more.

**v2 CDK shape:** the `Gede-<Env>-Network` stack gains a **NAT gateway** and a private compute subnet tier alongside the existing isolated tier; new `Gede-<Env>-Data` (RDS) + `Gede-<Env>-Api` (Fargate: Electric sync + better-auth stubs, behind an internet-facing ALB) stacks are added. The tagging strategy (§6) and env-parameterization carry over unchanged. This is **issue 030, implemented in PR #3** (reviewed, green — 48 CDK tests + offline synth — but unmerged pending the cost-gate decision above); downstream sync/auth/tenancy slices are issues 032–038 (see `docs/issues/README.md` M8–M10 and ADR-0008 for the wave plan).

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
