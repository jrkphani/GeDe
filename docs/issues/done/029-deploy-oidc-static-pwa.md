# 029: Deploy pipeline — GitHub Actions OIDC → `cdk deploy`

- **Status**: SHIPPED — pipeline live (PR #1); every deploy this session ran through it (v1 live + v2 stacks)
- **Milestone**: M7 (Deploy — the v1→v2 enabler)
- **Blocked by**: 040 (the CDK infra this pipeline deploys). The app + `verify.yml` are ready; this is the deferred deploy half, TECH_STACK §6.2/§6.4.

## Slice

As the maintainer I can land on `main`, watch CI go green, and have the built PWA **published automatically** to a private S3 origin behind CloudFront — no human ever runs `aws s3 sync`, and no long-lived AWS keys exist anywhere. This is the deploy half that was deferred pending the AWS-account decision; it unblocks a real URL for v1 and is the foundation every v2 issue deploys onto.

## Motivation

`verify.yml` runs the full gate on push/PR and is CI-green, but there is **no deploy job** — the app only runs locally. Issue **040** defines the AWS infrastructure as a **CDK** app (network → hosting → DNS); this issue is the **GitHub Actions pipeline that deploys it**. §6.4 makes GitHub Actions + OIDC the *only* deploy path (T8): a human's manual `cdk deploy` is for first-run bootstrap only — steady-state deploys are triggered from CI on `main`, never from a laptop. Nothing ships until this exists.

## Scope

- **Infra is issue 040, not here.** The S3 bucket, CloudFront, VPC, DNS seam, and cache policy are all defined by the **CDK** app in `deploy/cdk/` (issue 040). This issue does **not** redefine them — it wires the pipeline that runs `cdk deploy` against those stacks.
- **OIDC trust**: a GitHub → AWS OIDC identity provider in account `975049998516` + a **CI deploy role** that CI assumes (short-lived, no access keys in repo secrets — §6.4, T8). Because deploys go through CDK/CloudFormation, the role's permissions cover **`cdk deploy`** — the CDK toolkit (assume the CDK deploy/publish roles from `cdk bootstrap`) plus CloudFormation and the stacks' resources — not just "write one bucket + invalidate". Scope it to the `Gede-*` stacks, not account-admin.
- **Deploy workflow** (`.github/workflows/deploy.yml`): on push to `main`, **after `verify` is green**, `npm run build` → `cd deploy/cdk && npx cdk deploy --all --require-approval never` under the assumed OIDC role. CDK's `BucketDeployment` publishes `dist/` and invalidates the CloudFront shell paths — no hand-rolled `s3 sync`/`create-invalidation`. Deploy is blocked if verify fails (same gate as local, issue 000).
- **PR vs `main`**: pull requests run **`cdk synth` + `cdk diff` + the CDK assertion tests** (no AWS mutation, read-only or no creds) so infra changes are reviewable; **only pushes to `main` actually `cdk deploy`**. This keeps deployment a CI event, never a manual one.
- **Service-worker update UX** already specified (§6.2): `registerType: 'prompt'` → the quiet status-line "New version — Reload", never auto-reload.
- **Env split** (§6.1): `main` → the `test` env (account `975049998516`); a `prod` env/account is a later decision. **Preview** (per-PR build to an `/preview/<pr>/` prefix) is *out of scope here* — optional until collaborators exist (its own issue when v2 lands).

Out of scope: the CDK infra definition itself (issue 040); any server/backend (v2, issues 030–038); custom domain/Route 53 cutover (040's DNS seam, once a domain exists); preview environments.

## Design brief

- **Least privilege, no standing secrets**: OIDC short-lived role assumption only; the role can write the one bucket and invalidate the one distribution, nothing else.
- **Atomic deploys from the user's view**: hashed immutable assets stay valid until the new `no-cache` shell references new hashes — a mid-deploy visitor never gets a half-updated app.
- **Reproducible account**: the AWS topology lives in `deploy/` as code and is the deployment contract; the account can be torn down and recreated from it.
- **One gate**: reuse `npm run verify` as the deploy precondition; do not fork a second, weaker check.

**References**: issue **040** (the CDK infra this pipeline deploys) · TECH_STACK §6.1 (environments), §6.2 (cache policy + SW update), §6.4 (CI/CD rules, OIDC, T8) · SPEC §5 (PWA) · issue 000 (the verify gate) · issue 015 (JSON export as the pre-cutover backup story) · `docs/DEPLOYMENT.md` (the operator guide).

## Test-first plan

1. **Workflow lint / dry-run**: `deploy.yml` parses; the deploy job `needs:` the verify job and is gated on `main` only (assert in a workflow-validation step or a `act`/dry-run).
2. **IaC validation**: the `deploy/` stack synthesizes/plans cleanly (cdk synth / terraform validate) with the bucket private (no public ACL), OAC attached, and the cache policy as specified.
3. **Smoke (post-deploy, manual first run)**: the CloudFront URL serves `index.html` `no-cache`, a hashed asset `immutable`, and the app boots (PGlite ready, a project can be created) — captured as a checklist in the ADR until an automated post-deploy smoke test is worth it.
4. **Negative**: a red `verify` blocks the deploy job (verify the `needs` gate, don't just trust it).

## Acceptance criteria

- [ ] Push to `main` → green `verify` → CI assumes the OIDC role and runs `cdk deploy --all` (publishing `dist/` + invalidating the shell), with **zero long-lived AWS credentials** in the repo.
- [ ] Pull requests run `cdk synth`/`diff` + CDK tests only (no AWS mutation); **only `main` deploys** — deployment is never triggered manually in steady state.
- [ ] The OIDC role is scoped to the `Gede-*` stacks (CDK/CloudFormation + their resources), not account-admin; a red `verify` blocks the deploy job.
- [ ] SW prompts to reload, never auto-reloads (§6.2); the IaC tool decision (CDK) lives in 040/its ADR.

## Implementation notes

- Keep deploy code in `.github/workflows/` + `deploy/` and reference §6.4 from any change to it (the doc is the contract).
- Cost target ~$0–1/month (static hosting of a ~5 MB app). Route 53 + a custom domain is a later ~$0.50/zone add-on.
- This issue is **pure infra + CI** — no `src/` changes expected beyond confirming the Vite build output and SW registration already match §6.2.
