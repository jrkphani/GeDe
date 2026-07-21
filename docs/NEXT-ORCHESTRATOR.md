# NEXT ORCHESTRATOR — launch prompt: 100 Phase B next (Phase A shipped) · 099/104 remainders

> **Night run 2026-07-21 shipped `104`-LOW, `099`-coverage, and `100` Phase A** (the per-canvas store-factory refactor, zero-behavior-change, reviewed clean), and corrected `088`'s stale index (it was already verified-live). Nothing is mid-flight. `100` Phase B is the next increment. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `be33140`+docs, the STORE-FACTORY INVARIANTS from 100 Phase A, the memory cap, non-negotiables) and `docs/issues/README.md` (backlog index).

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`), and run live-smokes with throwaway creds if the owner passes them at launch (not required — the account-free local app + CloudFront URL verify without creds).

## ⚠️ Machine memory cap
The owner reports **>2 concurrent agents exhausts application memory on this Mac.** Keep to **≤2 subagents, and prefer ONE heavy agent at a time** (Playwright/vitest are the hogs). **Serialize local e2e** (port 5173; STALE-VITE kill before each run). A background `gh run watch` poll is negligible.

## The backlog

- **`100` (`docs/issues/100-canvas-live-child-core.md`) — Phase A SHIPPED; NEXT = Phase B.** Promote the recursion satellite STUB → a live child {register+ring} core editable in place. Phase A landed the `createCanvasStores(canvasId)` factory + registry + default-instance shim (`src/store/canvasStores.ts`), zero behavior change, adversarially reviewed clean. **Phase B [D+M, ~5 files]:** thread `canvasId` into the live-core surfaces (`DesignCoreAdapter`, `ContextRegister`, `DimensionManager`, `ParameterList`, `WorkspaceCanvas`) — resolve the per-canvas instance from the node's `canvasId` via a small `useCanvasStores(canvasId)` render hook instead of the module singleton. Root canvas === the default instance, so B can be kept near-zero-behavior-change until a child goes live (Phase D). **Then C** (active-canvas FOCUS-FOLLOWS + keyboard-verb arbitration + focus-pan), **D** (satellite goes live: lazy `getCanvasStores`/`release`, LOD-gated, edit-aware mount/unmount), **E** (incidentals + **the OPEN tier2 cross-lane-linkage decision — ASK THE OWNER**). **Read the "Store-factory invariants" section of HANDOFF before touching these** — the circular-init safety is implicit and unlinted (hoisted `function` factories + type-only `CanvasStores` import). **MANDATORY adversarial review on every store/render-path touch.**
- **`099` (`docs/issues/099-...md`) — coverage remainder only.** Touch/tablet pan-zoom + node-drag (a **manual-device** item — the harness can `hasTouch` but real pinch/drag verification wants a device), optional label-tier-stable-across-zoom lock (LOW), axe extension to Foundation/Architecture lanes + satellite states. Small, red-first each.
- **`104` (`docs/issues/104-...md`) — ONE owner fork open.** Item (1): should clicking EMPTY space dismiss the armed add-child phantom? A safe impl exists (dismiss only when the pointerdown target is not a `.grid-cell` and not the phantom — never fires on a cell click, no reflow race), but it CHANGES a prod-default-canvas interaction and CONTRADICTS the tested current behavior (edge-d locks leaves-armed). **Owner decision** — do not auto-implement.

*(101/102/103/088 are SHIPPED + archived — do NOT re-open. 102's fix + 104's `beginEditing` seam are load-bearing: `RichTextCell` KEEPS `editing` on blur on purpose for the FormatStrip — do not "fix" that.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → verbatim file:line map) → **RED-FIRST** (a failing unit/e2e for the gate) → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** the DESIGN then the DIFF (`code-reviewer` on the diff is MANDATORY for any 100 store/render-path touch) → **VERIFY yourself** (`npm run verify:fast` + full `npm run e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI `verify` green + `deploy`.

**Subagents must NOT commit/push/add.** Sequence anything sharing `EditableGrid.tsx`/`base.css`/the store files; never two e2e suites at once; keep to the memory cap.

## Non-negotiables (full list in HANDOFF)
- **Deploy = push to `main`;** watch CI with `gh run watch <id> --exit-status` (background) or `gh run list --json`. **Rollback lever if a canvas spec flakes:** re-add `--grep-invert @dev-flag` to `package.json` `e2e`.
- **STALE-VITE** kill before every e2e re-run. **eslint:** no `!`, `interface` over `type`, 0 errors (one tolerated `EditableGrid.tsx` warning). **Bundle:** `xyflow` OUT of main `index-*.js`. **Schema only via migrations.**
- **Adversarial review MANDATORY for 100.** **Screenshot** user-facing changes. CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) = authoritative write-path check.

## Definition of done
Sequence `100` Phase B (its own reviewed increment; C/D/E carry real UX + the OPEN tier2 decision → surface it to the owner via `AskUserQuestion`), and/or ship the `099` remainder — or surface a NEW owner-fork. Re-triage `docs/issues/README.md` toward open-count 0. Leave a compressed HANDOFF update.
