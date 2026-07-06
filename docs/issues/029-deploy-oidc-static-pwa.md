# 029: Deploy pipeline — OIDC static PWA to S3 + CloudFront

- **Status**: OPEN
- **Milestone**: M7 (Deploy — the v1→v2 enabler)
- **Blocked by**: — (the app + `verify.yml` are ready; this is the deferred deploy half, TECH_STACK §6.2/§6.4)

## Slice

As the maintainer I can land on `main`, watch CI go green, and have the built PWA **published automatically** to a private S3 origin behind CloudFront — no human ever runs `aws s3 sync`, and no long-lived AWS keys exist anywhere. This is the deploy half that was deferred pending the AWS-account decision; it unblocks a real URL for v1 and is the foundation every v2 issue deploys onto.

## Motivation

`verify.yml` runs the full gate on push/PR and is CI-green, but there is **no deploy job** — the app only runs locally. TECH_STACK §6.2 specifies the pipeline (build → `aws s3 sync` via OIDC → CloudFront invalidation) and §6.4 makes GitHub Actions + OIDC the *only* deploy path (T8). Nothing ships until this exists.

## Scope

- **Infra (in `deploy/`)**: a private **S3** bucket with **Origin Access Control**; **CloudFront** distribution (ACM cert in us-east-1, HTTP/3, Brotli); the cache policy from §6.2 (hashed assets `immutable, max-age=1y`; `index.html` + `sw.js` `no-cache`). Infrastructure as code (CDK or Terraform — pick one, note it in the ADR) so the account is reproducible, not click-ops.
- **OIDC trust**: a GitHub → AWS OIDC identity provider + a deploy role scoped to exactly this bucket + a CloudFront invalidation; **no access keys in repo secrets** (§6.4, T8).
- **Deploy workflow** (`.github/workflows/deploy.yml`): on push to `main`, **after `verify` is green**, run `vite build` → `aws s3 sync ./dist` → `cloudfront create-invalidation` for `index.html`/`sw.js` only. Deploy is blocked if verify fails (same gate as local, issue 000).
- **Service-worker update UX** already specified (§6.2): `registerType: 'prompt'` → the quiet status-line "New version — Reload", never auto-reload.
- **Env split** (§6.1): `main` → production. **Preview** (per-PR build to an `/preview/<pr>/` prefix) is *out of scope here* — optional until collaborators exist (its own issue when v2 lands).

Out of scope: any server/backend (that is v2, issue 030); custom domain/Route 53 (a small follow-up once the account + a domain exist); preview environments.

## Design brief

- **Least privilege, no standing secrets**: OIDC short-lived role assumption only; the role can write the one bucket and invalidate the one distribution, nothing else.
- **Atomic deploys from the user's view**: hashed immutable assets stay valid until the new `no-cache` shell references new hashes — a mid-deploy visitor never gets a half-updated app.
- **Reproducible account**: the AWS topology lives in `deploy/` as code and is the deployment contract; the account can be torn down and recreated from it.
- **One gate**: reuse `npm run verify` as the deploy precondition; do not fork a second, weaker check.

**References**: TECH_STACK §6.1 (environments), §6.2 (v1 pipeline + cache policy + SW update), §6.4 (CI/CD rules, OIDC, T8) · SPEC §5 (PWA) · issue 000 (the verify gate) · issue 015 (JSON export as the pre-cutover backup story).

## Test-first plan

1. **Workflow lint / dry-run**: `deploy.yml` parses; the deploy job `needs:` the verify job and is gated on `main` only (assert in a workflow-validation step or a `act`/dry-run).
2. **IaC validation**: the `deploy/` stack synthesizes/plans cleanly (cdk synth / terraform validate) with the bucket private (no public ACL), OAC attached, and the cache policy as specified.
3. **Smoke (post-deploy, manual first run)**: the CloudFront URL serves `index.html` `no-cache`, a hashed asset `immutable`, and the app boots (PGlite ready, a project can be created) — captured as a checklist in the ADR until an automated post-deploy smoke test is worth it.
4. **Negative**: a red `verify` blocks the deploy job (verify the `needs` gate, don't just trust it).

## Acceptance criteria

- [ ] Push to `main` → green `verify` → automatic publish to the private S3 origin + CloudFront invalidation, with **zero long-lived AWS credentials** in the repo.
- [ ] Bucket is private (OAC only); cache policy matches §6.2; SW prompts to reload, never auto-reloads.
- [ ] The AWS topology is codified in `deploy/`; a red verify blocks deploy.
- [ ] An ADR records the IaC choice (CDK vs Terraform) and the account/region.

## Implementation notes

- Keep deploy code in `.github/workflows/` + `deploy/` and reference §6.4 from any change to it (the doc is the contract).
- Cost target ~$0–1/month (static hosting of a ~5 MB app). Route 53 + a custom domain is a later ~$0.50/zone add-on.
- This issue is **pure infra + CI** — no `src/` changes expected beyond confirming the Vite build output and SW registration already match §6.2.
