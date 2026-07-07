# 046: Deploy the real write-path Lambda + wire the Cognito issuer

- **Status**: SHIPPED — code complete; combined verify green (837 vitest + 87 CDK jest + `cdk synth --all`; real handler bundles offline, issuer resolves as a cross-stack ref); integrated on `m11-close-write-loop`. **Live AWS deploy pending** (CI on merge to `main`, after 045); the `/write` 503 stub is replaced live at that point.
- **Milestone**: M11 (Close the cloud write loop)
- **Blocked by**: 043 (real handler code — SHIPPED, unit-tested, undeployed), 045 (RDS schema must exist first), 044 (real Cognito ids to derive the issuer)

## Slice

As a signed-in collaborator, a `POST /write` with a valid Cognito JWT is **actually processed** — authenticated, tenancy-scoped, invariant-validated, and persisted to the RDS by the real handler (`src/server/writeApi/*`) — instead of the current deterministic `503` inline stub that ignores the request entirely.

## Motivation

Issue 043 built and unit-tested the full write authority (`handler.ts`, `albAdapter.ts`, `store.ts` with real `pg`/RLS `set_config`, `jwt.ts` JWKS verification) but **deferred bundling** — the deployed Lambda is a `Code.fromInline(503)` placeholder, and its `COGNITO_ISSUER` is a literal `PLACEHOLDER_USER_POOL_ID`. So even with a real JWT, every write returns `503 write-path not yet wired`. This issue is 043's explicit "integration pass" follow-up: swap the stub for the real bundled handler and cross-stack-wire the issuer.

## AWS ground truth (verified 2026-07-07)

- **Deployed Lambda** `Gede-Test-Api-WriteApiFunction5106E371-2PvLQCdOFbzl` (nodejs20.x): downloaded code is **230 bytes**, exactly `exports.handler = async () => ({ statusCode: 503, body: 'write-path not yet wired (issue 043 follow-up)' });`. Live probe `POST http://…elb…/write` → **503** regardless of auth header.
- **Env vars**: `DATABASE_ENDPOINT` and `DATABASE_SECRET_ARN` are correctly set; **`COGNITO_ISSUER = https://cognito-idp.us-east-1.amazonaws.com/PLACEHOLDER_USER_POOL_ID`** (placeholder — the real issuer is `.../us-east-1_d0qKGDQmC`).
- **Networking is ready**: Lambda is VPC-attached (private subnets, SG `sg-063bbc30b9dbdcc62`), and the DB SG admits that SG on `:5432`. The `/write*` ALB target group (`Gede-T-Write-*`, `TargetType.LAMBDA`) already routes to it. Only the *code* and the *issuer* are wrong.
- **CDK source**: `deploy/cdk/lib/api-stack.ts:190` uses `lambda.Code.fromInline("…503…")` with a comment naming this exact follow-up.

## Scope

- **Replace `Code.fromInline(503)` with the real handler**, bundled from `src/server/writeApi/albAdapter.ts` via `NodejsFunction`/esbuild (043 already added `esbuild` as a `deploy/cdk` devDependency and confirmed offline/no-Docker bundling). Keep bundling **deterministic + toolchain-safe** (the issue-041 hazard) — pin the esbuild asset hashing the way Hosting's `normalize-asset-hashes.ts` does if the CI asset hash proves machine-sensitive.
- **Wire the real `COGNITO_ISSUER`** via a cross-stack reference to the `Gede-Test-Auth` User Pool (or its `UserPoolJwksUri`/issuer output) — not a hardcoded string. The Api stack consumes the Auth stack's export; a pool change can't silently break JWT validation.
- **Confirm the least-priv DB role + Secrets Manager read**: the bundled handler's `pg.Pool` connects with the `DatabaseSecretArn` creds as the `app_user` role (034) so RLS applies; grant the Lambda `secretsmanager:GetSecretValue` on that secret (verify the role already has it).
- **Health/first-write smoke**: after deploy, an authenticated `POST /write` with a legal mutation returns success and the row appears in RDS (verified via the read path once 048 lands, or directly by the migration runner's diagnostic query).

Out of scope: the client that calls it (048); applying the schema (045 — prerequisite); TLS (047); presence (038).

## Design brief

- **Thin, validate-and-persist** (ADR-0010): this deploys the seam 043 already designed; no new domain logic. The handler is runtime-agnostic and fully unit-tested — this issue is about *bundling + config*, not new behavior.
- **No drift between client and server rules**: the handler already imports the shared `src/domain/writeInvariants.ts` predicates — keep that shared import intact through bundling (don't fork the rules into the Lambda).
- **Deterministic synth** (issue 041 lesson): a machine-sensitive asset hash breaks CI; ensure `cdk synth` is reproducible.

**References**: issue 043 (the handler + its "integration pass" deferral notes; `api-stack.ts`) · ADR-0010 (server write authority) · ADR-0009 (Cognito JWT/JWKS) · issue 044 (real Cognito ids), 045 (schema), 034 (RLS/`app_user`) · issue 041 (deterministic Lambda bundling hazard) · DEPLOYMENT §9.

## Test-first plan

1. **CDK swap (assertion)**: `api-stack.test.ts` asserts the write function is a bundled `AWS::Lambda::Function` (not the inline 503 string) whose `COGNITO_ISSUER` resolves to a cross-stack ref to the Auth pool, not `PLACEHOLDER`. `ECS::Service` count stays at 1 (sync) — no new always-on task.
2. **Handler integration (existing, must stay green)**: `handler.test.ts`/`jwt.test.ts`/`tenancy.test.ts`/`pgWriteStore.contract.test.ts` continue to pass against the bundled entry.
3. **Bundling determinism (CI)**: `cdk synth` produces a stable asset hash across machines (mirror the 041/`normalize-asset-hashes` guard if needed).
4. **Live smoke (post-deploy)**: `POST /write` with a valid JWT + legal mutation → 200 and a persisted row; an invalid JWT → 401/403 (not 503); an illegal mutation → typed rejection (not 503).

## Acceptance criteria

- [ ] The deployed `/write` runs the real handler: valid JWT + legal mutation persists to RDS; invalid JWT → 401/403; illegal/cross-tenant → typed rejection. **No more blanket 503.**
- [ ] `COGNITO_ISSUER` is a cross-stack reference to `us-east-1_d0qKGDQmC` (no `PLACEHOLDER`, no hardcode).
- [ ] Bundling is deterministic; `ECS::Service` count unchanged (serverless write path preserved).
- [ ] `npm run verify` + CDK assertions green; post-deploy smoke passes.

## Implementation notes

- 043's "Shipped notes" already lists the exact steps: (1) point `COGNITO_ISSUER` at the real pool, (2) keep `PgWriteStore`'s tenant-context GUCs (or swap for 034's `tenantContext.ts` helper), (3) leave the client wiring to 048. Follow them.
- Sequencing: **045 (schema) must land first** — deploying the real handler against an empty RDS makes the first legal write 500 on a missing table. Deploy order: 045 → 046 → 048.
- Deploy itself is CI's job (TECH_STACK §6.4) — this issue's "done" is merge-ready CDK + green synth/tests; the live swap happens on merge to `main`.
