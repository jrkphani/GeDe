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
| App URL | CloudFront **default** domain (`https://<id>.cloudfront.net`) — no custom domain yet |
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

`cdk bootstrap` is idempotent and only needs to run once per account/region.

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

Manual `cdk deploy` is fine for bring-up; the steady state is **GitHub Actions only** (`TECH_STACK §6.4`, issue 029):

- On push to `main`, **after `npm run verify` is green**, a workflow runs `cdk deploy` (or builds + syncs `dist/`) into `975049998516`.
- AWS access is via **GitHub OIDC federation** — a short-lived role assumption scoped to these stacks. **No long-lived AWS keys in the repo.**
- A red `verify` blocks the deploy (same gate as local).
- Service-worker updates are `registerType: 'prompt'` — a quiet status-line "New version — Reload", never an auto-reload (an in-place edit must not be lost). Deploys are atomic from a user's view: hashed immutable assets stay valid until the new `no-cache` shell references new hashes.

---

## 9. v2 architecture (future) — **private VPC + NAT gateway**

> **When GeDe gains a server (v2 — collaboration: sync, auth, workspaces), it moves into a private VPC with a NAT gateway.** v1's static frontend is unchanged; v2 adds a backend tier behind it. This supersedes the earlier Lightsail sketch in `TECH_STACK §6.3` for a CDK-managed, AWS-native account.

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
   │  PRIVATE subnets     Compute (ECS Fargate or EC2) — no public IP:       │
   │                        • API / app service                              │
   │                        • sync engine  (ElectricSQL or Supabase — T6)    │
   │                        • auth         (better-auth or Supabase auth)    │
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
- **Compute (private subnets, no public IP):** the API, the sync engine (T6: ElectricSQL vs self-hosted Supabase — decided in issue 031), and auth (issue 033). Egress via the **NAT gateway** only; ingress only from the ALB via security groups.
- **Database (isolated subnets):** managed **PostgreSQL 17** (RDS; `TECH_STACK` T5 revisits Lightsail-vs-RDS). It runs the **same Drizzle migration history** as v1's PGlite (the whole "one dialect, no migration cliff" bet, `TECH_STACK §2`) and enforces **workspace RLS** (issue 034). No internet route — reachable only from the compute security group.
- **Security groups:** ALB → compute → database, one hop each; the database SG admits only the compute SG; nothing admits `0.0.0.0/0` except the ALB (443) and NAT egress.
- **Backups:** automated RDS snapshots + point-in-time recovery (or `pg_dump → S3 → Glacier` if self-managed), per `TECH_STACK §6.3`.
- **Sync:** row-delta, last-write-wins between server Postgres and client PGlite (issue 032) — the client remains offline-capable and local-first; the server is the shared, RLS-scoped source of truth.

**v2 cost:** materially higher than v1 — a NAT gateway (~$32/mo per AZ + data processing), the compute tier, and RDS. Budget on the order of **$30–60+/month** depending on AZ count and instance sizes, versus v1's ~$0–1. Right-size AZs (one NAT gateway for `test`, multi-AZ NAT only for `prod`), and prefer Fargate/RDS smallest tiers until load justifies more.

**v2 CDK shape:** the `Gede-<Env>-Network` stack gains a **NAT gateway** and private/isolated subnet tiers (the v1 stack's forward-looking exports are consumed here); new `Gede-<Env>-Api`, `Gede-<Env>-Data` stacks add the ALB + compute + RDS. The tagging strategy (§6) and env-parameterization carry over unchanged. This lands as its own issue when v2 kicks off (see issues 030–038 for the sync/auth/tenancy slices).

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
