# GeDe — CDK deploy app (issue 040)

AWS CDK (TypeScript) app that provisions GeDe's `test`-environment AWS
footprint: network → static hosting → DNS. Fully self-contained — its own
`package.json`/`tsconfig.json`/`cdk.json`/tests, never touched by the root
web app's `npm run verify`.

Companion docs: `../../docs/DEPLOYMENT.md` (the operator guide),
`../../docs/issues/040-cdk-aws-deployment.md` (this app's spec),
`../../docs/issues/029-deploy-oidc-static-pwa.md` (the CI pipeline that
deploys this app), `../../docs/TECH_STACK.md` §6.

## Stacks

| Stack | Provisions |
| --- | --- |
| `Gede-Test-Network` | VPC, 2 AZ, public + private-isolated subnets, **no NAT gateway** (cost guard) |
| `Gede-Test-Hosting` | Private S3 bucket (Origin Access Control) + CloudFront distribution serving the built PWA |
| `Gede-Test-Dns` | Route 53 seam — inert (CloudFront URL output only) without a domain |

Deploy order: Network → Hosting → Dns (each stack declares `addDependency`
on the previous one via `lib/build-app.ts`, which both `bin/gede.ts` and
the test suite use, so tests exercise the exact production wiring).

## One-time setup

```bash
npm ci

# Confirm the CLI profile resolves to the right account first:
aws sts get-caller-identity --profile phani-quadnomics
# → arn:aws:iam::975049998516:user/Phani-quadnomics

# Bootstrap the account/region for CDK (creates the CDK toolkit stack).
# One-time, per account/region. Run by a human — never CI.
npx cdk bootstrap aws://975049998516/us-east-1 --profile phani-quadnomics
```

## Everyday commands

```bash
# Build the web app first — Hosting's BucketDeployment publishes ../../dist
cd <repo-root> && npm run build

cd deploy/cdk
export AWS_PROFILE=phani-quadnomics

npx cdk synth            # render CloudFormation, no AWS calls needed
npx cdk diff              # what would change (needs AWS creds/profile)
npx cdk deploy --all --require-approval never
npm test                  # jest — template assertions + synth snapshots
```

`cdk synth` and `npm test` run **fully offline** — no AWS credentials
required (see "Offline synth" below). `cdk diff`/`cdk deploy` need the
`phani-quadnomics` profile (or equivalent CI OIDC creds).

## Env / tag model

- One named env today: `test` → account `975049998516`, region `us-east-1`
  (`lib/build-app.ts`). A future `prod` env is added there when a domain +
  prod account decision land.
- Every resource inherits four tags, set once on the CDK `App`
  (`cdk.Tags.of(app).add(...)` in `lib/build-app.ts`):

  | Tag | Value |
  | --- | --- |
  | `Organization` | `quadnomics` |
  | `Application` | `GeDe` |
  | `Environment` | `test` |
  | `ManagedBy` | `CDK` |

  Activate these as **cost-allocation tags** in the Billing console.

## Offline synth (no AWS credentials)

`cdk synth` and the jest suite must succeed with zero AWS credentials (CI
runs PR validation this way; issue 040's constraint). Two things make that
possible, both worth knowing if you touch `lib/network-stack.ts` or `bin/gede.ts`:

1. **VPC availability zones are hardcoded**, not resolved via `maxAzs`
   (`lib/network-stack.ts`: `availabilityZones: ['us-east-1a', 'us-east-1b']`).
   `us-east-1` always has these two AZs.
2. **`cdk.context.json` caches the AZ validation lookup.** Even with an
   explicit `availabilityZones` list, `aws-cdk-lib`'s `Vpc` construct still
   validates the given zones are a subset of `Stack.availabilityZones` —
   which is itself a *separate* context-provider lookup requiring a live
   AWS call (assuming the CDK "lookup role") unless the answer is cached.
   `cdk.context.json` commits that cached answer for
   `account=975049998516, region=us-east-1` so `cdk synth` never attempts
   the live lookup. If this ever needs regenerating (e.g. a new account),
   delete the stale key and run `cdk synth` once with real credentials,
   then commit the refreshed file — the AZ list for an account/region is
   extremely stable and essentially never changes.

The jest tests go one step further and pass AZ context directly via
`new cdk.App({ context: {...} })` in each test file, so they don't even
depend on the committed `cdk.context.json`.

## Missing `dist/` at synth time

`Gede-Test-Hosting`'s `BucketDeployment` needs a source directory, but
`cdk synth`/the test suite must succeed even before `npm run build` has
ever run (a fresh checkout, or CI running CDK tests before the web build
step). `lib/hosting-stack.ts` resolves `../../../dist` first and falls back
to the committed `assets/placeholder/` (a one-file stub) if it doesn't
exist yet. **CI always builds the web app before `cdk deploy`**
(`.github/workflows/deploy.yml`), so production deploys always publish the
real `dist/` — the placeholder is never shipped.

## Domain-flip procedure (no domain today → a real domain later)

Today (`test` env, no `domainName` context): the app is served at
CloudFront's default `*.cloudfront.net` domain; `Gede-Test-Dns` creates no
hosted zone, no ACM cert — just outputs that URL.

To cut over to a real domain (e.g. `app.example.com`) once one is
registered, in two passes (CloudFront needs the ACM cert ARN *at
distribution-creation time*, but the cert can only be created after
`Gede-Test-Hosting` exists — see the "chicken-and-egg" note in
`lib/dns-stack.ts` for why this can't be a single circular-dependency pass):

```bash
# Pass 1 — create the hosted zone + DNS-validated cert, get NS + cert ARN.
npx cdk deploy Gede-Test-Dns -c domainName=app.example.com

# Read the "HostedZoneNameServers" output and delegate your registrar's NS
# records to them. Read the "CertificateArn" output for pass 2.

# Pass 2 — attach the domain + cert to the distribution as an alternate name
# (CloudFront updates in place; no replacement).
npx cdk deploy Gede-Test-Hosting \
  -c domainName=app.example.com \
  -c certificateArn=<arn-from-pass-1-output>

# Gede-Test-Dns's alias records already point at the distribution from
# pass 1 — no further Dns changes needed. Confirm https://app.example.com
# resolves.
```

Both context values (`domainName`, `certificateArn`) can also be baked into
`cdk.json`'s `context` block once a domain is permanent, instead of passed
via `-c` each time.

## Teardown (test env only)

```bash
npx cdk destroy --all --profile phani-quadnomics
```

The S3 bucket has `autoDeleteObjects: true` (test env only — a future
`prod` env should use `RemovalPolicy.RETAIN`), so `cdk destroy` empties and
removes it in one step. Confirm nothing else depends on `Gede-Test-Network`
before destroying it.

## What CI does with this app

- **Pull requests** (`.github/workflows/deploy.yml`, `cdk-validate` job):
  `npm ci && npx cdk synth && npm test`, plus `cdk diff` on same-repo PRs
  when OIDC credentials are available. Never deploys.
- **`main`**, once the separate `verify` workflow finishes successfully
  (`workflow_run` trigger — `needs:` only works within one workflow file,
  and `verify.yml` is deliberately left untouched): builds the web app,
  assumes the OIDC deploy role, `cd deploy/cdk && npm ci && npx cdk deploy
  --all --require-approval never`.
- The OIDC identity provider + the deploy role itself are **provisioned
  separately** (a human, scoped to the `Gede-*` stacks — issue 029) and the
  role ARN goes in the `AWS_DEPLOY_ROLE_ARN` repository secret.
