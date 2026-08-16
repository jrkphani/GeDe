# HANDOFF — 2026-08-16 (deploy pipeline UNFROZEN; 7 PRs fixed + merged + deployed; live-verified. OPEN: 099-touch [manual] + 2 new infra follow-ups)

**Session under owner directives "find my AWS credentials" → "merge and deploy the open PRs" → "get all of the PRs fixed merged and deployed."** Not feature work: this was a **release-engineering unblock**. Four agent-authored feature PRs (`#14`–`#17`) were open and all red. Fixing them surfaced that **`main` itself had been red since 2026-07-23 and the deploy pipeline had been silently FROZEN for three weeks** — every `deploy` run showed `skipped` because `verify` never went green on `main`.

Three CI failures were stacked, **each masking the next**: the esbuild bundling break hid `main`'s rotted CDK tests, which in turn hid the α1 e2e flake. Every open PR was already red for an unrelated reason, so nobody looked.

Ended with **7 PRs merged, all deployed, and the live app functionally verified** (project-create round-trip on the real CloudFront build).

---

## Current state

HEAD: **`56ece1b`**. Working tree clean, **0 open PRs**. `main` is green and the pipeline deploys again — the final run went `OIDC → npm run build → cdk deploy: success`, with the migration runner `UPDATE_COMPLETE` applying `0018_editable_table_metadata.sql` to the RDS.

**Deployed and live-verified** at https://d1nzod71m3rz6x.cloudfront.net — HTTP 200, `[data-db-ready="true"]`, and a real write path exercised end-to-end (created a project, it persisted and listed). The only console errors are `401 missing_token` on `/sync/v1/shape`: sync requires auth and the smoke session is signed out. **Expected, not a regression** — but note the status bar still reads "Syncing…" in that state, which is misleading (see backlog).

**AWS**: profile `phani-quadnomics`, account `975049998516`, `us-east-1`, IAM user (long-lived key, not SSO). Wired at `.mcp.json:10` and `deploy/cdk/README.md:50`.

### What shipped THIS session — 7 PRs, all CI-green + deployed

Merge order matters below; several PRs only became mergeable once an earlier one landed.

