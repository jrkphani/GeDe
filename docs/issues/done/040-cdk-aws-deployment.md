# 040: CDK AWS deployment — network → hosting → DNS (test env)

- **Status**: SHIPPED — deployed & verified live (PR #1); app at https://d1nzod71m3rz6x.cloudfront.net
- **Milestone**: M7 (Deploy)
- **Blocked by**: — (AWS account `975049998516` exists + the `phani-quadnomics` CLI profile is configured). Resolves issue 029's open IaC-tool decision (**CDK**, not Terraform) and provisions the resources 029's OIDC CI pipeline deploys.

## Slice

As the maintainer I can stand up GeDe's AWS footprint for the **test** environment from a single **AWS CDK (TypeScript)** app in `deploy/cdk/`, layered **network (VPC) → static hosting (S3 + CloudFront) → DNS (Route 53)**, with a consistent **tag strategy** on every resource. Because there is **no registered domain yet**, the app is served over HTTPS at CloudFront's **default `*.cloudfront.net` domain**, and the Route 53 layer is wired as a seam that activates the moment a real domain is registered — no rework.

## Motivation

TECH_STACK §6 specifies the v1 deploy (S3 + CloudFront, OIDC via GitHub Actions) but left the IaC tool as "CDK or Terraform — pick one" (issue 029). The AWS account now exists and the maintainer wants **CDK**, provisioned **network-first** with an explicit tagging strategy, on a **default public domain for testing**. This issue is the CDK app that makes the account reproducible from code (the deployment contract, §6.4), and gives 029's CI pipeline concrete stacks to `cdk deploy`.

## Tag strategy (applied app-wide, propagates to every resource)

| Tag | Value | Purpose |
| --- | --- | --- |
| `Organization` | `quadnomics` | Owning org |
| `Application` | `GeDe` | The app |
| `Environment` | `test` | This environment (future: `prod`) |
| `ManagedBy` | `CDK` | Never mutate these resources by hand (§6.4) |

Applied once via `Tags.of(app).add(...)` on the CDK `App` so every stack and resource inherits them; activate them as **cost-allocation tags** in Billing so spend is attributable per org/app/env. Resource/stack naming embeds the same triple: stacks `Gede-Test-Network` / `Gede-Test-Hosting` / `Gede-Test-Dns`; physical names `gede-test-*` (lowercase where required, e.g. the globally-unique S3 bucket).

## Scope

CDK app in **`deploy/cdk/`** (TypeScript — matches the repo stack), env-parameterized (an `env` context: `test` → account `975049998516`, region `us-east-1`), three layered stacks:

1. **Network (`Gede-Test-Network`)** — a VPC for the `test` env: 2 AZs, public + **private-isolated** subnets, and **no NAT gateway** (see the cost note — nothing in v1 needs private→internet egress; NAT is ~$32/mo/AZ). This is the account's network **foundation** for future v2 compute; the static PWA below does **not** route through it (S3 + CloudFront are serverless). Exported so v2 compute (a future issue) attaches without re-architecting.
2. **Hosting (`Gede-Test-Hosting`)** — a **private** S3 bucket (Origin Access Control, no public access) + **CloudFront** distribution serving the built PWA over HTTPS with the **default CloudFront certificate + default `*.cloudfront.net` domain**; HTTP/3, Brotli; the §6.2 cache policy (hashed assets `immutable, max-age=1y`; `index.html` + `sw.js` `no-cache`); SPA/PWA error routing (404/403 → `index.html`). A CDK `BucketDeployment` (or 029's CI `cdk deploy`) publishes `dist/`.
3. **DNS (`Gede-Test-Dns`)** — the Route 53 **seam**. With no `domainName` context (the `test` default), it is a **pass-through**: it creates no hosted zone (a zone without a registered domain is inert and pointless) and simply surfaces the CloudFront default URL as a stack output — that URL **is** the app's address for testing. When a `domainName` is later supplied, the same stack creates/uses a public hosted zone, a **DNS-validated ACM cert in us-east-1**, attaches the domain as a CloudFront alternate name, and adds A/AAAA **alias** records to the distribution. Documented so switching to a real domain is a config flip, not a rebuild.

Plus: `cdk bootstrap aws://975049998516/us-east-1` as a one-time prerequisite; a `deploy/cdk/README.md` documenting bootstrap, `cdk synth`/`diff`/`deploy`, and the domain-flip procedure.

Out of scope: the CI/CD wiring + OIDC role (issue 029 — its role scopes to *these* stacks); any v2 server/compute in the VPC (a future v2 issue); a `prod` environment (add when a domain + prod account decision land); registering a domain.

## Design brief

- **Lowest AWS cost stays the ethos** (TECH_STACK criterion 2): v1 is ~$0–1/mo. Do **not** add a NAT gateway for a static app — the VPC uses public + isolated subnets only; private egress/NAT is deferred to when v2 compute actually needs it. Call the cost out in the VPC construct's comment.
- **Least privilege, no standing secrets**: the S3 bucket is private (OAC only); 029's deploy role (OIDC, short-lived) is scoped to these stacks. No access keys in the repo.
- **IaC is the contract, and CI is the trigger** (§6.4, T8): the account is reproducible from `deploy/cdk/`; humans never click-ops. A manual `cdk deploy` is allowed **only for first-run bootstrap** (before the pipeline exists). Steady state, **`cdk deploy` is triggered exclusively from GitHub Actions on `main`** (issue 029) via the OIDC role — never from a laptop. On **pull requests**, CI runs `cdk synth` + `cdk diff` + this app's assertion/snapshot tests (no AWS mutation), so infra changes are reviewed before they can deploy. This issue makes the CDK app *CI-deployable* (a `cdk deploy --all --require-approval never` with credentials from an assumed role, `dist/` built beforehand); 029 owns the workflow + OIDC role that does the assuming.
- **Default domain now, real domain later, zero rework**: the DNS seam means "test on the CloudFront URL" and "cut over to `app.<domain>`" differ by one context value, per the maintainer's "default public domain for testing" direction.
- **Tags are load-bearing**: every resource carries org/app/env so cost, cleanup, and multi-env isolation are trivial — set once at the `App`, never per-resource.

**References**: TECH_STACK §6.1 (environments), §6.2 (S3+CloudFront, cache policy, SW update), §6.4 (IaC-as-contract, Actions-only deploy, T8) · SPEC §5 (installable PWA, static hosting) · issue 029 (OIDC CI pipeline that deploys these stacks; this issue picks CDK) · the AWS account `975049998516` / `phani-quadnomics` profile.

## Test-first plan

CDK ships an assertions library — the tests are template assertions on the synthesized CloudFormation, plus a synth snapshot (no live AWS needed in CI):

1. **`cdk synth` clean** for the `test` env; a **snapshot test** of each stack's template (guards accidental drift).
2. **Fine-grained assertions (`Template.fromStack`)**: the S3 bucket blocks all public access + has OAC; the CloudFront distribution uses the **default** cert/domain (no `Aliases`/ACM when no domain), HTTP/3, Brotli, and the §6.2 cache behaviors; SPA error routing to `index.html`.
3. **Tag assertions**: every taggable resource carries `Organization=quadnomics`, `Application=GeDe`, `Environment=test`, `ManagedBy=CDK` (assert on the synthesized template).
4. **Network assertions**: the VPC has 2 AZs, public + isolated subnets, and **zero NAT gateways** (the cost guard — a NAT gateway appearing is a test failure).
5. **DNS seam**: with no `domainName`, the Dns stack creates no `AWS::Route53::HostedZone` and no ACM cert, and outputs the CloudFront domain; a unit test of the stack with a `domainName` set asserts the zone + us-east-1 cert + alias records appear (the flip works).
6. **CI-deployability**: `cdk synth`, `cdk diff`, and the assertion/snapshot tests run headless with no interactive prompts and no long-lived creds — i.e. they run in GitHub Actions on PRs (validation) and `cdk deploy --all --require-approval never` works under an assumed role (the shape 029's workflow invokes). No `cdk deploy` step assumes a human is present.
7. **Deploy smoke (manual bootstrap, first run only)**: the first `cdk deploy` into `975049998516`; the CloudFront default URL serves the PWA (PGlite boots, a project can be created), `index.html` is `no-cache`, a hashed asset `immutable` — captured as a checklist in `deploy/cdk/README.md`. After this bootstrap, deploys come from CI (029).

## Acceptance criteria

- [ ] A CDK (TS) app in `deploy/cdk/` with `Gede-Test-Network` / `Gede-Test-Hosting` / `Gede-Test-Dns` stacks, env-parameterized for `test` (account `975049998516`, `us-east-1`).
- [ ] The PWA is reachable over HTTPS at the **CloudFront default domain** (no custom domain); S3 is private (OAC); §6.2 cache policy applied.
- [ ] The VPC is provisioned network-first with **no NAT gateway** (cost guard) and exports for future compute; the static app doesn't depend on it.
- [ ] Route 53 is wired as a seam: inert (no zone) without a domain, and a documented one-config-value flip to a real domain (hosted zone + us-east-1 ACM + alias).
- [ ] Every resource carries the `Organization`/`Application`/`Environment`/`ManagedBy` tags via app-level tagging.
- [ ] `cdk synth` clean; template + tag + no-NAT assertions green; `npm run verify` unaffected (the CDK app has its own test target); a first `cdk deploy` smoke-verified.

## Implementation notes

- **Phasing** (CLAUDE.md ≤5-file rule): land **(1) Network** → **(2) Hosting** (the actual v1 value — a live URL) → **(3) DNS seam**, each with its assertions, rather than one mega-stack. Hosting is the milestone that yields a testable URL.
- **CDK app layout**: `deploy/cdk/` with its own `package.json`/`tsconfig`/`cdk.json` (kept separate from the app's build so `npm run verify` and the CDK tests don't entangle); env config in `bin/`; stacks in `lib/`. TypeScript CDK aligns with the repo.
- **Tags**: `Tags.of(app).add('Organization','quadnomics')` etc. on the `App` in `bin/` — inherited by all stacks/resources; note in the README to activate them as cost-allocation tags in the Billing console.
- **Default domain**: rely on the CloudFront distribution's `*.cloudfront.net` domain + its default viewer certificate; do **not** create an ACM cert or `Aliases` when no `domainName` context is set (ACM for a domain you don't own can't validate).
- **Bootstrap**: `cdk bootstrap aws://975049998516/us-east-1` once (uses the `phani-quadnomics` profile) before the first deploy; document it.
- **Relationship to 029**: this issue provisions the infra + decides CDK; 029 wires the GitHub Actions OIDC role to run `cdk deploy` on `main` behind the `verify` gate. The bucket/distribution 029 referenced are the ones this creates. Update 029 to `Blocked by: 040` when picked up.
- **Cost**: target ~$0–1/mo for `test` — S3+CloudFront at hobby traffic, a NAT-free VPC (~$0 idle). Flag any construct that would add standing cost (NAT, idle ALB, provisioned anything) in review.
