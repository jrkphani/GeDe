# NEXT ORCHESTRATOR — launch prompt: 089 D3 graduation (P1→P7) then 093, divide-and-conquer with subagents

> Copy the block below as the launch prompt for the next orchestrator agent. It drives the **089 canvas-graduation build to completion**, then **093**, then re-triages the backlog to **open-issue count 0**. It is written to lean hard on subagents (≤3 concurrent). The owner-provided throwaway password is intentionally NOT embedded here — pass it inline at launch (`GEDE_PASSWORD=…`); never commit it.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). Your goal: drive the **089 D3-canvas GRADUATION build** to completion (phases **P1→P7**), then issue **093**, then re-triage `docs/issues/README.md` until the open-issue count is **0**. You are authorized to `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` runs via `workflow_run` on verify-success), and to run live-smokes against production with the throwaway creds passed to you at launch (rotate after).

**START by reading, in order:** `docs/HANDOFF.md` → the "▶▶ NEXT ORCHESTRATOR — START HERE" section; then `docs/issues/089-unified-canvas-workspace.md` → **"## D3 GRADUATION — APPROVED BUILD PLAN (2026-07-19)"** (the authoritative phased spec — **P0 is SHIPPED (`74ae9a2`); you start at P1**); then `docs/issues/093-d3-context-register-extend-right.md` → **"### Fork resolutions (owner, 2026-07-19)"**. Do not touch a phase before reading its spec bullet + the file:line it cites.

