# 049: Database inspection API — read-only diagnostic queries against the cloud RDS

- **Status**: SHIPPED — deployed + verified live 2026-07-08: `/debug/db/counts` returns live table counts, auth-gated (secret/`x-debug-token` required; missing/wrong → `401`).
- **Milestone**: M11 (Close the cloud write loop — verification / observability)
- **Blocked by**: 045 (schema on RDS — SHIPPED), 046 (write Lambda pg/CA/secret pattern to mirror — SHIPPED), 047 (CloudFront API origin — SHIPPED)

## Slice

As the operator/developer, I can hit a **secured, read-only** HTTP API to inspect the cloud Postgres — row counts per table, recent rows, or a guarded read-only `SELECT` — so I can confirm that a frontend action (sign in → create project → edit a dimension) actually **persisted to RDS** through the write path (046/048), without standing up a bastion or hand-building a throwaway Lambda each time.

## Motivation

The M11 write loop is **deployed but unproven end-to-end**. We verified each hop in isolation (login enabled, real handler returns a typed 401, migrations applied), but we have **no repeatable way to confirm a frontend write lands in RDS** — the DB is in an isolated subnet with no public route and no bastion, and the only way we've read it so far is a one-off in-VPC Lambda hand-built for a single `count(*)` (see `scratchpad/qlambda`, verified 2026-07-08: 12 rows, all in `__migrations`; every domain table empty). That's not repeatable and not something the operator can run.

A small, secured, read-only inspection API turns *"did my write land?"* into a single authenticated `curl`. It is the missing **observability** for the write loop — the tool that lets us actually validate 046/048 with real frontend actions instead of inferring.

## AWS ground truth (verified 2026-07-08)

- RDS `gede-test-data-databaseb269d8bb-…` (db `gede`), **isolated subnet, no public route, no bastion**; reachable only from the compute SG. Creds in Secrets Manager (`Gede-Test-Data` `DatabaseSecretArn`).
- The write Lambda (`src/server/writeApi/albAdapter.ts`) already models the exact wiring to reuse: VPC subnets `subnet-09c7eda3fe98cd4d7` / `subnet-0f3e7da9c7e4daa94`, a SG admitted to the DB SG on `:5432`, Secrets Manager read, `pg` + the pinned Amazon RDS CA bundle (`deploy/cdk/lib/rds-global-bundle.pem`).
- 047 added a CloudFront origin fronting the ALB `/write*` over same-origin HTTPS (no-cache) — the same pattern this issue routes `/debug/db/*` through.
- Live DB state today: schema applied (14 tables), `applied_mutations` = 0 → **no writes have flowed yet**; this API is how we'll watch that change.

## Scope

- **A read-only Lambda in the VPC** — mirror 046's `albAdapter.ts`: `NodejsFunction`, `pg` + the pinned RDS CA (verified TLS, `rejectUnauthorized: true`), Secrets Manager creds, a SG admitted to the DB SG. Behind the ALB, routed via the CloudFront origin (047 pattern) under `/debug/db/*`, **no-cache**.
- **Auth — every request is secret-gated.** A shared bearer/`x-debug-token` secret (stored in **Secrets Manager / SSM**, never in the repo) is required; missing/wrong → `401`. **Never unauthenticated.**
- **Read-only, enforced in depth.** Connect and `SET TRANSACTION READ ONLY` + a `statement_timeout`; prefer a **dedicated read-only Postgres role** (SELECT-only grants, created via a migration) so the DB itself rejects any write. Mutations must be impossible even if the app-layer guard is bypassed.
- **Operations:**
  - `GET /debug/db/counts` → `{ table: count }` for every public table (the repeatable form of the one-off `count(*)`).
  - `GET /debug/db/rows?table=<whitelisted>&limit=<=100&order=updated_at.desc` → the most recent rows of one whitelisted table (the "did my last edit land?" view).
  - `POST /debug/db/query` `{ "sql": "SELECT …" }` → a **single `SELECT`/`WITH…SELECT` only**, row-capped and timeout-bounded. This is the "directly query" mode the operator asked for — the sharp edge, fully guarded (see Design brief).
- **Visibility.** Connect as an RLS-exempt owner/admin role so the operator sees **all** rows cross-tenant (debugging needs the full picture) — acceptable *only because* the endpoint is secret-gated and test-only.
- **Environment gating.** Enabled **only in the `test` env** via a CDK context/flag; a future `prod` must not expose it (or must sit behind far stronger auth). Out of scope: prod exposure.

Out of scope: any write/mutation path; a UI; multi-statement or non-`SELECT` SQL; replacing the write path's own tests; prod deployment.

## Design brief

