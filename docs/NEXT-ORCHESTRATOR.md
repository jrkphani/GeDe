# NEXT ORCHESTRATOR — launch prompt: 100 + 105 done & archived · only 099 / 106 remain (105 residual txn-MEDIUM tracked in-row)

> **Run 2026-07-21→22 shipped two full features:** `100` live-child-canvas-core (A–E) and `105` Architecture-tree keyboard grammar (P0–P5, incl. the `⋯` row-action menu + both LOW review nits) — all CI-green + deployed (the 105-nits `46c8bf3` verify flaked once on a Design canvas child-core mount-timing e2e disjoint from its change, then re-ran green + deployed). `100` + `104` are archived to `done/`; `100`'s refinements are the new issue `106`. Nothing mid-flight. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `46c8bf3`, the PER-CANVAS STORE + ARCHITECTURE-TREE patterns, the memory cap, the project-open-click + canvas-flake e2e lessons, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Machine memory cap (bit hard this run)
>2 concurrent agents exhausts app memory, AND after a long session even a SINGLE local Playwright e2e OOMs (exit 144). Keep to **≤2 subagents, ONE heavy (Playwright/vitest) at a time**; `pkill -9 -f vitest/vite/@playwright` between heavy runs; constrain vitest (`--maxWorkers=2`); NEVER run local e2e while a subagent runs Playwright. If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated).

## The backlog

- **`105` (`docs/issues/done/105-...md`, ARCHIVED) — P0–P5 + both LOW nits DONE (2026-07-22); COMPLETE.** The full keyboard tree grammar (Enter=sibling, `⌘]`/`⌘[` promote/demote, `⌥⇧↑/↓` move, tree ARIA + KeyHints), the **P5 `⋯` row-action gutter menu** (a POINTER TWIN of the chords via shared pure `demoteTarget`/`promoteTarget`/`moveTarget`; disabled item = keyboard no-op; one undo/announce each; replaced the per-cell Add-child button, bulk Remove stays on the selection bar 025/035), AND both LOW review nits (sibling-group logic deduped into `domain/entryTree` `siblingsOf`/`groupSiblingsBySort`; chords exclude `ctrlKey`) are all shipped. **Residual (non-blocking, tracked in its README row):** a systemic MEDIUM (multi-step DB mutations like `moveTier2Entry` aren't PGlite-transaction-wrapped) + minor P1 polish (the sibling phantom stays anchored after the series-start row, not the newest sibling). **`46c8bf3` is verify-green + deployed; `105` is now archived to `done/`.**
- **`099` (`docs/issues/099-...md`) — remainder.** touch/tablet pan-zoom + node-drag (**manual-device** — real pinch/drag wants a device), optional label-tier-stable lock (LOW), axe extension.
- **`106` (`docs/issues/106-...md`) — 100 refinements (non-blocking).** zoom-LOD auto-culling of off-screen/deep child cores → stubs (edit-aware, never unmount mid-edit; the deferred 100 DoD LOD clause); nested-drill grandchild edge/position (cosmetic; store IS independent); presence + palette reach child-core selections. None crash.

*(088/100/101/102/103/104/105 are SHIPPED + archived — do NOT re-open.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → file:line map) → **RED-FIRST** → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** design then diff (`code-reviewer` MANDATORY for any store/render/write-path touch — this run's reviews caught 12+ HIGH pre-commit) → **VERIFY yourself** (`verify:fast` + full `e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI green.

**Subagents must NOT commit/push/add.** Keep to the memory cap; serialize e2e.

## Non-negotiables (full list in HANDOFF)
- Deploy = push to `main`; watch `gh run watch <id> --exit-status`. Rollback lever: re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas spec flakes.
- STALE-VITE before every e2e. eslint 0 errors (tolerated pre-existing warnings in EditableGrid/Canvas/server albAdapters). `xyflow` OUT of main `index-*.js`. Schema only via migrations.
- **Store-factory circular-init invariant** (HANDOFF): hoisted `function` factories + type-only `CanvasStores` import — unlinted. **`storeCanvasId` ≠ `canvasId`; the primary core resolves DEFAULT.**
- **Shared EditableGrid: any new grammar MUST be Architecture-scoped opt-in** (Design/Foundation depend on Enter=commit+down + native richtext Tab).

## Definition of done
`105` is P0–P5 + both LOW nits DONE + deployed + **archived to `done/`** (residual txn-MEDIUM + P1 phantom-anchor polish tracked in its README row). The `docs/issues/README.md` compression + HANDOFF/NEXT edits are committed, and the README was re-triaged (099 row corrected: its canvas-side hover-mute + dual-empty-state e2e were already shipped in `8cc03d2`, not "fallback-only"; 106 confirmed fully NOT-STARTED). Open backlog = `099` (touch/tablet manual + broader axe extension) · `106` (100-refinements, non-blocking) — both small/non-blocking. Build the backlog or await direction; given the machine's memory state, a fresh session is best for the next heavy build.