## The build (owner-approved 2026-07-19 — NO forks remain blocking)
The owner chose to **GRADUATE the `?d3rf` pan/zoom canvas to the DEFAULT workspace** AND **build the 011 recursion + 012 coverage cluster as edge-connected satellite nodes**. This deliberately reverses **085** ("tables are the instrument") + **SITEMAP §1/§2** ("page never scrolls") — the reversal is AUTHORIZED and lands in lockstep with the LAST phase (P7). Phases, in order (each ≤5 files, red-first, with a Gate — see the 089 plan):
- **P1** — decompose the **Foundation** lane into per-item nodes (⚠ reorders by `rank`, not `sort`).
- **P2** — decompose the **Design** lane into a `{ring + register}` core (stack register over ring).
- **→ 093 slots in HERE, after P2** (rides the decomposed Design core — see below).
- **P3** — **recursion (011)** as an edge-connected child-canvas satellite (`clusterLayout.ts`; dagre/elk earns its place here).
- **P4** — **coverage (012)** as an edge-connected analytical twin.
- **P5** — LOD + lazy-mount satellites + perf at volume (reuse 084's `.gede.json` 20×50 import seed).
- **P6** — deploy-gate transition: **de-flake** the `?d3rf` specs FIRST, prove green across N runs while STILL `@dev-flag`, THEN un-tag + drop `--grep-invert @dev-flag` (`package.json:14`) + retire `dev-canvas-e2e.yml`.
- **P7** — THE DEFAULT-FLIP (last, the one reversing step) + SITEMAP/085 lockstep edits, same PR.

**The phases are largely SEQUENTIAL because they all funnel through `src/components/WorkspaceCanvas.tsx` — never run two phases that edit `WorkspaceCanvas.tsx` concurrently on `main`.**

## Divide-and-conquer with subagents (REQUIRED — this is how you work)
Use subagents aggressively, **≤3 concurrent**. Per-phase loop:
1. **INVESTIGATE** (read-only subagent — `Explore` or `architect`): map the exact file:line integration points for THIS phase + the reused stores/surfaces, returning verbatim excerpts. Keeps investigation out of YOUR context.
2. **RED-FIRST**: write the failing unit + `@dev-flag` e2e tests for the phase's Gate.
3. **IMPLEMENT**: one subagent per file-cluster (or inline for ≤5 files), against the investigation map.
4. **ADVERSARIALLY REVIEW**: a `code-reviewer` subagent on the diff — **mandatory for P7's default-flip and any store/write-path touch**.
5. **VERIFY yourself** (never trust a subagent's "done"): `npm run verify:fast` + run `e2e/d3-canvas.spec.ts` (`@dev-flag`) + **screenshot-verify** the affected routes.
6. **COMMIT** (`--no-verify` after running verify + explicit `git add`) → push → confirm CI `verify` green + `deploy` ran.

**Parallelize the read-only work:** while P1/P2 implement, dispatch subagents to **pre-INVESTIGATE the 011 (P3) and 012 (P4) surfaces + stores concurrently** (read-only, no file clash) so those phases start with a map in hand. For **P7's e2e blast radius** (~50+ non-`@dev-flag` specs assume the `WorkspaceSurface` DOM), fan out subagents **per e2e spec-cluster, worktree-isolated**, to enumerate + fix canvas-default breakage in parallel (use the **D2 P5 Rule-12 sweep** as the template).

**Worktree-isolate** any subagent whose files might overlap another's; **NEVER let two subagents edit the same file on `main`** (the lint-staged pre-commit stash silently drops a concurrent edit).

## 093 (build it after P2)
093's 5 forks are **RESOLVED**: **canvas-only**; **capped + LOD** (soft max width; per-dimension columns collapse to a tuple-summary above ~8 cols / below ~0.6 zoom); **REMOVE the top "New context" button** → the register phantom row is the sole create (the `c` key still enters compose-mode); ring centered within the cap; **no column virtualization**. **DROP 093's test 5** (the owner did not upgrade the phantom to compose-mode). Build it as its own red-first slice on the decomposed Design core.

## Non-negotiables (carry forward — full list in the HANDOFF)
- **Deploy = push to `main`.** Watch CI with `gh run list --json name,status,conclusion,headSha` poll loops (`gh run watch` is flaky on this network). If a deploy is skipped, check whether `verify` is red-streaking.
- **Keep the `?d3rf` `d3-canvas.spec.ts` tests `@dev-flag`** (excluded from the deploy-gating `verify`) **UNTIL P6** graduates them — a dev-flag flake must never freeze prod deploy (issue 096). P6 does the careful de-flake-then-un-tag.
- **STALE-VITE gotcha** (bit the last session twice): after editing any module, **KILL the playwright test-server + any vite on :5173** (`pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9`) before an e2e re-run, or HMR serves stale code and tests false-fail.
- **TIER-ROUTE LATENT BUGS:** the canvas had NEVER actually rendered on a Foundation/Architecture (tier) route until P0. As P1/P2 decompose the lanes, **test EVERY route on the canvas** (`goto /foundation?d3rf`, `/architecture?d3rf`, `/design?d3rf`, and navigate between them) — expect more "Maximum update depth" / unstable-memo-dependency bugs like the one P0 fixed (a fresh `[]` created each render).
- **PROD-FOLD INVARIANT:** `canvasEnabled` folds to `false` in prod (the `import.meta.env.DEV` gate). After ANY change to the App gate / `canvasMode` / the `WorkspaceCanvas` lazy import, **run a prod build and grep that `xyflow` stays OUT of the main `index-*.js` bundle** (only in the never-fetched lazy `WorkspaceCanvas-*.js` chunk). This **inverts at P7** (React Flow now ships) — convert the zero-size guard into a budget CEILING then.
- **Keep the `routes.ts` grammar intact** throughout (011/012/090 depend on it); the URL simplification is deferred past graduation.
- **Frozen `EditableGrid.onExitBoundary(dir)` seam + DEFAULT-OFF EditableGrid seams;** run `d3-canvas.spec.ts` after any EditableGrid/canvas change.
- **≤3 concurrent subagents;** commit `--no-verify` after running verify yourself + explicit `git add`; worktree-isolate overlapping subagents.
- **Screenshot UI changes** — the canvas becomes user-facing at P7, so screenshot every route. **Schema only via migrations** (089 is frontend-only; the cluster reuses existing stores/mutations). **Adversarially review P7** + any store change (real-Postgres is authoritative for any write-path).
- **Throwaway live creds** (passed at launch — never commit): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD=<from owner>`. Live URL `https://d1nzod71m3rz6x.cloudfront.net`. AWS profile `phani-quadnomics`; CloudWatch (`…WriteApiFunction…`, read-only) is the authoritative write-path live check.

## Definition of done
089 graduated (canvas is the default; the 011/012 cluster is built; P0–P7 shipped + SITEMAP/085 updated) **+ live-verified + archived to `done/`**; 093 shipped + archived; then **re-triage `docs/issues/README.md`** for anything new. Leave a morning HANDOFF update. If a genuinely NEW owner-fork emerges (not one already resolved), surface it via `AskUserQuestion` — but the 089/093 forks are ALL answered, so **build autonomously**. Loop until 0.
