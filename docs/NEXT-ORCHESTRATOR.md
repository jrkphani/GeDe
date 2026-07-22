# NEXT ORCHESTRATOR — launch prompt: 100 + 104 + 105 + 106 + 107 all done & archived · OPEN: only 099-touch (manual) — actionable backlog EMPTY

> **Runs 2026-07-21→22 cleared the whole actionable backlog.** Prior run: `100` live-child-canvas-core (A–E) + `105` Architecture-tree keyboard (P0–P5 + nits). This session (continuation): the full **`106` trilogy** (① zoom-LOD culling · ② grandchild positioning · ③ presence+palette→child-cores), **`105` P1** phantom-anchor, the **`099` automatable a11y tests**, and — completing **`107`** — ALL ~21 multi-step DB mutations are now **transaction-wrapped** for atomicity (5 phases, each RED-first + database-reviewer-APPROVE). All CI-green + deployed (107 Phases 2–5 CI-verifying at handoff). `100`/`104`/`105`/`106`/`107` archived to `done/`. Reviews caught a CRITICAL + several HIGHs pre-commit — `main` never saw one. **The actionable backlog is now empty** (only `099`-touch remains — a manual-device task). Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `dc51894`, the PER-CANVAS STORE + ARCHITECTURE-TREE + CHILD-CORE-REFINEMENT + WRITE-PATH-TXN patterns, the memory cap, the project-open-click + canvas-flake e2e lessons, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Machine memory cap (bit hard this run)
>2 concurrent agents exhausts app memory, AND after a long session even a SINGLE local Playwright e2e OOMs (exit 144). Keep to **≤2 subagents, ONE heavy (Playwright/vitest) at a time**; `pkill -9 -f vitest/vite/@playwright` between heavy runs; constrain vitest (`--maxWorkers=2`); NEVER run local e2e while a subagent runs Playwright. If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated).

## The backlog — actionable backlog is EMPTY

- **`099` (`docs/issues/099-...md`) — MANUAL-ONLY, the only OPEN issue.** Just touch/tablet pan-zoom + node-drag on a real coarse-pointer device. All automatable a11y/coverage items shipped (`6434752` + earlier). **Nothing an agent can do here** — it needs a physical device.
- There is no other open work. Await direction / new feature requests.

*(088/100/101/102/103/104/105/106/107 are SHIPPED + archived — do NOT re-open. Minor tracked non-issues: 107 — `projectIO.ts:34` could import the shared `Tx` (LOW); 106 — grandchild breadcrumb depth + WorkspaceCanvas render-path unit harness.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → file:line map) → **RED-FIRST** → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** design then diff (`code-reviewer` MANDATORY for any store/render/write-path touch — this run's reviews caught 12+ HIGH pre-commit) → **VERIFY yourself** (`verify:fast` + full `e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI green.

**Subagents must NOT commit/push/add.** Keep to the memory cap; serialize e2e.

## Non-negotiables (full list in HANDOFF)
- Deploy = push to `main`; watch `gh run watch <id> --exit-status`. Rollback lever: re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas spec flakes.
- STALE-VITE before every e2e. eslint 0 errors (tolerated pre-existing warnings in EditableGrid/Canvas/server albAdapters). `xyflow` OUT of main `index-*.js`. Schema only via migrations.
- **Store-factory circular-init invariant** (HANDOFF): hoisted `function` factories + type-only `CanvasStores` import — unlinted. **`storeCanvasId` ≠ `canvasId`; the primary core resolves DEFAULT.**
- **Shared EditableGrid: any new grammar MUST be Architecture-scoped opt-in** (Design/Foundation depend on Enter=commit+down + native richtext Tab).

## Definition of done
`100`/`104`/`105`/`106`/`107` are all SHIPPED + reviewed + deployed + **archived to `done/`**. The write path is fully transaction-atomic. **The actionable backlog is empty** — the only OPEN issue is `099`-touch (manual-device, unautomatable). HEAD `8126537` is verify-green (107 Phases 2–5 CI-verifying at handoff). Await direction / new work. The write-path txn recipe + per-canvas-store/child-core/e2e/memory patterns are captured in HANDOFF and the `done/` issue files.
