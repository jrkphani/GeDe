# NEXT ORCHESTRATOR — launch prompt: 100 + 105-core shipped & archived · 105-P5 (owner) / 099 / 106 remain

> **Run 2026-07-21→22 shipped two full features:** `100` live-child-canvas-core (A–E) and `105` Architecture-tree keyboard grammar (P0–P4) — all CI-green + deployed. `100` + `104` are archived to `done/`; `100`'s refinements are the new issue `106`. Nothing mid-flight. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `771287b`+docs, the PER-CANVAS STORE + ARCHITECTURE-TREE patterns, the memory cap, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Machine memory cap (bit hard this run)
>2 concurrent agents exhausts app memory, AND after a long session even a SINGLE local Playwright e2e OOMs (exit 144). Keep to **≤2 subagents, ONE heavy (Playwright/vitest) at a time**; `pkill -9 -f vitest/vite/@playwright` between heavy runs; constrain vitest (`--maxWorkers=2`); NEVER run local e2e while a subagent runs Playwright. If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated).

## The backlog

- **`105` (`docs/issues/105-...md`) — P0–P4 SHIPPED; P5 + nits OPEN.** The full keyboard tree grammar is live (Enter=sibling, `⌘]`/`⌘[` promote/demote, `⌥⇧↑/↓` move, tree ARIA + KeyHints). **P5 = the `⋯` row-action gutter menu — move single-row commands (Add child/sibling, Promote/Demote, Move, Remove) OUT of the data cells into one row-hover `⋯` menu; keep the selection bar for BULK (025/035). NEEDS OWNER GO** — it restructures the row-command model (the owner raised the IA critique but hasn't approved building it). See the 105 "Row-command IA" section. Also open: 2 LOW nits (dedupe `siblingGroup`/`siblingsOfIn`; exclude `ctrlKey` on the chords), a systemic MEDIUM (multi-step DB mutations like `moveTier2Entry` aren't PGlite-transaction-wrapped), and minor P1 polish (the sibling phantom stays anchored after the series-start row, not the newest sibling).
- **`099` (`docs/issues/099-...md`) — remainder.** touch/tablet pan-zoom + node-drag (**manual-device** — real pinch/drag wants a device), optional label-tier-stable lock (LOW), axe extension.
- **`106` (`docs/issues/106-...md`) — 100 refinements (non-blocking).** zoom-LOD auto-culling of off-screen/deep child cores → stubs (edit-aware, never unmount mid-edit; the deferred 100 DoD LOD clause); nested-drill grandchild edge/position (cosmetic; store IS independent); presence + palette reach child-core selections. None crash.

*(088/100/101/102/103/104 are SHIPPED + archived — do NOT re-open.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → file:line map) → **RED-FIRST** → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** design then diff (`code-reviewer` MANDATORY for any store/render/write-path touch — this run's reviews caught 12+ HIGH pre-commit) → **VERIFY yourself** (`verify:fast` + full `e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI green.

**Subagents must NOT commit/push/add.** Keep to the memory cap; serialize e2e.

## Non-negotiables (full list in HANDOFF)
- Deploy = push to `main`; watch `gh run watch <id> --exit-status`. Rollback lever: re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas spec flakes.
- STALE-VITE before every e2e. eslint 0 errors (tolerated pre-existing warnings in EditableGrid/Canvas/server albAdapters). `xyflow` OUT of main `index-*.js`. Schema only via migrations.
- **Store-factory circular-init invariant** (HANDOFF): hoisted `function` factories + type-only `CanvasStores` import — unlinted. **`storeCanvasId` ≠ `canvasId`; the primary core resolves DEFAULT.**
- **Shared EditableGrid: any new grammar MUST be Architecture-scoped opt-in** (Design/Foundation depend on Enter=commit+down + native richtext Tab).

## Definition of done
Build the open backlog — but **P5 needs an owner go first** (surface it), and the `099`/`106` items are small/non-blocking. Re-triage `docs/issues/README.md` toward open-count 0. Leave a compressed HANDOFF update.
