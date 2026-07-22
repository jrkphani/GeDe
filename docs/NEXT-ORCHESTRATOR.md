# NEXT ORCHESTRATOR — launch prompt: 100 + 104 + 105 + 106 all done & archived · OPEN: only 107 (txn-wrap Phases 2–5) + 099-touch (manual)

> **Runs 2026-07-21→22 cleared the whole actionable backlog.** Prior run: `100` live-child-canvas-core (A–E) + `105` Architecture-tree keyboard (P0–P5 + nits). This session (continuation): the full **`106` trilogy** (① zoom-LOD culling · ② grandchild positioning · ③ presence+palette→child-cores), **`105` P1** phantom-anchor, the **`099` automatable a11y tests**, and **`105`-txn Phase 1** (`moveTier2Entry` atomic). All CI-green + deployed. `100`/`104`/`105`/`106` archived to `done/`. Reviews caught a CRITICAL + several HIGHs pre-commit — `main` never saw one. Nothing mid-flight. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `dc51894`, the PER-CANVAS STORE + ARCHITECTURE-TREE + CHILD-CORE-REFINEMENT + WRITE-PATH-TXN patterns, the memory cap, the project-open-click + canvas-flake e2e lessons, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Machine memory cap (bit hard this run)
>2 concurrent agents exhausts app memory, AND after a long session even a SINGLE local Playwright e2e OOMs (exit 144). Keep to **≤2 subagents, ONE heavy (Playwright/vitest) at a time**; `pkill -9 -f vitest/vite/@playwright` between heavy runs; constrain vitest (`--maxWorkers=2`); NEVER run local e2e while a subagent runs Playwright. If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated).

## The backlog — 2 items, both non-blocking

- **`107` (`docs/issues/107-...md`) — transaction-wrap the remaining ~20 multi-step mutations.** THE main pickup. Phase 1 (`moveTier2Entry`) shipped (`dc51894`); the pattern + full phasing (Phase 2 subtree/promote · 3 reorder-family · 4 cascades · 5 binding/param) are specced in the issue. Each phase is a **mechanical repeat**: wrap in `db.transaction`, widen touched helpers to `Querier`, RED-first rollback test (Proxy `db` failing on the Nth `.update()`), store layer UNCHANGED (outbox is in-memory), DB/code review, CI, post-deploy CloudWatch check. ≤5 files/phase.
- **`099` (`docs/issues/099-...md`) — MANUAL-ONLY remainder.** Just touch/tablet pan-zoom + node-drag on a real coarse-pointer device. All automatable a11y/coverage items shipped (`6434752` + earlier). Nothing an agent can do here.

*(088/100/101/102/103/104/105/106 are SHIPPED + archived — do NOT re-open. 106 follow-ups — grandchild breadcrumb depth, WorkspaceCanvas render-path unit harness — are minor and tracked in the 106 done-row.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → file:line map) → **RED-FIRST** → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** design then diff (`code-reviewer` MANDATORY for any store/render/write-path touch — this run's reviews caught 12+ HIGH pre-commit) → **VERIFY yourself** (`verify:fast` + full `e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI green.

**Subagents must NOT commit/push/add.** Keep to the memory cap; serialize e2e.

## Non-negotiables (full list in HANDOFF)
- Deploy = push to `main`; watch `gh run watch <id> --exit-status`. Rollback lever: re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas spec flakes.
- STALE-VITE before every e2e. eslint 0 errors (tolerated pre-existing warnings in EditableGrid/Canvas/server albAdapters). `xyflow` OUT of main `index-*.js`. Schema only via migrations.
- **Store-factory circular-init invariant** (HANDOFF): hoisted `function` factories + type-only `CanvasStores` import — unlinted. **`storeCanvasId` ≠ `canvasId`; the primary core resolves DEFAULT.**
- **Shared EditableGrid: any new grammar MUST be Architecture-scoped opt-in** (Design/Foundation depend on Enter=commit+down + native richtext Tab).

## Definition of done
`100`/`104`/`105`/`106` are all SHIPPED + reviewed + deployed + **archived to `done/`**. `105`'s residuals are resolved (P1 polish + txn Phase 1 shipped). `099` is down to its single **manual-device** item. HEAD `dc51894` is verify-green + deployed. **Open backlog = just `107` (txn-wrap Phases 2–5) + `099`-touch (manual).** Pick up `107` phase-by-phase (fully specced) — or await direction. Given the machine's memory state after these long runs, a fresh session per phase is ideal: local unit tests `--maxWorkers=2`, lean on CI for e2e.
