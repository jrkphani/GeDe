# HANDOFF — 2026-07-19 (session 5)

**089 D3-canvas graduation: P0·P1·P2·093·P3·P4 SHIPPED — edges, recursion satellites, and the coverage twin are in. NEXT = P5 (LOD + perf at volume).**

Open issues: **089** (graduation build, P3→P7 remain) + nothing else blocking. Launch prompt for the next agent: `docs/NEXT-ORCHESTRATOR.md`. Authoritative phased spec: `docs/issues/089-unified-canvas-workspace.md → ## D3 GRADUATION — APPROVED BUILD PLAN` (P0/P1/P2/093 bullets are marked SHIPPED with lessons).

---

## Current state

**Live build: deploy of `d19906f` (P1+P2+093) — confirm the latest hash at https://d1nzod71m3rz6x.cloudfront.net.** All canvas work is behind the dev-only `?d3rf` flag, which folds to `false` in prod (`import.meta.env.DEV` gate) — **no prod behavior change yet**; the flip is P7. Verified every phase: xyflow stays OUT of the main `index-*.js` bundle (only in the never-fetched lazy `WorkspaceCanvas-*.js` chunk).

Shipped this session (all on `main`, verify-green):
- **P0** (pre-session, `74ae9a2`) — `?d3rf` persists in a `canvasMode` store (survives `navigate()`); fixed a latent "Maximum update depth" loop on tier routes (stable `NO_CONTEXT_PATH`).
- **P1** (`d2f7fe7`) — Foundation lane → `foundationHeader` + one `foundationItem` per `tier1_props` (reorders by **rank**, not sort). NEW `src/components/FoundationCanvasNodes.tsx`.
- **P2** (`e0cc006`) — *the core-risk phase.* Design lane → `designRegister` (sort 0) over `designRing` (sort 1). NEW `src/store/canvasCompose.ts` (shared compose state — two node bodies are separate React trees) + NEW `src/components/DesignCoreAdapter.tsx`. Adversarial review caught 2 real bugs pre-ship (readOnly guard dropped from the coverage-gap compose path; `hoveredMark` not reset on nav → all-muted child canvas).
- **093** (`dd8902b`) — register extends right (canvas-only, no clip), "New context" button removed (phantom row is sole create), LOD tuple-summary collapse below 0.6 zoom (`ContextRegister.collapsed` prop via RF `useStore` boolean selector).

The flag-off surfaces (`FoundationSurface`, `DesignSurface`) are **UNTOUCHED** — the canvas adapters are a parallel, mutually-exclusive render path, so the flag-off route + its whole test suite are zero-risk.

## NEXT — P5 → P7 (each ≤5 files, red-first; funnel through `WorkspaceCanvas.tsx` so they are SEQUENTIAL)

