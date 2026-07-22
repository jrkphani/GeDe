# HANDOFF — 2026-07-22 (100 + 105 + 106 all DONE & archived; 099 automatable tests shipped; 105-txn Phase 1 shipped, remainder → 107; OPEN: only 099-touch [manual] + 107)

**Long autonomous run under owner directives "sequence all open tasks and execute autonomously" → "continue" → "continue until done, use subagents."** Delivered TWO full features end-to-end: **`100` live-child-canvas-core** (all 5 phases A–E) and — from live owner UX feedback mid-run — the **`105` Architecture-tree keyboard grammar** (P0–P5, incl. the `⋯` row-action menu + both LOW review nits). Plus `104` resolved, `099`-coverage, `088` index corrected. **`100` + `104` are now ARCHIVED to `done/`**; `100`'s non-blocking refinements were filed as **`106`**. Nothing is mid-flight.

Every store/render/write-path change went through a mandatory `code-reviewer` pass; those reviews caught **12+ HIGH regressions pre-commit** — `main` never saw one.

Launch prompt for the next session: `docs/NEXT-ORCHESTRATOR.md`.

---

## Current state

HEAD: **`dc51894`**. This session (continuation of the prior run) shipped — all CI-`verify`-GREEN + DEPLOYED: **105 P1** phantom-anchor fix (`f72596c`), the full **106 trilogy** — ③ presence+palette→child-cores (`c90d787`), ② nested-drill grandchild positioning (`d132bb7`), ① zoom-LOD child-core culling (`3dfe87c`) — the **099 automatable a11y tests** (`6434752`), and **105-txn Phase 1** (`moveTier2Entry` atomic transaction, `dc51894`), plus doc housekeeping (`540e8cd`, archived 105). **106 is now archived → `done/`**; the 105-txn remainder (~20 more multi-write mutations) is filed as **107**. The prior run's `100`/`104`/`105` (`46c8bf3` and earlier) remain deployed. The 106 render wiring passed CI's full e2e each push (the mount-timing flake didn't recur this session). Canvas is the prod default (≥1024px + not data-saver); `WorkspaceSurface` is the fallback. Live URL: https://d1nzod71m3rz6x.cloudfront.net.

### What shipped THIS session (all CI-green + deployed)

- **`106` — live-child-core refinements, ALL 3 (SHIPPED & archived → `done/106-...md`).**
  - **③** (`c90d787`) presence's "selected" cue + ⌘K palette reach LIVE child cores (were default-instance-only). New `listCanvasStores()`; presence publishes the focus-active core's selection; palette drills a child hit to `contextPath:[parentContextId]`. Review caught a **CRITICAL** (see patterns) + a **HIGH** (zombie cue), both fixed pre-commit.
  - **②** (`d132bb7`) nested-drill grandchild positioning — satellite state → parent-aware `OpenSatellite[]`; pure `computeSatelliteLayout` anchors each core's column-x + edge to its PARENT core; cascade-collapse. Direct-child behavior byte-identical.
  - **①** (`3dfe87c`) zoom-LOD auto-culling → `CoreStub` when (not editing) AND (zoom<0.35 OR off-screen OR depth>2). Pure `domain/coreLod.ts`. **Stub-swap render-only, KEEP the store** (no `releaseCanvasStores` on demote → flash-free re-promote, no zombie hazard). Review found a **HIGH** (ring edit-gate decoupled from register) → fixed with a shared `coreEditing` store (register writes imperatively, ring reads).
- **`105` P1** (`f72596c`) sibling phantom follows the newest sibling through an Enter series. Review HIGH: guard the re-anchor against a late-resolving create resurrecting a dismissed phantom (deterministic gated-promise test); MEDIUM: return the promise so the double-Enter guard gates on the DB round-trip.
- **`105`-txn Phase 1** (`dc51894`) `moveTier2Entry` wrapped in one `db.transaction` — atomic reparent+resort. `Tx`/`Querier` exported from `client.ts`; store layer UNCHANGED (outbox is in-memory, enqueued after the mutation resolves). DB-reviewer APPROVE (falsifiability-verified rollback). Remaining 20 mutations → **107**.
- **`099` tests** (`6434752`) per-lane canvas axe scans (Foundation/Architecture) + landmark/focus-order + deterministic `expect.poll` focus-settle + label-tier lock. E2E-only; CI-validated (local Playwright OOMs).

### What shipped (prior run — all CI-green + deployed)

- **`100` — live child-canvas core, ALL 5 PHASES (SHIPPED & archived → `done/100-...md`).** Drilling ("Open ▸") a child mounts a LIVE {register+ring} core editable in place beside its live, INDEPENDENT parent.
  - **A** (`be33140`) — `src/store/canvasStores.ts`: `createCanvasStores(canvasId)` factory + registry (`getCanvasStores`/`releaseCanvasStores`) + default-instance shims. Store bodies → hoisted `createXStore()` factories; per-instance `syncUnsubscribe`; sibling reads → `getStores().use*`. `parameters` stays global. Zero behavior change.
  - **B** (`f5b6420`) — `CanvasStoresContext` (`CanvasStoresProvider`/`useCanvasStores`) + `resolveCanvasStores(canvasId?)`; ~57 call-sites routed through the resolved `stores`. Byte-identical.
  - **C** (`6af0754`) — `src/store/activeCanvas.ts`: `c`/`v`/`d` verbs gate on `activeCanvas === coreKey`. Single-core inert.
  - **D** (`51852e6`) — namespaced live `{register+ring}` per child (`${id}:${parentContextId}`; PRIMARY keeps bare ids), `storeCanvasId=parentContextId` → own instance (primary → default); collapse/nav-reset → `releaseCanvasStores` (leak-free). Removed the dead SatelliteNode stub + `Enter ▸`. RED-first two-core independence e2e + screenshot.
  - **E** (`8314e92`, no code) — tier2 promote root-stamps by construction (`mutations.ts:1836`); DesignSurface never co-mounts; presence/palette stay root (→ 106).
- **`105` — Architecture-tree keyboard, P0–P5 + both LOW nits (COMPLETE; only a systemic txn MEDIUM + minor P1 polish remain).**
  - **P0** (`510ac53`) kill the sub-child **Tab-fallthrough** (intercept Tab in the description richtext + `tabIndex=-1` on Add-child). **P1** Enter = new-sibling series (type-to-create phantom). Both via Architecture-scoped opt-in seams (`richTextTabAdvances`, `onEnterCreateSibling`) → Design/Foundation byte-identical.
  - **P2/P3** (`2fe39b1`) `⌘]`/`⌘[` promote/demote + `⌥⇧↑/↓` move, via a `moveEntry` store action over the tested `moveTier2Entry` (one undo/gesture, complete sync-enqueue, focus-follows, `e.repeat` guard).
  - **P4** (`4d0af2a`) tree ARIA — a SR-only `role="tree"` of `role="treeitem"`s (`aria-level`/`aria-expanded`, off the `<tr>` to stay axe-clean; promote `role="option"` listbox preserved) + aria-hidden `⏎`/`⌘]`/`⌘[` KeyHint chips. `EditableGrid` byte-identical.
  - **P5** (`4bade78`) the `⋯` row-action gutter menu — every single-row verb (Add child · Add sibling · Promote · Make child · Move up/down · Remove) consolidated into ONE row-hover menu (mirrors AppShell `ProjectMenu`: `Popover` + `.menu`), replacing the per-cell Add-child button; bulk Remove stays on the selection bar. A POINTER TWIN of the chords, not a 2nd path: `handleTreeKey`'s targets refactored into pure `demoteTarget`/`promoteTarget`/`moveTarget` driving BOTH chords + menu (a `null` target → DISABLED item; every verb routes the one `runMove`/`handleDelete` → one undo/announce). Trigger `tabIndex=-1` (preserves P0 + `?d3rf` cross-node Tab). CSS scoped under `.t2-row-menu` (AppShell menus byte-identical); `siblingsOfIn` memoized. `EditableGrid`/store/mutations byte-identical. Adversarial review: 0 crit, logic APPROVED; 3 HIGH (all test-migration: d3-canvas add-child, hover-before-tabindex, project-open click landed on the row's nested Archive → left-edge click) + 3 MEDIUM + 2 LOW all fixed. New open-menu axe scan green.
  - **nits** (`46c8bf3`) both LOW review nits cleared: (1) sibling-group logic deduped into ONE canonical `siblingsOf`/`groupSiblingsBySort` in `src/domain/entryTree.ts` — consumed by `tier2.moveEntry`'s sort-delta enqueue, `buildEntryTree`, AND the surface's per-render memo (the store's local `siblingGroup` deleted; `db/mutations.ts` keeps its own module-private twin, left as-is to avoid a domain↔mutations value cycle); (2) the tree chords now exclude `e.ctrlKey`. New domain agreement tests; adversarial review APPROVE (0 findings).
- **`104`** (`85a5e47`, **archived → `done/104-...md`**) — 4 edge regression tests + rAF-invariant comment; empty-space fork DECIDED leave-as-is.
- **`099` coverage** (`8cc03d2`) — canvas hover-mute + dual-empty-state e2e.
- **`088`** — corrected stale index (was verified-live 2026-07-17).

## Backlog (OPEN) — 2 items, both non-blocking

- **`107` (new, from 105) — transaction-wrap the remaining ~20 multi-step mutations.** Phase 1 (`moveTier2Entry`) shipped; Phases 2–5 (subtree/promote · reorder-family · cascades · binding/param) are **mechanical repeats of the proven, reviewed pattern** in `docs/issues/107-...md`. Each phase: RED-first rollback test + DB/code review + CloudWatch check.
- **`099` remainder — MANUAL-ONLY.** Just touch/tablet pan-zoom + node-drag on a real coarse-pointer device (cannot be automated). All automatable a11y/coverage items are shipped.
- **`106` follow-ups (minor, tracked in its done-row):** grandchild breadcrumb trail is shallow (nav-display only); no WorkspaceCanvas render-path unit harness (LOD/positioning wiring is CI-e2e-covered only).

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

### Child-core refinements (106) — reuse
- **⚠️ `activeCanvas` is NOT a store-instance key (the 106-③ CRITICAL).** `WorkspaceCanvas` sets `activeCanvas` from `data.canvasId`, which for the PRIMARY core is `route.canvasId` — the **090 multi-root-canvas** id, NOT `'root'`/`parentContextId`. To resolve the active core's store instance, do a **non-creating registry membership check** (`listCanvasStores().find(s => s.canvasId === activeCanvas)`); any unregistered key → DEFAULT. Never `resolveCanvasStores(activeCanvas)` blindly — it would `getCanvasStores(rootCanvasId)` and **leak a phantom empty instance**.
- **Releasing the active core must reset the arbiter** (`resetActiveCanvas`) or presence stays bound to the released "zombie" store (teardown only unsubscribes, never resets state). Both `onSatelliteCollapse` + the nav-reset effect do this.
- **LOD demote = stub-swap render-only; KEEP the store** (never `releaseCanvasStores` on demote — that's collapse/nav-reset only). Flash-free re-promote, no zombie hazard.
- **Cross-node coupled state (register↔ring) needs a shared store, not a local ref** — they're separate React Flow nodes with no shared parent. But the WRITER (register) must write imperatively via `getState()` (non-subscribing) to avoid a re-render-on-focus that cancels click-to-edit; only the READER (ring) subscribes.
- **`data-label-tier` is zoom-invariant** (derived from ResizeObserver `contentRect`, not RF `transform: scale()`) — the 099-2c contract.

### Write-path transactions (105 / 107)
- **Multi-write mutation atomicity = wrap in `db.transaction(async tx => …)`** (drizzle/pglite; precedents in `sync.ts`/`projectIO.ts`/`invitations.ts`). Intra-callback reads/writes use `tx` (see uncommitted state); the not-found pre-read + authoritative final read run on `db` (final one AFTER commit). Widen touched helpers `Database → Querier` (`= Database | Tx`, exported from `client.ts`; `Database` is assignable, so callers don't break).
- **Do NOT put the outbox enqueue inside the txn** — it's an in-memory Zustand queue (`enqueueIfSyncing`), not a PGlite write, so a rollback can't revert it. It already runs in the STORE layer *after* the mutation resolves, so a rejected mutation skips enqueue+commandLog. **The store layer never changes.**
- **RED-first rollback proof**: a Proxy `db` that throws on the Nth `.update()` → assert full rollback (re-read via the REAL db == snapshot). Falsifiability-check by stashing the txn out (test must fail).

### e2e
- A focus assertion reading `document.activeElement` in a ONE-SHOT `page.evaluate` FLAKES if focus lands in a `requestAnimationFrame` → use `expect.poll`.
- Seed canvas contexts via the register + **guided-compose `c`** (register is LOD-collapsed at fit-view zoom); `waitForStableViewport` before interaction.
- **Opening a project = click the row's LEFT edge.** The `.project-row` is a `role="button"` ("Open X") that CONTAINS the "Archive X" button at its right; a default `.click()` targets the geometric CENTER, which can land on Archive (→ the project archives instead of opening, silently failing the whole setup). `setup105Tree` clicks `{ position: { x: 8, y: 8 } }`. Also assert a `visibility:hidden` reveal-on-hover control only AFTER `.hover()` (it's out of the a11y tree until then).
- **The Design canvas child-core specs (100-D, e.g. `d3-canvas.spec.ts:930`) are mount-timing flake-prone under full-suite CI contention.** `retries:2` usually absorbs it, but occasionally all 3 attempts lose under load; it passes solidly in isolation. On a red `verify` whose ONLY failure is such a `@dev-flag` canvas `toBeVisible` timeout on a code path your diff didn't touch: reproduce that one spec locally (green = flake) then `gh run rerun <id> --failed`. Deploy is verify-gated, so a flaked run just doesn't deploy — nothing broken ships.

## Non-negotiables & tooling
- **Deploy = push to `main`** → CI `verify` (tsc+lint+stylelint+vitest+full e2e incl. canvas `@dev-flag`, `retries:2`) → `deploy` via `workflow_run`. Watch `gh run watch <id> --exit-status` (background).
- **⚠️ MEMORY — this machine hit its ceiling this run.** >2 concurrent agents exhausts app memory; and after a long session even a SINGLE local Playwright e2e OOMs (exit 144). Mitigations that worked: constrain vitest workers (`npx vitest run --maxWorkers=2`); `pkill -9 -f vitest/vite/@playwright` + free memory between heavy runs; **serialize** (never run local e2e while a subagent is also running Playwright). If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated, so nothing broken ships).
- **eslint:** no `!`, `interface` over `type`, 0 errors (tolerated pre-existing warnings: `EditableGrid.tsx:1276`, `Canvas.tsx:178`, some server albAdapters). **Bundle:** `xyflow` OUT of main `index-*.js`. **Schema only via migrations.**
- **Subagents must NOT commit/push/add** — orchestrator reviews the diff, re-verifies, commits (`--no-verify` after verifying + explicit `git add`). **MANDATORY adversarial review** for any store/render/write-path touch. **Screenshot** user-facing changes. CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) = authoritative write-path check.

## Definition of done / next
`100`, `104`, `105`, and `106` are all SHIPPED, reviewed, deployed, and **archived to `done/`**. `105`'s residuals are resolved (P1 polish shipped; txn Phase 1 shipped). `099` is down to its single **manual-device** item (touch/tablet). HEAD `dc51894` is verify-green + deployed. **Open backlog = just `107` (105-txn Phases 2–5, mechanical repeats) + `099`-touch (manual).** Next session: pick up `107` (the pattern + phasing are fully specced in `docs/issues/107-...md`) — or await direction. Given the machine's memory state (this was a long session), a fresh session is best for the `107` phases; run local unit tests with `--maxWorkers=2` and lean on CI for e2e.

---

*History (archived to `docs/issues/done/`): 084; 087–098; 089 (D1/D2/D3-graduation); 100; 101/102/103; 104; 105; 106; 088. OPEN: 099 (touch/tablet MANUAL only) · 107 (txn-wrap Phases 2–5). Updated 2026-07-22.*
