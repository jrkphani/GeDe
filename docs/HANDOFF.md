# HANDOFF — 2026-07-20 (session 5 close)

**089 D3-canvas graduation: P0·P1·P2·093·P3·P4·P5 SHIPPED + DEPLOYED. NEXT = P6 (deploy-gate transition), then P7 (default-flip). Both change/arm PROD behavior — START A FRESH SESSION.**

Launch prompt: `docs/NEXT-ORCHESTRATOR.md`. Authoritative phased spec: `docs/issues/089-unified-canvas-workspace.md → ## D3 GRADUATION — APPROVED BUILD PLAN` (P0–P5 + 093 marked SHIPPED with lessons; you start at **P6**).

---

## Current state

Live: HEAD **`2cd308f`** deployed (CI green — `verify` + `dev-canvas-e2e` + `deploy`). Confirm at https://d1nzod71m3rz6x.cloudfront.net. ALL canvas work is behind the dev-only `?d3rf` flag → folds to `false` in prod (`import.meta.env.DEV` gate): **no prod behavior change yet — the flip is P7.** PROD-FOLD holds (xyflow only in the lazy `WorkspaceCanvas-*.js` chunk, never the main bundle). Flag-off `WorkspaceSurface`/`DesignSurface` are UNTOUCHED (mutually-exclusive path → zero flag-off risk).

