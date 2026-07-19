# NEXT ORCHESTRATOR — launch prompt: 089 D3 graduation (P3→P7), divide-and-conquer with subagents

> Copy the block below as the launch prompt for the next orchestrator agent. It drives the **089 canvas-graduation build to completion** (P0/P1/P2 + 093 are SHIPPED — start at **P3**), then re-triages the backlog to **open-issue count 0**. Lean hard on subagents (≤3 concurrent). The owner-provided throwaway password is intentionally NOT embedded — pass it inline at launch (`GEDE_PASSWORD=…`); never commit it.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). Your goal: finish the **089 D3-canvas GRADUATION build** — phases **P3→P7** (P0/P1/P2 + 093 are already SHIPPED) — then re-triage `docs/issues/README.md` until the open-issue count is **0**. You are authorized to `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run` on verify-success), and to run live-smokes against production with the throwaway creds passed to you at launch (rotate after).

**START by reading, in order:** `docs/HANDOFF.md` (the session-4 START HERE — current state, the established PATTERNS, and the banked P3/P4 maps); then `docs/issues/089-unified-canvas-workspace.md → ## D3 GRADUATION — APPROVED BUILD PLAN` (the authoritative phased spec — the **P0/P1/P2/093 bullets are marked SHIPPED with lessons; you start at P3**). Do not touch a phase before reading its spec bullet + the file:line it cites.

## What's already shipped (do NOT redo)
- **P0** (`74ae9a2`) — `?d3rf` persists in a `canvasMode` store.
- **P1** (`d2f7fe7`) — Foundation lane decomposed into per-item nodes (`FoundationCanvasNodes.tsx`; reorders by **rank**).
- **P2** (`e0cc006`) — Design lane decomposed into `designRegister` over `designRing` (`canvasCompose.ts` shared store + `DesignCoreAdapter.tsx`).
- **093** (`dd8902b`) — register extends right + LOD tuple-summary collapse + "New context" button removed.

The flag-off surfaces (`FoundationSurface`, `DesignSurface`) are UNTOUCHED and stay that way — the canvas adapters are a parallel, mutually-exclusive `?d3rf` path.

