# HANDOFF — 2026-07-22 (100 A–E + 105 P0–P4 SHIPPED & CI-green; 100 & 104 archived; 099/105/106 open)

**Long autonomous run under owner directives "sequence all open tasks and execute autonomously" → "continue" → "continue until done, use subagents."** Delivered TWO full features end-to-end: **`100` live-child-canvas-core** (all 5 phases A–E) and — from live owner UX feedback mid-run — the **`105` Architecture-tree keyboard grammar** (P0–P4). Plus `104` resolved, `099`-coverage, `088` index corrected. **`100` + `104` are now ARCHIVED to `done/`**; `100`'s non-blocking refinements were filed as **`106`**. Nothing is mid-flight.

Every store/render/write-path change went through a mandatory `code-reviewer` pass; those reviews caught **12+ HIGH regressions pre-commit** — `main` never saw one.

Launch prompt for the next session: `docs/NEXT-ORCHESTRATOR.md`.

---

## Current state

HEAD: **`771287b`** + the archiving/docs commit on top. **CI `verify` CONFIRMED GREEN** on the whole run's feature commits (100 A–E: `be33140`/`f5b6420`/`6af0754`/`51852e6`; 105: `510ac53`/`2fe39b1`/`4d0af2a`). All deployed. Canvas is the prod default (≥1024px + not data-saver); `WorkspaceSurface` is the fallback. Live URL: https://d1nzod71m3rz6x.cloudfront.net.

### What shipped (all CI-green + deployed)

- **`100` — live child-canvas core, ALL 5 PHASES (SHIPPED & archived → `done/100-...md`).** Drilling ("Open ▸") a child mounts a LIVE {register+ring} core editable in place beside its live, INDEPENDENT parent.
  - **A** (`be33140`) — `src/store/canvasStores.ts`: `createCanvasStores(canvasId)` factory + registry (`getCanvasStores`/`releaseCanvasStores`) + default-instance shims. Store bodies → hoisted `createXStore()` factories; per-instance `syncUnsubscribe`; sibling reads → `getStores().use*`. `parameters` stays global. Zero behavior change.
  - **B** (`f5b6420`) — `CanvasStoresContext` (`CanvasStoresProvider`/`useCanvasStores`) + `resolveCanvasStores(canvasId?)`; ~57 call-sites routed through the resolved `stores`. Byte-identical.
  - **C** (`6af0754`) — `src/store/activeCanvas.ts`: `c`/`v`/`d` verbs gate on `activeCanvas === coreKey`. Single-core inert.
  - **D** (`51852e6`) — namespaced live `{register+ring}` per child (`${id}:${parentContextId}`; PRIMARY keeps bare ids), `storeCanvasId=parentContextId` → own instance (primary → default); collapse/nav-reset → `releaseCanvasStores` (leak-free). Removed the dead SatelliteNode stub + `Enter ▸`. RED-first two-core independence e2e + screenshot.
  - **E** (`8314e92`, no code) — tier2 promote root-stamps by construction (`mutations.ts:1836`); DesignSurface never co-mounts; presence/palette stay root (→ 106).
- **`105` — Architecture-tree keyboard, P0–P4 (SHIPPED; issue stays OPEN for P5).**
  - **P0** (`510ac53`) kill the sub-child **Tab-fallthrough** (intercept Tab in the description richtext + `tabIndex=-1` on Add-child). **P1** Enter = new-sibling series (type-to-create phantom). Both via Architecture-scoped opt-in seams (`richTextTabAdvances`, `onEnterCreateSibling`) → Design/Foundation byte-identical.
  - **P2/P3** (`2fe39b1`) `⌘]`/`⌘[` promote/demote + `⌥⇧↑/↓` move, via a `moveEntry` store action over the tested `moveTier2Entry` (one undo/gesture, complete sync-enqueue, focus-follows, `e.repeat` guard).
  - **P4** (`4d0af2a`) tree ARIA — a SR-only `role="tree"` of `role="treeitem"`s (`aria-level`/`aria-expanded`, off the `<tr>` to stay axe-clean; promote `role="option"` listbox preserved) + aria-hidden `⏎`/`⌘]`/`⌘[` KeyHint chips. `EditableGrid` byte-identical.
- **`104`** (`85a5e47`, **archived → `done/104-...md`**) — 4 edge regression tests + rAF-invariant comment; empty-space fork DECIDED leave-as-is.
- **`099` coverage** (`8cc03d2`) — canvas hover-mute + dual-empty-state e2e.
- **`088`** — corrected stale index (was verified-live 2026-07-17).

## Backlog (OPEN)