Shipped (all on `main`, CI-green, each red-first + adversarially reviewed):
- **P0** `74ae9a2` · **P1** `d2f7fe7` · **P2** `e0cc006` · **093** `dd8902b` — flag persistence; Foundation lane → per-item nodes (reorders by **rank**); Design lane → `designRegister` over `designRing` (`canvasCompose.ts` + `DesignCoreAdapter.tsx`); register extend-right + LOD collapse.
- **P3** `da87e86` — recursion (011) as edge-connected satellites: **FIRST React Flow edges** + NEW `src/domain/clusterLayout.ts` (pure; dagre deferred) + `src/store/canvasSatellites.ts`. Drill "Open ▸" → SUMMARY-STUB satellite + parent→child edge; pan-to-child; collapse-unmount; Enter▸ deep-links. Review HIGH fixed (satellites clear the register's MEASURED width). **⚠ Tracked follow-up in the 089 issue: promote the stub → a live child {register+ring} core (needs a per-canvas store factory — the singleton `contexts` store blocks two live cores).**
- **P4** `4917219` — coverage (012) as a FULLY-LIVE edge-connected twin: NEW `src/store/canvasCoverage.ts` (boolean slice); `v`/header toggle open a `coverageTwin` node (design-lane sort 2, edge ring→twin); ring + coverage coexist; gap-click composes pre-filled + pans back; `?view=coverage` seeds it; `routes.ts` untouched. Review MEDIUM fixed.
- **P5** `4ee3033` — lane LOD summary cards (`.wc-lane-summary` below `LANE_LOD_ZOOM` 0.35, **edit-safe** via a focus-**ref** `useLaneLod` hook) + register width-cap (`max-width:1600px` + inner-scroll) + a 20×50 volume e2e. `onlyRenderVisibleElements` + `content-visibility` evaluated & rejected. Review fixed 3 HIGH edit-awareness gaps; 093's >8-col collapse + focus-expand SUPERSEDED by the width-cap.

The `?d3rf` `d3-canvas.spec.ts` suite is now **22 `@dev-flag` tests (+1 `test.fixme`)**, all green in the non-gating `dev-canvas-e2e.yml` CI job.

## NEXT — P6 → P7 (SEQUENTIAL, ≤5 files, red-first; both funnel through `WorkspaceCanvas.tsx`)

**P6 — deploy-gate transition (the careful one — do NOT freeze deploys). ← START HERE.** Banked map (investigated 2026-07-19):
- **Only ONE `test.fixme` remains** — the focus-pan spec `e2e/d3-canvas.spec.ts:375` (the popover-anchor one is already de-flaked → live at `:202` via `reducedMotion:'reduce'` + `waitForStableViewport` + geometry `expect.poll` — the de-flake TEMPLATE). The focus-pan fixme's in-file note (`:355-374`) PROVES it can't be fixed black-box (reduced-motion `setCenter(duration:0)` no-ops on idle zoom; a byte-identical post-`useNodesInitialized` `fitView` at `WorkspaceCanvas.tsx:1115` races + clobbers the pan). **Fix = app-side (make `onFocusCapture` await the measurement fit / expose a settled signal) OR convert to a UNIT test of `onFocusCapture`'s pan logic (`WorkspaceCanvas.tsx:1169-1192`) + delete the e2e** (lowest-risk un-quarantine).
- **Flakiness surface:** 20 of 22 specs run under NORMAL (animated) motion (every ⌘1/2/3 + focus pan animates `FOCUS_PAN_DURATION`/`LANE_JUMP_DURATION`); their `expect.poll`s converge but are the likely new gate-flakers. Consider `reducedMotion:'reduce'` project-wide (playwright `use:`) — BUT re-verify the flag-off suite (some may assert animation). Watch the wheel-zoom loop (`:1267`).
- **Un-tag mechanics:** delete `, { tag: '@dev-flag' }` from all **22** `test(...)` calls (change `:375` `test.fixme(`→`test(`); `package.json:14` `"e2e": "playwright test --grep-invert @dev-flag"` → `"playwright test"`, drop `:15` `e2e:dev-flag`; delete `.github/workflows/dev-canvas-e2e.yml`; refresh the `:3-13` DEPLOY-GATE CONTRACT comment. The bundle guard is the VITEST unit test `src/components/d3CanvasNav.guard.test.ts` (xyflow reachable ONLY via dynamic import) — **leave it as-is at P6** (RF still folds; it inverts at P7).
- **Risk-ordering (do NOT skip):** (1) de-flake focus-pan while STILL `@dev-flag`; (2) prove the full 22-spec suite green across N (20–50) CONSECUTIVE `npm run e2e:dev-flag` runs; (3) ONLY THEN drop `--grep-invert` + the tags. **One-line rollback if `verify` flakes + threatens to freeze prod:** re-add `--grep-invert @dev-flag` to `package.json:14` — instantly re-excludes the canvas specs, unblocks deploys. Keeping the `@dev-flag` tags even post-graduation keeps that rollback a one-liner.

**P7 — THE DEFAULT-FLIP (LAST, the one reversing step) + SITEMAP/085 lockstep in the SAME PR. HIGHEST prod risk — MANDATORY adversarial review.**
- `src/App.tsx` `d3CanvasEnabled()` → a capability check (default ON: desktop/tablet width + not reduced-data), no longer `import.meta.env.DEV && ?d3rf`; canvas is primary for `project`/`tier`/`design`; `WorkspaceSurface` is the < 1024px fallback. `src/store/canvasMode.ts` seeds from capability.
- **RF now SHIPS to prod → invert `d3CanvasNav.guard.test.ts` + `vite.config.ts:23-30` `globIgnores` into a bundle-size BUDGET CEILING** (RF ~88 KB).
- ~50+ non-`@dev-flag` specs assume the `WorkspaceSurface` DOM (native scroll, `.workspace__lane--*`) — run the FULL suite against the canvas in a branch first to enumerate breakage (D2 P5 Rule-12 sweep is the template); narrow-viewport specs pin `WorkspaceSurface`. **SITEMAP §1/§2/§3/§4 + the `done/085-*` supersession note land in the SAME PR** (SITEMAP §6) — precise edits are in the 089 issue `### SITEMAP + 085 lockstep edits` subsection. Adversarially review the flip + all doc edits.

## Patterns (reuse for P6/P7)

- **Derived positions only.** Every node's `{x,y}` = `computeLaneLayout(tier, sort, measured-height)`; node WIDTH never feeds the x-stride. Constrained drag pins x to the lane column + calls the store reorder (sort/rank) — never persists `{x,y}`.
- **Cross-tree shared state → a Zustand store** (separate RF nodes can't share React state): `canvasCompose`, `canvasSatellites`, `canvasCoverage`, `canvasMode`.
- **Stable-id nodes never unmount** → re-home every per-navigation reset to an effect keyed on `canvasSelector`/`canvasIdentity` (P2 `hoveredMark` lesson; P3 satellite reset; P4 twin seed).
- **Zoom inside a node body:** RF `useStore((s) => s.transform[2] < THRESHOLD)` — a BOOLEAN selector, re-renders only on threshold crossing (perf-safe), no `onMove`, never through the reconcile/`measuredSignature` hot path.
- **Beside-the-core geometry keys off the WIDEST MEASURED design-column node** (register/ring/twin share the Design column; 093 uncapped the register, P4's twin can be wider) — feed `node.measured.width` into the placement + track width in the re-derive signature. Derive edges from the RECONCILED `nodes`, not the store (never target a node RF doesn't have yet).
- **A zoom-driven LOD swap of an editable surface must be EDIT-AWARE** — track focus in a **ref** (not state, which re-renders mid-click and cancels EditableGrid's click-to-edit); read it at the `useStore` threshold render so an actively-edited node stays expanded (grid never unmounts → no dropped keystrokes). **DOM `.contains()` focus checks are unreliable against PORTALLED popovers** (Radix combobox) — prefer a stable store flag (compose) / `:focus-within` / a width-cap over focus-expand.
- **Test focus-race:** after a create, an `onXCreated` rAF×2 focus can steal focus — `await waitForStableViewport(page)` before the next e2e step.

## Non-negotiables & tooling

- **Deploy = push to `main`** → CI `verify` (typecheck + lint + stylelint + vitest + Playwright e2e, `@dev-flag`-excluded) → `deploy.yml` via `workflow_run` on verify-success. Watch with `gh run list --json` (`gh run watch` is flaky). If a deploy is skipped, check whether `verify` is red-streaking.
- **STALE-VITE:** before every e2e re-run, `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` (else HMR serves stale code).
- **PROD-FOLD** (until P7): after any App-gate / `canvasMode` / lazy-import change, prod-build + grep that `xyflow` stays OUT of the main bundle. **Inverts at P7** (RF ships → budget ceiling).
- **TEST EVERY route on the canvas** (`/foundation?d3rf`, `/architecture?d3rf`, `/design?d3rf` + navigate) — watch for "Maximum update depth" tier-route latent bugs.
- **≤3 concurrent subagents**; commit `--no-verify` after running verify yourself + explicit `git add`; worktree-isolate overlapping subagents; never let two edit the same file on `main`.
- **Adversarially review** every hot-path / store / write-path change (every phase's review this build caught real bugs) — **MANDATORY for P7's default-flip + the SITEMAP/085 edits.** **Screenshot** every user-facing change (the canvas becomes user-facing at P7). **Schema only via migrations** (089 is frontend-only; reuses existing stores/mutations).
- **Live creds** (owner provides the password at launch — **never commit**): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD='<from owner>'`; rotate after. ⚠️ A prior password is in git history (public repo) — treat as compromised. The SW hides `/write` from Playwright → **CloudWatch** (`/aws/lambda/Gede-Test-Api-WriteApiFunction5106E371-2PvLQCdOFbzl`, AWS MCP read-only, profile `phani-quadnomics`, account `975049998516`) is the authoritative write-path live check (successful writes log nothing — verify by absence-of-error). P3–P5 added no write path (P4 reuses `enterCompose` verbatim), so no live-smoke was needed; P7 makes the canvas user-facing → screenshot + a live-smoke of a real write are worth doing.

## Definition of done

089 graduated (canvas is default; the 011/012 cluster built — P3–P7 shipped + SITEMAP/085 updated) + live-verified + archived to `docs/issues/done/`; the P3 stub→live-core follow-up either shipped or filed as its own issue; then re-triage `docs/issues/README.md` until open-issue count is **0**. Surface a genuinely NEW owner-fork via `AskUserQuestion`; else build autonomously (all 089/093 forks are answered).

---

*History (shipped + archived to `docs/issues/done/`, or superseded): 084 Direction-3 grid unification; 087/088/090/091/092/094/095/096/097/098; 089-D1/D2. This HANDOFF was compressed 2026-07-20 to keep only the live P6→P7 thread; the full P0–P5 detail + lessons live in the 089 issue doc + git log.*