- **Read-only by construction, not by convention.** Three independent guards: (1) an app-layer SELECT-only parser that rejects anything that isn't a lone `SELECT`/`WITH…SELECT` (no `;`-chained statements, no DML/DDL, no comment-smuggled writes), (2) `SET TRANSACTION READ ONLY` on the connection, (3) ideally a read-only DB role with only `SELECT` granted. Any one failing still can't mutate data.
- **Bounded.** Every query runs under a `statement_timeout` and a hard row cap so a bad query can't hang or dump the whole DB.
- **Secret-gated and test-only.** Exposing DB contents is genuinely sensitive; the shared secret + `test`-env gate keep it out of anonymous and prod reach. It rides the *existing* CloudFront/ALB public surface (047) — no new internet-facing resource — just gated.
- **Reuse, don't reinvent.** Same VPC/SG/secret/CA/bundling shape as 046; same CloudFront-origin/no-cache shape as 047; a pure, unit-testable core (SQL guard + op handlers) split from the thin AWS adapter, exactly like `handler.ts` vs `albAdapter.ts` (ADR-0010).
- **Answers one question well.** `counts` + `rows` answer *"did my write land?"* directly; the guarded `SELECT` is the power tool for everything else.

**References**: issues 046 (`albAdapter.ts` pg/CA/secret wiring to mirror), 047 (CloudFront API origin, no-cache), 045 (schema/migrations + where a read-only role migration would live), 034 (RLS — why admin visibility needs the owner role), 043 (typed-rejection error style, thin-adapter/pure-core split), 020 (layer/guardrail discipline) · ADR-0010 (thin server tier) · DEPLOYMENT §9/§9a (topology + the deployment-reality gap this observes).

## Test-first plan

1. **Auth gate**: no/invalid secret → `401`; valid secret → `200`.
2. **SQL guard (unit, pure core)**: `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`, `;`-chained multi-statements, and comment-smuggled DML (`SELECT 1; DROP …`, `SELECT 1 -- \n; DELETE …`) are **all rejected**; a plain `SELECT`/`WITH…SELECT` passes; the row cap and `statement_timeout` are applied.
3. **Read-only defense-in-depth**: even if a write reached the DB, the read-only transaction/role rejects it (tested against a local `postgres:17`, else skipped like the migration-parity check).
4. **counts**: returns `{table: count}` for all public tables (shape matches the one-off result).
5. **rows**: a whitelisted table returns ≤ `limit` rows ordered by `updated_at`; a non-whitelisted table is rejected.
6. **CDK assertions**: the debug Lambda + `/debug/db/*` ALB route + CloudFront no-cache behavior exist and are **`test`-env-gated** (absent when the env flag is off); `ECS::Service` count unchanged (serverless).
7. **Live smoke (post-deploy)**: after a real frontend sign-in + create-project, `GET /debug/db/counts` shows `projects` and `applied_mutations` > 0 — the end-to-end write-loop proof this whole tool exists for.

## Acceptance criteria

- [ ] A secret-gated, `test`-env-only, **read-only** inspection API is reachable over same-origin HTTPS; `counts`, `rows`, and a guarded `SELECT` all work; **no mutation is possible** through it.
- [ ] SELECT-only guard + read-only transaction/role + `statement_timeout` + row cap are enforced and unit-tested; the auth gate is tested.
- [ ] Prod is **not** exposed (env-gated); the shared secret lives in Secrets Manager, never in the repo.
- [ ] `npm run verify` + CDK assertions green; a live smoke confirms a real frontend write shows up in the counts.

## Implementation notes

- **This deploys the normal way** (CDK → CI on merge to `main`), *not* an ad-hoc `aws lambda create-function` — the write path (046) proved the pipeline handles a VPC Lambda + RDS + CA correctly.
- Add `src/server/debugApi/*`: a pure core (`sqlGuard.ts` SELECT-only parser, `operations.ts` counts/rows/query) that unit-tests without a live DB, plus a thin `albAdapter.ts`-style entry reusing 046's pg/CA/secret pattern. Route in `api-stack.ts` (or a small `debug-stack.ts`) under `/debug/db/*`, gated on a `debugApi` CDK context flag; extend the 047 CloudFront origin to also forward `/debug/db/*` (no-cache).
- The one-off `scratchpad/qlambda` handler (public-table `count(*)`) is the literal seed of the `counts` operation — lift and harden it.
- A read-only DB role (`app_readonly`, `GRANT SELECT`) as a new migration is the strongest read-only guarantee; pre-assign the next migration slot before parallel work (`0012`).
- **Security note for review**: this is an intentional, guarded exposure of DB contents for a `test` env. A security-reviewer pass should confirm the SELECT-only guard can't be bypassed, the secret is required on every path, and the env gate keeps it out of prod.