- **P3 — ✅ SHIPPED (`da87e86`).** Recursion (011) as edge-connected satellites: FIRST React Flow edges + NEW `clusterLayout.ts` (pure; dagre deferred) + NEW `canvasSatellites.ts`. Drill "Open ▸" opens a SUMMARY-STUB satellite (+ deferred follow-up tracked in the 089 issue: promote stub → live child core). Review fixed a HIGH (satellites clear the register's MEASURED width — 093 uncapped it).
- **P4 — ✅ SHIPPED (`4917219`).** Coverage (012) as a FULLY-LIVE edge-connected twin: NEW `canvasCoverage.ts` boolean slice; `v`/header toggle open a `coverageTwin` node below the ring (design-lane sort 2, edge ring→twin), ring+coverage coexist; gap-click composes pre-filled + pans back; `?view=coverage` seeds the twin; `routes.ts` untouched. Review fixed a MEDIUM (satellites clear the WIDEST design-column node, incl. the twin).
- **P5 — LOD + lazy-mount + perf at volume. ← START HERE.** Lane-summary LOD (real grid only near 1:1; summary card zoomed out; virtualize by *lane*); lazy-mount clusters (collapsed deep child = single stub); coverage twin = headline stat + mini heat-strip zoomed out. Reuse 084's `.gede.json` 20×50 volume seed. **093's deferred bits land here:** register pixel width-cap + >8-col collapse + focus-expand. Gate: overview renders summary cards below the zoom threshold; volume import stays interactive (deep cell-open < 3s); no console errors. **Reuse the 093 `useStore` BOOLEAN-selector zoom pattern** (`DesignCoreAdapter.tsx` `registerCollapsed`) for LOD thresholds.
- **P5 — LOD + lazy-mount satellites + perf at volume.** Lane-summary LOD, `content-visibility`, reuse 084's `.gede.json` 20×50 volume seed. **093's deferred bits land here:** the register pixel width-cap + the >8-column collapse trigger + focus-expand.
- **P6 — deploy-gate transition (careful).** FIRST de-flake the 096 `test.fixme` specs + prove green across N runs while STILL `@dev-flag`; THEN drop the tags + `--grep-invert @dev-flag` (`package.json:14`) + retire `dev-canvas-e2e.yml`. Invert the RF zero-size bundle guard into a budget ceiling (RF now ships ~88 KB).
- **P7 — THE DEFAULT-FLIP (last, the reversing step) + SITEMAP/085 lockstep in the SAME PR.** `d3CanvasEnabled()` becomes a capability check (default ON desktop/tablet), canvas is primary, `WorkspaceSurface` is the < 1024px fallback. ~50+ non-`@dev-flag` specs assume the `WorkspaceSurface` DOM — run the full suite against the canvas in a branch first (D2 P5 Rule-12 sweep is the template). **Adversarially review this + the SITEMAP §1/§2/§3/§4 + 085 supersession edits.**

## Patterns established this session (reuse for P3–P7)

- **Adapter, don't gut.** Each lane decomposition is a NEW canvas-only adapter reusing the store-driven child components; leave the flag-off surface untouched (mutually-exclusive path → zero flag-off risk, tests stay green).
- **Derived positions only.** Every node's `{x,y}` = `computeLaneLayout(tier, sort, measured-height)`; node WIDTH never feeds the x-stride (`laneX` = tier index only), so a wider node (093) grows into empty canvas. Constrained drag pins x to the lane column + calls the store reorder (sort/rank) — never persists `{x,y}`.
- **Cross-tree shared state → a store.** Separate RF nodes can't share React state; use Zustand (compose → `canvasCompose`; selection → contexts store).
- **Stable-id nodes never unmount** → re-home every per-navigation reset the original did on unmount to an effect keyed on `canvasSelector`/`contextId` (the P2 `hoveredMark` lesson).
- **Zoom inside a node body:** RF `useStore((s) => s.transform[2] < THRESHOLD)` — a BOOLEAN selector re-renders only on threshold crossing (perf-safe), no `onMove` wiring.
- **Test focus-race:** after a create, an `onXCreated` rAF×2 focus can steal focus from the next interaction — `await waitForStableViewport(page)` before the next e2e step.
- **Beside-the-core geometry keys off the WIDEST MEASURED design-column node (P3+P4).** 093 made the register `width:max-content` (uncapped) and P4's coverage twin can be wider still, and all three (register/ring/twin) share the Design column — so satellites (right of the core) must clear the *max measured width* of every design-lane node, NOT the nominal 960px and NOT just the register. Feed `node.measured.width` into the placement + track width in the re-derive signature. Width feeds satellite/twin clearance only, never the lane x-stride (that stays tier-indexed). Derive edges from the RECONCILED `nodes`, not the store, so an edge never targets a node RF doesn't have yet.

## Banked investigation maps (P3/P4 — saves re-investigation)

- **P3 recursion:** drill-in centralizes on `handleDrillIn` (`navigate({contextPath:[...contextPath,id]})`) in `DesignCoreAdapter` (both bodies). `useContextsStore.openChildCanvas(parentContextId)` SEEDS/reconciles a child canvas + returns `StaleRebindEvent[]` (does NOT navigate); the child canvas is a real `canvases` row minted lazily by `db/mutations.ts childCanvasId`. Also `loadBreadcrumbs`, `revertStale`, `create`, `childCountByContext`. **PRESERVE the `routes.ts` contextPath grammar** (one path segment per context id after `/design`; `?canvas=` only at depth 0). Tests to mirror: `db/recursion.test.ts`, `store/recursion.test.ts`, `e2e/recursion.spec.ts`.
- **P4 coverage:** `CoverageMatrix.tsx` is already store-free + prop-driven (drops into a node body as-is); `domain/coverage.ts` + `domain/gridWindow.ts` are pure. The two `navigate()` call sites to convert to a twin open/collapse: the `v` handler in `DesignRegisterBody` + `handleComposeTuple` in `DesignRingBody` (the coverage ternary).

## Non-negotiables & tooling (carry forward)

- **Deploy = push to `main`** → CI `verify` (typecheck + lint + stylelint + vitest + Playwright e2e, `@dev-flag`-excluded) → `deploy.yml` via `workflow_run` on verify-success. **If a deploy is skipped, check whether `verify` is red-streaking.** Watch CI with `gh run list --json` (`gh run watch` is flaky here).
- **Keep the `?d3rf` `d3-canvas.spec.ts` tests `@dev-flag`** (excluded from the gating `verify`, run in the non-gating `dev-canvas-e2e.yml`) **until P6** graduates them — a dev-flag flake must never freeze prod deploy (issue 096).
- **STALE-VITE gotcha:** after editing any module, `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before an e2e re-run, or HMR serves stale code.
- **PROD-FOLD invariant:** after any App-gate / `canvasMode` / lazy-import change, prod-build + grep that `xyflow` stays OUT of the main bundle. This INVERTS at P7 (RF ships) — convert the zero-size guard into a budget ceiling then.
- **TEST EVERY route on the canvas** (`/foundation?d3rf`, `/architecture?d3rf`, `/design?d3rf` + navigate between) after any decomposition — watch for "Maximum update depth" tier-route latent bugs.
- **≤3 concurrent subagents**; commit `--no-verify` after running verify yourself + explicit `git add`; worktree-isolate overlapping subagents; **never let two subagents edit the same file on `main`** (lint-staged pre-commit stash silently drops one's edits).
- **Adversarially review** every store/write-path change (P2's review caught 2 real bugs) and MANDATORY for P7's default-flip. **Real-Postgres is authoritative** for write-path/SQL. **Schema only via migrations** (089 is frontend-only; the cluster reuses existing stores/mutations). **Screenshot** every user-facing change (the canvas becomes user-facing at P7).
- **Throwaway live creds** (owner-provides the password at launch — **never commit it**): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD='<from owner>'`; rotate after. Live URL above. ⚠️ **A prior password is in git history (public repo) — treat as compromised + rotate.** The SW hides `/write` from Playwright → **CloudWatch (`/aws/lambda/Gede-Test-Api-WriteApiFunction5106E371-2PvLQCdOFbzl`, AWS MCP read-only, profile `phani-quadnomics`, account `975049998516`) is the authoritative write-path live check** (successful writes log nothing — verify by absence-of-error).

## Definition of done

089 graduated (canvas is default; the 011/012 cluster built; P3–P7 shipped + SITEMAP/085 updated) + live-verified + archived to `done/`; then re-triage `docs/issues/README.md` until open-issue count is **0**. Surface a genuinely NEW owner-fork via `AskUserQuestion`; otherwise build autonomously (all 089/093 forks are answered).

---

*History (all shipped + archived to `docs/issues/done/`, or superseded): 084 Direction-3 grid unification (P0–P6); 087/088/090/091/092/094/095/096/097/098; 089-D1/D2. See `docs/issues/done/` and git log for detail — this HANDOFF was compressed 2026-07-19 to keep only the live 089-graduation thread.*