## Remaining phases (each ≤5 files, red-first, with a Gate — see the 089 plan)
- **P3 — recursion (011) as edge-connected child-canvas satellites.** Drill-in spawns a child `{register+ring}` cluster + a parent→child edge; pan-to-child; collapse unmounts. NEW `src/domain/clusterLayout.ts` (**dagre/elk earns its place here**). **Introduces the FIRST React Flow edges — ZERO edge infra exists today** (`nodesConnectable={false}`, no `useEdgesState`). Reuse `useContextsStore.openChildCanvas`/`loadBreadcrumbs`/`revertStale` (banked map in the HANDOFF); PRESERVE the `routes.ts` contextPath grammar.
- **P4 — coverage (012) as an edge-connected analytical twin.** `v` opens/collapses a twin node (was a route swap); gap-click pans back + composes pre-filled. `CoverageMatrix` is already prop-driven; the two `navigate()` sites to convert are the `v` handler in `DesignRegisterBody` + `handleComposeTuple` in `DesignRingBody`.
- **P5 — LOD + lazy-mount satellites + perf at volume.** Reuse 084's `.gede.json` 20×50 seed. **093's deferred bits land here:** register pixel width-cap + the >8-column collapse trigger + focus-expand.
- **P6 — deploy-gate transition (careful — don't freeze deploys).** FIRST de-flake the 096 `test.fixme` specs + prove green across N runs while STILL `@dev-flag`; THEN drop the tags + `--grep-invert @dev-flag` (`package.json:14`) + retire `dev-canvas-e2e.yml`. Invert the RF zero-size bundle guard into a budget ceiling.
- **P7 — THE DEFAULT-FLIP (last, the reversing step) + SITEMAP/085 lockstep in the SAME PR.** `d3CanvasEnabled()` → capability check (default ON desktop/tablet); canvas primary; `WorkspaceSurface` the < 1024px fallback. ~50+ non-`@dev-flag` specs assume the `WorkspaceSurface` DOM — run the full suite against the canvas in a branch first (D2 P5 Rule-12 sweep is the template). **Adversarially review this + the SITEMAP §1/§2/§3/§4 + 085 supersession edits.**

**The phases are SEQUENTIAL — they all funnel through `src/components/WorkspaceCanvas.tsx`. Never run two phases that edit it concurrently on `main`.**

## Reuse the patterns from session 4 (in the HANDOFF)
Adapter-don't-gut · derived-positions-only (width never feeds the x-stride) · cross-tree-state-via-a-store · stable-id-nodes-never-unmount (re-home per-nav resets to a `canvasSelector` effect) · zoom-in-a-node-body via `useStore` BOOLEAN selector · the create→focus-race (`waitForStableViewport` before the next e2e step).

## Divide-and-conquer with subagents (REQUIRED)
Per-phase loop (≤3 concurrent): **INVESTIGATE** (read-only `Explore`/`architect` → verbatim file:line map, keeps it out of your context) → **RED-FIRST** (failing unit + `@dev-flag` e2e for the Gate) → **IMPLEMENT** (a `fork` inherits your context for a large 2-file build; else inline for ≤5 files) → **ADVERSARIALLY REVIEW** (`code-reviewer` on the diff — MANDATORY for P7 + any store/write-path touch; P2's review caught 2 real bugs) → **VERIFY yourself** (`npm run verify:fast` + run `e2e/d3-canvas.spec.ts` + test EVERY route + screenshot) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI `verify` green + `deploy` ran. Parallelize read-only investigation of the next phase while the current one implements. For P7's e2e blast radius, fan out per spec-cluster in worktrees.

## Non-negotiables (full list in the HANDOFF)
- **Deploy = push to `main`.** Watch CI with `gh run list --json` poll loops (`gh run watch` is flaky). If a deploy is skipped, check whether `verify` is red-streaking.
- **Keep the `?d3rf` specs `@dev-flag` UNTIL P6** (a dev-flag flake must never freeze prod deploy — issue 096). P6 does the careful de-flake-then-un-tag.
- **STALE-VITE:** `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before any e2e re-run after editing a module.
- **PROD-FOLD:** after any App-gate/`canvasMode`/lazy-import change, prod-build + grep `xyflow` stays OUT of the main bundle. INVERTS at P7 (RF ships) — make the guard a budget CEILING then.
- **TEST EVERY route on the canvas** + navigate between them; watch for "Maximum update depth" tier-route bugs. **Keep `routes.ts` grammar intact.** **Frozen `EditableGrid.onExitBoundary(dir)` seam;** run `d3-canvas.spec.ts` after any EditableGrid/canvas change.
- **≤3 concurrent subagents;** commit `--no-verify` after verifying + explicit `git add`; worktree-isolate overlapping subagents; never let two edit the same file on `main`.
- **Screenshot** UI changes (canvas is user-facing from P7). **Schema only via migrations** (frontend-only; the cluster reuses existing stores/mutations). **Real-Postgres is authoritative** for any write-path.
- **Throwaway live creds** (passed at launch — never commit): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD=<from owner>`. Live URL `https://d1nzod71m3rz6x.cloudfront.net`. AWS profile `phani-quadnomics`; CloudWatch (`/aws/lambda/Gede-Test-Api-WriteApiFunction5106E371-2PvLQCdOFbzl`, read-only) is the authoritative write-path live check (successful writes log nothing).

## Definition of done
089 graduated (canvas is the default; the 011/012 cluster built; P3–P7 shipped + SITEMAP/085 updated) **+ live-verified + archived to `done/`**; then **re-triage `docs/issues/README.md`** for anything new. Leave a compressed HANDOFF update. If a genuinely NEW owner-fork emerges (not one already resolved), surface it via `AskUserQuestion` — the 089/093 forks are ALL answered, so **build autonomously**. Loop until 0.
