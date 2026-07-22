# NEXT ORCHESTRATOR — launch prompt: 100 A–E done · 105 P0–P3 done · 099 + 105-P4/P5 + 100-refinements remain

> **Run 2026-07-21→22 shipped the whole `100` live-child-canvas-core (all 5 phases A–E)**, plus `104`-LOW and `099`-coverage, corrected `088`'s index, and filed **`105`** (Architecture-tree keyboard model) from owner UX feedback. Nothing mid-flight. Two owner decisions are pending (105 keybinding; 104 fork). Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `8314e92`, the PER-CANVAS STORE ARCHITECTURE patterns from 100, the memory cap, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Machine memory cap
Owner reports **>2 concurrent agents exhausts app memory.** Keep to **≤2 subagents, prefer ONE heavy agent at a time** (Playwright/vitest are the hogs). Serialize local e2e (port 5173; STALE-VITE kill before each run). A background `gh run watch` poll is negligible.

## The backlog

- **`105` (`docs/issues/105-...md`) — P0–P3 SHIPPED (`510ac53`, `2fe39b1`); P4/P5 remain.** The full keyboard tree grammar is live: Enter=sibling series, `⌘]`/`⌘[` promote/demote, `⌥⇧↑/↓` move — Architecture-scoped opt-in seams (Design/Foundation byte-identical), `moveEntry` over the tested `moveTier2Entry`. **Remaining:** **P4** tree ARIA (`aria-level`/`aria-expanded`) + `KeyHint` chips teaching the shortcuts; **P5** the `⋯` row-action gutter menu (move single-row commands OUT of data cells — the owner's IA critique; keep the selection bar for bulk). Plus 2 LOW nits (dedupe `siblingGroup`/`siblingsOfIn`; exclude `ctrlKey`) and a systemic MEDIUM (multi-step DB mutations like `moveTier2Entry` aren't transaction-wrapped — consider PGlite transactions; `moveEntry` has an `e.repeat` guard). Minor P1 polish: the sibling phantom stays anchored after the series-start row, not the newest sibling.
- **`100` refinements (non-blocking):** zoom-LOD auto-culling of off-screen/deep child cores back to stubs (the deferred DoD LOD clause); nested-drill mispositioning (grandchild edge/position source the PRIMARY register — cosmetic); presence + palette don't reach a child-core selection (root-scoped). All documented in the 100 issue; none crash.
- **`099` remainder:** touch/tablet pan-zoom + node-drag (**manual-device** — real pinch/drag wants a device), optional label-tier-stable lock (LOW), axe extension.
- **`104`:** ✅ RESOLVED — the empty-space fork was decided (leave as-is, owner 2026-07-22). Do NOT re-open.

*(088/101/102/103 are SHIPPED + archived — do NOT re-open.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → file:line map) → **RED-FIRST** → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** design then diff (`code-reviewer` MANDATORY for any 100/store/render/write-path touch) → **VERIFY yourself** (`verify:fast` + full `e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI green.

**Subagents must NOT commit/push/add.** Keep to the memory cap; serialize e2e.

## Non-negotiables (full list in HANDOFF)
- Deploy = push to `main`; watch `gh run watch <id> --exit-status`. Rollback lever: re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas spec flakes.
- STALE-VITE before every e2e. eslint: no `!`, `interface` over `type`, 0 errors. Bundle: `xyflow` OUT of main `index-*.js`. Schema only via migrations.
- **Store-factory circular-init invariant** (HANDOFF): hoisted `function` factories + type-only `CanvasStores` import — nothing lints it. **`storeCanvasId` ≠ `canvasId`** and the primary core must resolve DEFAULT.

## Definition of done
Await the two owner decisions (105 keybinding, 104 fork), or build `105` P0+P1 on owner go (biggest UX win), and/or the `099`/`100` refinements. Re-triage `docs/issues/README.md` toward open-count 0. Leave a compressed HANDOFF update.