- **`#18` — unblock `cdk-validate` (`a245ce3`).** THE keystone fix; every other PR was blocked behind it.
  - **esbuild never resolved.** `MigrationRunnerFunction` pins `depsLockFilePath` to the **repo-root** lock file (its handler needs the root's `pg`/`@aws-sdk/*`), which makes `NodejsFunction` run the esbuild bundling command with `cwd` = repo root. CI only ran `npm ci` inside `deploy/cdk`, so `npx --no-install esbuild` aborted: `npx canceled due to missing packages… ["esbuild@0.28.2"]`. The `deploy/cdk` devDependency (issue 043) only covers bundling that runs *from* `deploy/cdk`, which this construct deliberately does not. Fix: `npm ci` at the root too, cache both lock files.
  - **`main` was already red underneath.** `47904f6` added `0017_canvases.sql` without updating dependents. Derived the migration expectations from disk instead of the hardcoded `17` (it had already been hand-bumped for `0016`), and refreshed the ApiStack snapshot.
  - **Serial e2e lane.** `d3-canvas` (32 tests) + `architecture` (29) are ~60% of the suite and each test boots a canvas with its own PGlite store; run concurrently on a 2-worker runner they spiked peak load. Split into a `canvas-serial` project at `--workers=1`, other 23 spec files parallel in `app`. Coverage verified disjoint + complete: 64 + 52 = **116 across 25 files**, matching the prior single-lane run exactly.
- **`#16` — unify Foundation table UX (`1d9f7f4`).** Needed no fixes; was only ever blocked by `#18`. Replaced the per-value-prop `foundationItem` canvas nodes with ONE unified table (`FoundationValueTable`, shared by the fallback route and the canvas), deleting `FoundationPropPanel`. **This is the source of the semantic conflicts below.**
- **`#19` — stop snapshotting bundled-Lambda asset hashes (`026c322`).** A Lambda asset key is `<sha256-of-bundle>.zip` — build output, not template structure — so `#14`/`#15` failed a snapshot neither had reason to touch. Per-PR refresh does **not** fix it: two PRs each touching bundled source produce two hashes, so whichever merges SECOND carries a snapshot computed before the first landed and `main` goes red immediately. Jest `snapshotSerializer` normalizes them. ⚠️ **See backlog — this duplicated a helper that already existed.**
- **`#17` — fluid, user-owned canvas navigation (`6237f62`).** Numbers/Excel camera grammar (`panOnScroll` + `PanOnScrollMode.Free` + `zoomActivationKeyCode:['Meta','Control']`), `autoPan*` all off, `onGapComposed`/`focusPanTarget`/`workspaceFocusPan.ts` deleted — composing/focus never move the viewport. Its 3 spec failures are patterns worth keeping (below).
- **`#14` — harden Design dimension workflows (`17d4c42`).** Its strict-mode violation was the SYMPTOM of a **real a11y defect**: in `belowFloor`/`needsSeeding` the toolbar hint repeated what a dedicated hint above it already said, in different words, in a second `role="status"` region — AT announced each instruction twice. Fixed by dropping the toolbar hint in exactly those states. Narrowing the locator would have hidden it.
- **`#20` — α1 child-core CI headroom (`d8678cb`).** See flake section.
- **`#15` — editable table headers + rich Name formatting (`56ece1b`).** Biggest integration. Adds `0018_editable_table_metadata.sql`, `nameRichText`/`*Header` columns, and converts Name cells to `kind:'richtext'`. Three distinct fixes: (1) **10 stale locators** — `input:focus` can never resolve against a Lexical contenteditable (8 in `architecture.spec.ts` via a `focusedNameEditor` helper + `toHaveText` not `toHaveValue`; 2 more in `d3-canvas.spec.ts` for the canvas Foundation node, found only after the first CI round); (2) a **real affordance bug** — the richtext editor hardcoded `⌘⏎` chips, but Architecture sets `richTextTabAdvances` so **Tab** is what actually advances there; before rich Name this never diverged because the only richtext cell on that surface was the description. Fixed in the component, since the spec's `Tab/→/Esc` expectation was correct all along; (3) the **last** hardcoded migration count (`MigrationFileCount).toBe(18)` in `migration-stack.test.ts`) — `#18` removed the twin in `migration-runner.test.ts` but missed this file.

---

## Backlog (OPEN)

- **`099` remainder — MANUAL-ONLY (real-device multi-touch pinch-zoom).** Unchanged. Everything automatable is done; emulated single-finger touch is banked as `test.fixme`. Needs a physical tablet: two tracked contacts + platform gesture recognition, plus tactile fidelity (momentum, palm rejection).
- **🆕 Consolidate the TWO asset-hash normalizers (self-inflicted, worth cleaning).** `deploy/cdk/test/normalize-asset-hashes.ts` **already existed** (from `56055e4`, issue 041) and is **strictly better** than `#19`'s serializer — it replaces any 64-hex run anywhere (S3 keys, logical IDs), not just `<hash>.zip`. It simply had not been applied to `api-stack.test.ts` (only `hosting-stack` + `migration-stack` used it). The correct fix for `#19` was one import line per un-covered snapshot test. There are now two overlapping mechanisms on `main`; they don't conflict, but pick one — preferably the older, broader helper — and delete the other. **Lesson: grep for an existing seam before adding a parallel one.**
- **🆕 CDK tests leak `cdk.out*` into `$TMPDIR` — ~62 MB per `synth()`, never cleaned.** A full `npm test` in `deploy/cdk` leaks **>10 GB**; 276 stale dirs had accumulated and filled the machine's disk mid-session (this is what caused the ENOSPC, not Xcode/Docker). Workaround used: run per-file with `rm -rf "$TMPDIR"/cdk.out*` between. Real fix: have `synth()` write to a temp dir it cleans up, or add an `afterAll` sweep.
- **🆕 Minor UX: the status bar reads "Syncing…" while signed out**, when sync is in fact 401-ing on every shape request. Either surface "Sign in to sync" or suppress the indicator when unauthenticated.
- **Small e2e-infra follow-up (to un-bank the touch specs):** the `canvas-serial` lane from `#18` is the mechanism the prior handoff wanted — the 3 `test.fixme` emulated-touch specs could likely be un-banked into their own lane now.
- **Minor tracked follow-ups (non-issues):** `107` — `projectIO.ts:34` could import the shared `Tx` instead of re-deriving it. `106` — shallow grandchild breadcrumb; no WorkspaceCanvas render-path unit harness.

---

## Patterns (this run — reuse)

### CI / release
- **A gate that fails for reasons unrelated to the change is worse than no gate — it hides real breakage.** Three failures stacked here, each masking the next, for three weeks. When a PR is red, check whether `main` is red the same way BEFORE debugging the PR.
- **`deploy` runs showing `skipped` on `main` = the pipeline is frozen, not idle.** `deploy` is `workflow_run`-gated on `verify` succeeding on `main`; a red `verify` silently means no deploys. Check `gh run list --workflow=deploy.yml` and look for `event=workflow_run` + `conclusion=success`, not just "recent runs exist."
- **Never hardcode a count that a routine change bumps.** Migration counts were hand-bumped for `0016`, then `0017`, then `0018`, across TWO files, breaking unrelated PRs each time. Derive from disk + a non-empty guard so a bad path can't vacuously pass.
- **Don't snapshot build output.** Asset hashes change with any handler edit. Worse, they make concurrent PRs mutually un-mergeable (second-to-merge carries a stale snapshot). Normalize them; snapshot the structure.
- **A CDK snapshot diff of ONLY asset hashes is safe to refresh; a diff touching resources/IAM/wiring is not.** Always read the diff before `-u`.

### e2e
- **"Flaky" is a claim to verify, not accept.** `#17`'s two drag specs were reported `flaky` (a retry sometimes won) but failed **deterministically at `--workers=1` with zero contention** — a real race. Reproduce locally serialized before believing the label.
- **Animated Fit races drags.** The `*Stack` helpers poll NODE transforms (flow coords), which hold steady while the CAMERA is still animating — so they report stable mid-animation and a subsequent drag computes screen coords against a shifting viewport, dropping the node in the wrong slot. Use `waitForStableViewport` (its contract is literally "an EXPLICIT Fit has settled") **in addition to** the node-stability helpers.
- **When a cell's editor kind changes, every `input:focus` locator against it dies silently.** `kind:'richtext'` → a Lexical contenteditable: use `[contenteditable="true"]:focus` and `toHaveText`, never `toHaveValue`. Grep the WHOLE `e2e/` tree — `#15`'s second CI round found 2 more sites in a spec file I'd already considered done.
- **A strict-mode violation is often a real defect, not a locator problem.** `#14`'s duplicate-match was two live regions announcing the same thing. Fix the duplication; narrowing the locator hides it.
- **Camera-grammar changes invalidate wheel-based specs.** Under `panOnScroll`, a plain `mouse.wheel` PANS; zooming needs `keyboard.down('Control')` around it. A poll waiting on a scale threshold will otherwise spin forever.

### The 100-D α1 flake — SUPERSEDED GUIDANCE
The prior handoff said the deterministic mount-wait (`7bc9f46`) was "the REAL fix, not reruns." **That was necessary but NOT sufficient.** This session the same spec again lost all 3 retries on two separate `main` commits containing **no product code** (the `#19` merge was CDK test files only), blocking the deploy each time — and it did so **from inside the `canvas-serial` lane at `--workers=1`**, which rules out cross-file contention and leaves plain CPU starvation on the runner.

So `#20` raised the ceiling: **α1 assertion 30s → 90s, per-test budget → 180s, CI only** (the config's 60s cap would otherwise kill the test before the longer assertion could settle). Local timings untouched, so a genuine hang still surfaces fast in dev. The assertion still fails a REAL regression — α1 never arriving at all — it just stops reading a slow runner as one. Locally the whole spec runs in **~8s**; the 8s-vs->30s gap IS the diagnosis.

### Merging concurrent agent PRs
- **Expect SEMANTIC conflicts, not just textual ones.** `#16` deleted `FoundationPropPanel` and moved the value-prop grid into a new sub-component; git saw delete-vs-add. `#15`'s and `#17`'s work had to be **ported onto the new shape**, not merely merged — take the restructure wholesale, then re-apply the other branch's feature in its new location, and re-verify.
- When both sides add a new `describe`/column at the same spot, **keep both** — don't let one side win by default.
- ⚠️ **`git checkout --theirs <file>` during a merge discards ALL of your side's changes to that file, not just the conflicted hunk.** It clobbered an already-correct resolution here. Recover with `git checkout --merge <file>` to regenerate the markers, then redo.

---

## Non-negotiables & tooling
- **Deploy = push to `main`** → CI `verify` (tsc+lint+stylelint+vitest+full e2e; now TWO e2e lanes: `e2e:canvas` serial then `e2e:app`) → `deploy` via `workflow_run`. Watch with `gh pr checks <n> --watch` / `gh run watch <id> --exit-status` in background.
- **Disk**: the CDK suite leaks GBs into `$TMPDIR` (above). Sweep `rm -rf "$TMPDIR"/cdk.out*` after CDK runs — this filled the disk mid-session and blocked all local verification.
- **Memory**: prior run's ceiling still applies — serialize local Playwright; CI's full e2e is the authoritative gate.
- **eslint:** no `!`, `interface` over `type`, 0 errors (tolerated pre-existing warnings: `EditableGrid.tsx:1276`, `Canvas.tsx:178`, some server albAdapters). **Bundle:** `xyflow` OUT of main `index-*.js`. **Schema only via migrations** — `#15` correctly added `0018`.
- **MANDATORY adversarial review** for any store/render/write-path touch. **Screenshot** user-facing changes. CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) = authoritative write-path check.

## Definition of done / next
All 7 PRs (`#14`–`#20`) are **merged and DEPLOYED**; `main` = `56ece1b`, clean, 0 open PRs. The three-week deploy freeze is over and the pipeline is verified working end-to-end, including a migration application and a live functional smoke test. **No feature work is mid-flight.**

Actionable backlog is small and infra-only: consolidate the duplicate asset-hash normalizers, fix the `cdk.out` `$TMPDIR` leak, and the "Syncing…"-while-signed-out label. `099`'s real-device pinch pass remains the only product-side open item and is not automatable. Next session: await direction / new work.

---

*History (archived to `docs/issues/done/`): 084; 087–098; 089 (D1/D2/D3-graduation); 100; 101/102/103; 104; 105; 106; 107; 088. PRs this run: #14 #15 #16 #17 #18 #19 #20. OPEN: 099 (real-device multi-touch pinch — MANUAL) + 3 infra follow-ups. Updated 2026-08-16.*
