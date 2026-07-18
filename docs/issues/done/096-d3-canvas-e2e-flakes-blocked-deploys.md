# 096: flaky `d3-canvas.spec.ts` viewport tests silently blocked EVERY deploy for ~8 commits

- **Status**: DONE (pending commit + CI observation, 2026-07-18) — pipeline unblocked; popover test **hardened + re-enabled** (33/33 green); focus-pan test **stays quarantined** (proven non-deterministic, app-side root cause documented); **structural deploy-gate guard implemented** (`@dev-flag` tag + `--grep-invert` + non-gating `dev-canvas-e2e.yml`). Discovered while shipping the 095 fix.
- **Milestone**: CI/deploy reliability + 089-D3 test hardening.
- **Severity**: **High (process)** — real prod fixes could not deploy. No prod code was wrong; the *pipeline* was stuck.

## What happened

`deploy.yml` runs only on `verify` completing **successfully** on `main` (`workflow_run`, `conclusion == 'success'`). Since **`226daa9`** (089-D3 P3.2/P3.3, ~2026-07-18 03:20, which ADDED the d3-canvas e2e), **every `verify` run on `main` failed** → **`deploy` was skipped for ~8 consecutive commits** (`226daa9 → 8dbde07 → 4c7f205 → 087ba46 → dee2ce0 → 2ff0af8 → 7336296 → 518a00c`). The prior session's notes/memory say "Deployed P3.2/P3.3" — it was **pushed, not deployed**. The live build stayed at the last green deploy (pre-226daa9); everything since (D3 P3.4, and the 095 write-path fix) never reached prod. Because the un-deployed work is either `?d3rf`-gated (dead in prod) or (095) a server fix, the live *app* was unaffected — which is exactly why the silent breakage went unnoticed.

## The two culprits (both `?d3rf` dev-flag-only, both viewport-transform-sensitive)

- `d3-canvas.spec.ts:156` "promote popover anchors at its trigger at viewport scale ≠ 1" — the Radix popover anchor lands ~200px off under headless CI (passes locally + on re-run → **flaky**).
- `d3-canvas.spec.ts:286` "focusing a cell in an off-screen lane pans it into view" — React Flow's animated `setCenter` doesn't land the node inside the pane within the poll window under CI (**deterministic 2/2 in CI**, flaky locally).

Neither is a prod bug — both features were verified when shipped; the D3 canvas isn't user-facing. The tests are CI-rendering/timing-fragile.

## Fix (2026-07-18) — all three follow-ups landed

### 1. Harden + re-enable — DONE (popover) / stays quarantined (focus-pan)

- **156 popover ("promote popover anchors at its trigger at viewport scale ≠ 1") — HARDENED + RE-ENABLED.** Real root cause: clicking the "Use as dimension…" trigger focuses it → fires the canvas focus-pan (`onFocusCapture → setCenter`), which under normal motion ANIMATES, sliding the trigger out from under Radix's already-taken popover measurement → anchor lands on the stale pre-pan rect (~200px off). Fix: `page.emulateMedia({ reducedMotion: 'reduce' })` (app honors `prefersReducedMotion()` → every pan snaps to `duration: 0`) + assert the zoom-invariant anchor relationship via `expect.poll` (relative offset, not absolute px) + a `waitForStableViewport` settle. **Proven deterministic: 33/33 green** across repeated `--repeat-each` runs under `CI=1`, `--workers=1`.
- **286 focus-pan ("focusing a cell in an off-screen lane pans it into view") — COULD NOT be made deterministic; stays `test.fixme`.** The focus-pan `setCenter` is only reliable on a "warm" viewport (right after another move) and races a **one-time post-measurement `fitView`** (rAF once `useNodesInitialized` flips). Reduced-motion lifts it to ~11/12, but `setCenter(duration 0)` no-ops when the zoom is idle, so any settle wait before the focus drops it to 0/N; the one-time fit's result transform is byte-identical to the initial fit (can't be waited out by watching the transform) and clobbers the node back off-screen when it lands after the pan. ~92% is not good enough — one flake re-freezes the pipeline. **Best real fix is app-side**: have `onFocusCapture` await the measurement fit (or expose a settled signal) so the pan isn't racing it; or cover the invariant with a unit test of `onFocusCapture` instead of e2e. Full investigation is in the `test.fixme` header comment in the spec.

### 2. Structural deploy-gate guard — IMPLEMENTED (tag + grep-invert + non-gating job)

Every test in `e2e/d3-canvas.spec.ts` is tagged **`@dev-flag`** (the whole file is `?d3rf`/dead-in-prod). The deploy-gating run now excludes them and a separate non-gating job runs them for visibility — a flaky dev-canvas test can no longer freeze prod deploy:

- `package.json`: `"e2e": "playwright test --grep-invert @dev-flag"` (the deploy-gating run, via `verify`) + new `"e2e:dev-flag": "playwright test --grep @dev-flag"`.
- New **`.github/workflows/dev-canvas-e2e.yml`** — mirrors `verify.yml` setup, runs `npm run e2e:dev-flag`, on push-to-main + PR. Reports red if the dev-canvas suite breaks, but `deploy.yml` watches only `verify`, so it NEVER gates deploy. **`deploy.yml`'s gating logic is untouched** — this only reduces what the gating `verify` runs + adds a separate non-gating signal (strictly reduces freeze risk).
- Local verification: `--grep-invert @dev-flag --list` → 53 tests / 24 files, **zero d3-canvas**; `--grep @dev-flag --list` → 9 tests / 1 file (only d3-canvas); total 62 (53 + 9 — only d3-canvas moved out of the gate). `npm run e2e` (grep-invert) → **53 passed**, d3-canvas excluded.
- **GRADUATE → RETAG**: if `?d3rf` ever becomes a real user-facing feature, remove the `@dev-flag` tags (and the `--grep-invert` from `npm run e2e`) so these tests move back INTO the deploy-gating `verify`, and retire `dev-canvas-e2e.yml`. (Contract is also documented at the top of the spec + in the workflow header.)

### 3. Audit rest of `d3-canvas.spec.ts` — the whole file is now non-gating (moot for deploy-freeze)

Since every test is `@dev-flag` and out of the gate, residual viewport-timing fragility in the other d3-canvas tests can no longer freeze deploys; they run in the visibility job only.

## References
`.github/workflows/deploy.yml` (workflow_run gate on verify — untouched), `.github/workflows/verify.yml` (runs `npm run verify` → `npm run e2e` = grep-invert `@dev-flag`), `.github/workflows/dev-canvas-e2e.yml` (NEW — non-gating `@dev-flag` visibility run), `e2e/d3-canvas.spec.ts` (all tests tagged `@dev-flag`; popover re-enabled, focus-pan `test.fixme`), `package.json` (`e2e` / `e2e:dev-flag` scripts), `src/components/WorkspaceCanvas.tsx` / `d3CanvasNav.ts` (focus-pan `setCenter` — app-side root cause) · surfaced while deploying `095`.
