# NEXT ORCHESTRATOR — launch prompt: 100 done (A–E) · 099/104 remainders · 105 pending owner

> **Run 2026-07-21→22 shipped the whole `100` live-child-canvas-core (all 5 phases A–E)**, plus `104`-LOW and `099`-coverage, corrected `088`'s index, and filed **`105`** (Architecture-tree keyboard model) from owner UX feedback. Nothing mid-flight. Two owner decisions are pending (105 keybinding; 104 fork). Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `8314e92`, the PER-CANVAS STORE ARCHITECTURE patterns from 100, the memory cap, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Machine memory cap
Owner reports **>2 concurrent agents exhausts app memory.** Keep to **≤2 subagents, prefer ONE heavy agent at a time** (Playwright/vitest are the hogs). Serialize local e2e (port 5173; STALE-VITE kill before each run). A background `gh run watch` poll is negligible.

## The backlog

- **`105` (`docs/issues/105-...md`) — Architecture-tree keyboard model, PENDING OWNER GO on the keybinding**, then the highest-value UX build. Owner found tree editing clunky (no keyboard sibling-vs-child, no promote/demote, an accidental sub-child bug, and a control living in a data cell). The issue is a coherent P0–P5 plan. **P0 (kill the sub-child bug) + P1 (Enter=new-sibling) are the big win** and need no owner input beyond confirming the shortcut philosophy. **Owner decision:** `⌘]`/`⌘[` for promote/demote (recommended — the committed grammar already reserves Tab for commit+move) vs Tab/Shift+Tab. Key facts already established: the sub-child bug is a Tab-fallthrough in the description richtext (fix at source: intercept Tab + `tabIndex=-1` on Add-child); Enter=sibling MUST be an Architecture-scoped opt-in seam (never a global EditableGrid change); the reparent engine `moveTier2Entry` already exists + is tested (`mutations.ts:1708`) — P2 is a thin `moveEntry` store wrapper, no tree library.
- **`100` refinements (non-blocking):** zoom-LOD auto-culling of off-screen/deep child cores back to stubs (the deferred DoD LOD clause); nested-drill mispositioning (grandchild edge/position source the PRIMARY register — cosmetic); presence + palette don't reach a child-core selection (root-scoped). All documented in the 100 issue; none crash.
- **`099` remainder:** touch/tablet pan-zoom + node-drag (**manual-device** — real pinch/drag wants a device), optional label-tier-stable lock (LOW), axe extension.
- **`104`:** ONE owner fork — empty-space-dismiss of the armed add-child phantom (safe to build, but changes a prod-canvas interaction + contradicts the tested current behavior).

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