- **`105` — P5 + nits.** **P5** = the `⋯` row-action gutter menu (move single-row commands OUT of data cells — the owner's IA critique; keep the selection bar for bulk). **NEEDS OWNER GO** (restructures the row-command model). Plus 2 LOW nits (dedupe `siblingGroup`/`siblingsOfIn`; exclude `ctrlKey`), a systemic MEDIUM (multi-step DB mutations like `moveTier2Entry` aren't transaction-wrapped — consider PGlite transactions), and minor P1 polish (the sibling phantom stays anchored after the series-start row, not the newest sibling).
- **`099` remainder** — touch/tablet pan-zoom + node-drag (**manual-device**), optional label-tier-stable lock (LOW), axe extension.
- **`106` (new) — 100 refinements** — zoom-LOD child-core culling (edit-aware); nested-drill grandchild edge/position; presence + palette reach child cores. All non-blocking, none crash.

## Patterns (this run — reuse)

### Per-canvas store architecture (100)
- **Circular-init invariant (unlinted):** `canvasStores.ts` ↔ the 3 store modules are an import cycle, safe ONLY because the factories are hoisted `function` decls + `CanvasStores` is a type-only import (⚠️ comment atop the file). Never convert a factory to `const` arrow; never add a value import from canvasStores into the store modules.
- **`storeCanvasId` ≠ `canvasId`.** A child core's STORE instance is keyed by `storeCanvasId` (primary=undefined→DEFAULT; child=parentContextId); its arbitration/focus key + `data.canvasId` is a SEPARATE identity. The primary MUST resolve DEFAULT (never its real root id — diverges from presence/palette/fallback).
- **`releaseCanvasStores` is leak-safe because teardown only unsubscribes** (never `.setState()`). Release on explicit collapse/nav-reset only.
- **active-canvas mirrors active-lane:** co-mounted cores register identical `window` `c`/`v`/`d` handlers; gate each on `activeCanvas === coreKey` (set on focus).

### Architecture-tree keyboard (105)
- The sub-child bug was a **Tab-FALLTHROUGH** (native Tab → the Add-child `<button>`); fix at source (intercept Tab + `tabIndex=-1`), not a shortcut.
- **New grammar on a SHARED component MUST be opt-in** (Design/Foundation reuse EditableGrid: Enter=commit+down, native richtext Tab). `onEnterCreateSibling`/`richTextTabAdvances` gate it to Architecture.
- **Type-to-create (PhantomInput) beats create-then-edit** — nothing persists until a non-empty commit (no orphan rows), and it inherits the issue-069 double-Enter guard. (Review round 1 found create-then-edit produced orphan rows + a race.)
- **`moveEntry`** wraps the tested `moveTier2Entry`; one commandLog entry/gesture, undo re-enqueues (094 lesson), enqueue BOTH sibling groups + the moved row's `parentId`.
- **Tree ARIA:** a SR-only parallel `role="tree"` (not `role="treegrid"`, which remaps `<td>`→gridcell and breaks `getByRole('cell')`); `aria-level` on a plain `<tr>` is an axe violation.

### e2e
- A focus assertion reading `document.activeElement` in a ONE-SHOT `page.evaluate` FLAKES if focus lands in a `requestAnimationFrame` → use `expect.poll`.
- Seed canvas contexts via the register + **guided-compose `c`** (register is LOD-collapsed at fit-view zoom); `waitForStableViewport` before interaction.

## Non-negotiables & tooling
- **Deploy = push to `main`** → CI `verify` (tsc+lint+stylelint+vitest+full e2e incl. canvas `@dev-flag`, `retries:2`) → `deploy` via `workflow_run`. Watch `gh run watch <id> --exit-status` (background).
- **⚠️ MEMORY — this machine hit its ceiling this run.** >2 concurrent agents exhausts app memory; and after a long session even a SINGLE local Playwright e2e OOMs (exit 144). Mitigations that worked: constrain vitest workers (`npx vitest run --maxWorkers=2`); `pkill -9 -f vitest/vite/@playwright` + free memory between heavy runs; **serialize** (never run local e2e while a subagent is also running Playwright). If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated, so nothing broken ships).
- **eslint:** no `!`, `interface` over `type`, 0 errors (tolerated pre-existing warnings: `EditableGrid.tsx:1276`, `Canvas.tsx:178`, some server albAdapters). **Bundle:** `xyflow` OUT of main `index-*.js`. **Schema only via migrations.**
- **Subagents must NOT commit/push/add** — orchestrator reviews the diff, re-verifies, commits (`--no-verify` after verifying + explicit `git add`). **MANDATORY adversarial review** for any store/render/write-path touch. **Screenshot** user-facing changes. CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) = authoritative write-path check.

## Definition of done / next
Both big features (`100`, `105` core) are SHIPPED, CI-green, deployed, and `100`/`104` archived. Open backlog = `105` P5 (owner IA decision) + nits · `099` touch/axe · `106` 100-refinements. Per the standing directive: build the backlog (P5 needs an owner nod first) or await direction. Given the machine's memory state, a fresh session is best for the next heavy build.

---

*History (archived to `docs/issues/done/`): 084; 087–098; 089 (D1/D2/D3-graduation); 100; 101/102/103; 104; 088. OPEN: 099 (coverage done; touch/axe) · 105 (P0–P4 done; P5 owner-decision + nits) · 106 (100 refinements). Updated 2026-07-22.*
