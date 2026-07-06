# 041: CDK hosting snapshot is environment-sensitive (local `dist/` breaks CI)

## Slice

Test-infra hardening for `deploy/cdk`. Make the hosting-stack snapshot test
deterministic regardless of whether a built `dist/` exists in the working tree,
so `jest -u` can never bake a machine-specific asset hash into a committed
snapshot.

## Motivation

`hosting-stack.ts` publishes the site with:

```ts
const repoDistPath = path.resolve(__dirname, '..', '..', '..', 'dist');
const siteSourcePath = fs.existsSync(repoDistPath) ? repoDistPath : placeholderPath;
new s3deploy.BucketDeployment(this, 'DeploySite', { sources: [s3deploy.Source.asset(siteSourcePath)], ... });
```

`BucketDeployment` hashes whatever `siteSourcePath` points at, and that hash
lands in the CloudFormation template — and therefore in
`test/__snapshots__/hosting-stack.test.ts.snap`. The source is chosen at synth
time from the **ambient filesystem**:

- **CI** (`cdk-validate`) synths *without* building the web app → uses the
  committed placeholder → hash `a334b47b…`.
- **A contributor** who has run `npm run build` has a real `dist/` → uses it →
  a different, content-dependent hash (`7fa063c8…`, etc.).

So anyone who runs `npm test -- -u` after a build silently rewrites the snapshot
with a local-only hash. It passes on their machine and **fails `cdk-validate` in
CI** with an opaque snapshot diff — exactly what happened on PR #2
(`fix/hosting-cache-control`), which had to regenerate the snapshot with `dist/`
moved aside. The test asserts an artifact of the *tester's environment*, not of
the code.

## Scope

- Decouple the snapshot from the ambient `dist/`. Preferred: make the site
  source **injectable** — add an optional `siteSourcePath`/`siteSource` prop to
  `HostingStack` (defaulting to the current `dist`-or-placeholder resolution),
  and have the tests pass the committed placeholder explicitly so synth output
  is identical on every machine and in CI.
- Defense-in-depth (optional, additive): register a jest snapshot serializer
  (or `Template` post-processing) that normalizes S3 asset hashes
  (`[0-9a-f]{64}\.zip`, `S3Key`, `AssetParameters*`) to a stable token, so *no*
  CDK asset hash can ever make a snapshot machine-dependent again.
- Do **not** change deploy behavior: production (`deploy.yml`) still builds the
  real app and publishes the real `dist/`; this only pins the *test* input.

## Design brief

A snapshot test should fail only when the code changes. Today it also fails on
"did the person who last touched it have a `dist/`?" — a trap with no signpost.
The fix is to remove the ambient input from the test path (inject the source),
keeping the smart `dist`-or-placeholder fallback for the real CLI/CI deploy where
it belongs. The asset-hash serializer is belt-and-suspenders: even a future
construct that adds an asset stays deterministic under snapshot.

**References**: PR #2 (`fix/hosting-cache-control`) — where the trap surfaced and
was worked around by hand · issue 040 (the CDK app; `hosting-stack.ts`
`siteSourcePath` resolution) · `deploy/cdk/test/hosting-stack.test.ts`.

## Test-first plan

- [ ] Red: a test that synths `HostingStack` with `dist/` **present** and again
      with it **absent** and asserts the two templates are byte-identical
      (fails today because the asset hash differs).
- [ ] Green: inject the placeholder as the test's `siteSource`; both synth paths
      now match. Confirm `npm test` passes with a real `dist/` present in the
      tree (the current failure mode).
- [ ] If adding the serializer: a test asserting an asset `S3Key` is rendered as
      the normalized token in the snapshot.

## Acceptance criteria

- [ ] `npm test` in `deploy/cdk` passes identically whether or not a built
      `dist/` exists at repo root (no `-u` needed after `npm run build`).
- [ ] `cdk-validate` in CI and a local post-build run produce the same snapshot.
- [ ] Standing gates green: the CDK suite (`npm test`), `npx tsc --noEmit`,
      `npx eslint . --quiet` (deploy/cdk is excluded from root tooling — run its
      own).
- [ ] No change to production deploy output (`cdk synth` under CI still publishes
      the real `dist/`).

## Implementation notes

- Lowest-friction version is just the injectable prop + tests passing the
  placeholder; the serializer is optional but future-proofs every asset-bearing
  construct (e.g. the `BucketDeployment` custom-resource Lambda already emits
  handler-code hashes that are deterministic today but are the same class of
  risk).
- Watch the other suites: `tags.test.ts` and any app-level snapshot that
  includes the hosting stack must be regenerated in the `dist`-absent state too.
