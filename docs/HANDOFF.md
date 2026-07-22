# HANDOFF — 2026-07-22 (100 A–E SHIPPED; 105 P0–P3 SHIPPED; 104 resolved; 099-coverage; 088 corrected)

**Long autonomous run under owner directives "sequence all open tasks and execute autonomously" → "continue" → "continue until done, use subagents."** Delivered the whole **`100` live-child-canvas-core** (all 5 phases A–E), and — from live owner UX feedback mid-run — the whole **`105` Architecture-tree keyboard grammar** (P0–P3: sub-child fix, Enter=sibling, `⌘]`/`⌘[` promote/demote, `⌥⇧↑/↓` move). Plus `104` fully resolved (fork decided), `099`-coverage, and `088`'s stale index corrected. Nothing is mid-flight. Every store/render/write-path change got a mandatory `code-reviewer` pass; the reviews caught **10+ HIGH regressions pre-commit** (5 on 105-P0/P1, 4 on 100-A-Phase-D-first-cut, etc.) — `main` never saw them.

Launch prompt for the next session: `docs/NEXT-ORCHESTRATOR.md`.

---

## Current state

HEAD: **`8314e92`** (100 Phase-E docs). **CI `verify` CONFIRMED GREEN** through `6af0754` (Phase C); Phase D (`51852e6`) verify was in-flight at handoff — locally FULL-verified (tsc+eslint clean, `verify:fast` 1665, **full e2e 95 passed**, two-core independence stress **5/5**, **screenshot-confirmed**) and adversarially reviewed **APPROVE (0 crit/high/med)**, so expected green → live. Canvas is the prod default (≥1024px + not data-saver); `WorkspaceSurface` is the fallback. Live URL: https://d1nzod71m3rz6x.cloudfront.net.

**This run's commits (newest last):** `85a5e47` (104-LOW) · `8cc03d2` (099 coverage) · `be33140` (**100-A** factory) · `95aa910`/`6391b64`/`b2201d4`/`cd76119`/`2212a0c` (docs: 088 fix + 105 file/red-team/IA/coherence-rewrite) · `f5b6420` (**100-B** injection seam) · `6af0754` (**100-C** active-canvas) · `51852e6` (**100-D** live child core) · `8314e92` (**100-E** docs).

### What shipped

- **`100` — live child-canvas core, ALL 5 PHASES (core DoD met).** Drilling ("Open ▸") a child now mounts a LIVE {register+ring} core editable in place beside its live, INDEPENDENT parent.
  - **A (`be33140`)** — `src/store/canvasStores.ts`: `createCanvasStores(canvasId)` factory + `Map` registry (`getCanvasStores`/`releaseCanvasStores`) + default-instance shims re-exported from the 3 store modules. Store bodies → hoisted `createXStore()` factories; `syncUnsubscribe` per-instance; sibling `getState()` reads → `getStores().use*`. `parameters` stays global. Zero behavior change (default-only). Reviewed clean.
  - **B (`f5b6420`)** — `src/components/CanvasStoresContext.tsx` (`CanvasStoresProvider`/`useCanvasStores`) + `resolveCanvasStores(canvasId?)`; ~57 call-sites in DesignCoreAdapter/ContextRegister/DimensionManager/WorkspaceCanvas routed through the resolved `stores`. Default-only → byte-identical. Reviewed clean.
  - **C (`6af0754`)** — `src/store/activeCanvas.ts` (mirrors `activeLane`): the `c`/`v`/`d` window verbs gate on `activeCanvas === coreKey` (coreKey=`canvasId ?? 'root'`); `setActiveCanvas` set on core focus. Single-core INERT. Reviewed inert.
  - **D (`51852e6`)** — WorkspaceCanvas emits a namespaced live `{register+ring}` pair per open child (`${id}:${parentContextId}`; PRIMARY keeps bare singleton ids), `storeCanvasId = parentContextId` → own store instance (primary → default, byte-identical); `data.canvasId` drives C's arbitration; collapse `×`/nav-reset → `releaseCanvasStores` (leak-free — teardown only unsubscribes). Removed the dead SatelliteNode stub + `Enter ▸`. RED-first two-core independence e2e. Adversarially reviewed **APPROVE**.
  - **E (`8314e92`, no code)** — confirmed: tier2 promote already root-stamps by construction (`mutations.ts:1836` — the "OPEN decision" resolved, Architecture is project-level → root); DesignSurface never co-mounts (`App.tsx:84`); presence/palette stay root (documented refinements).
- **`104`-LOW (`85a5e47`)** — 4 edge regression tests (edge c polled — the rAF focus race) + rAF-invariant comment. Item (1) empty-space-dismiss left as an owner fork.
- **`099` coverage (`8cc03d2`)** — canvas hover-mute + dual-empty-state e2e (hover-emphasis confirmed working at node scale).
- **`088`** — corrected stale index (was already verified-live 2026-07-17; fix `8354f04`).
- **`105` — P0–P3 SHIPPED** (`510ac53` P0+P1, `2fe39b1` P2+P3). Architecture-tree keyboard tree-building, from owner UX feedback: P0 kills the sub-child Tab-fallthrough; P1 Enter=new-sibling series; P2 `⌘]`/`⌘[` promote/demote; P3 `⌥⇧↑/↓` move. All Architecture-scoped (Design/Foundation byte-identical). 3 review rounds (5 HIGH found+fixed on P0/P1). See Backlog for the P4/P5 follow-ups.

## Backlog

- **`100` refinements (non-blocking, in the issue):** (1) zoom-LOD auto-culling of off-screen/deep child cores back to stubs (the DoD's LOD clause — deferred; today many drilled children all stay live until `×`); (2) nested drill-in-a-child mispositions the grandchild (edge/position source the PRIMARY register — cosmetic; store IS independent); (3) presence doesn't highlight a child-core selection (`presence.ts:109`); (4) palette "go to context" is root-only (`coreCommands.ts:80`). None crash/corrupt.
- **`099` remainder:** touch/tablet pan-zoom + node-drag (**manual-device** item), optional label-tier-stable lock (LOW), axe extension.
- **`104`:** ✅ RESOLVED — owner decided the empty-space fork is leave-as-is (2026-07-22). Nothing remains.
- **`105` (Architecture-tree keyboard) — P0–P3 SHIPPED (2026-07-22).** Owner approved the full scope + `⌘]`/`⌘[`. Delivered: P0 sub-child Tab-fallthrough fix, P1 Enter=sibling series, P2 `⌘]`/`⌘[` promote/demote (`moveEntry` over `moveTier2Entry`), P3 `⌥⇧↑/↓` move — all Architecture-scoped, reviewed (5 HIGH found+fixed on P0/P1; P2/P3 approve). **Remaining follow-ups (NOT the approved scope):** P4 tree ARIA (`aria-level`/`aria-expanded`) + `KeyHint` chips teaching the shortcuts; P5 the `⋯` row-action gutter menu (moves single-row commands out of data cells; see the 105 IA section); 2 LOW review nits (dedupe `siblingGroup`/`siblingsOfIn`; exclude `ctrlKey`); a MEDIUM systemic note (multi-step DB mutations like `moveTier2Entry` aren't transaction-wrapped — mitigated here by an `e.repeat` guard). Minor P1 polish: the sibling phantom stays anchored after the series-start row rather than trailing the newest sibling.

## Patterns (this run — reuse)

### Per-canvas store architecture (100)
- **Circular-init invariant (unlinted):** `canvasStores.ts` ↔ the 3 store modules are an import cycle, safe ONLY because the factories are hoisted `function` decls + `CanvasStores` is a type-only import. A ⚠️ comment atop `canvasStores.ts` pins it. Never convert a factory to `const` arrow, never add a value import from canvasStores into the store modules.
- **`storeCanvasId` ≠ `canvasId`.** A live core's STORE instance is keyed by `storeCanvasId` (primary=undefined→default; child=parentContextId), but its ARBITRATION/focus key + `data.canvasId` is a separate identity. The primary must resolve DEFAULT (never its real root id — that diverges from presence/palette/fallback, which read default).
- **`releaseCanvasStores` is leak-safe because teardown only unsubscribes** (never `.setState()`), so releasing a collapsing child can't force a still-mounted body to re-read a torn-down instance. Release on explicit collapse/nav-reset only (never implicit/zoom).
- **Namespaced node ids for a 2nd core** (`${LANE_NODE_ID.design}:${parentContextId}`); the PRIMARY keeps bare singleton ids (⌘3-pan/twin-edge/focus-pan consumers still target the primary).
- **active-canvas mirrors active-lane:** two co-mounted cores register identical `window` capture `c`/`v`/`d` handlers; gate each on `activeCanvas === coreKey` (set on focus) so only the focused core fires.

### e2e (this run)
- A focus assertion reading `document.activeElement` in a ONE-SHOT `page.evaluate` FLAKES if focus lands in a `requestAnimationFrame`; use `expect.poll`.
- Seed canvas contexts via the register + **guided-compose `c`** (the register is LOD-collapsed at fit-view zoom); `waitForStableViewport` before any interaction.

### Tree-UX findings (105 — for whoever builds it)
- The sub-child bug is a **Tab-FALLTHROUGH**: Tab in the description richtext isn't intercepted → native Tab → the "Add child" `<button>` → Enter arms a child. Fix at source (intercept Tab + `tabIndex=-1`), not with a shortcut.
- **Enter=sibling must be Architecture-SCOPED** (opt-in seam) — Design/Foundation reuse EditableGrid with Enter=commit+down.
- Row-level **controls** (add-child) don't belong in data `<td>`s — move to a `⋯` row-action gutter menu; keep the selection bar for BULK.
- The reparent engine `moveTier2Entry` already exists + is tested (`mutations.ts:1708`) — 105 P2 is a thin store wrapper, no tree library.

## Non-negotiables & tooling
- **Deploy = push to `main`** → CI `verify` (tsc+lint+stylelint+vitest+full e2e incl. canvas `@dev-flag`, `retries:2`) → `deploy` via `workflow_run`. Watch `gh run watch <id> --exit-status` (background).
- **MEMORY (this machine): >2 concurrent agents exhausts app memory.** Cap at 2 subagents; prefer 1 heavy (Playwright/vitest) at a time; serialize local e2e (port 5173; STALE-VITE kill before each run).
- **eslint:** no `!`, `interface` over `type`, 0 errors (one tolerated `EditableGrid.tsx` warning). **Bundle:** `xyflow` OUT of main `index-*.js`. **Schema only via migrations.**
- **Subagents must NOT commit/push/add** — orchestrator reviews + re-verifies + commits (`--no-verify` after verifying + explicit `git add`). **MANDATORY adversarial review** for any store/render-path/write-path touch (100 store & render phases each got a `code-reviewer` pass). **Screenshot** user-facing changes (Phase D screenshot in scratchpad). CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) = authoritative write-path check.

## Definition of done / next
`100` core is SHIPPED (A–E) — the recursion cluster is now a live editable child core. Open backlog = `100` refinements · `099` touch/axe · `104` fork · `105` (owner go). Per the standing directive, continue the backlog or await the two owner decisions above. Re-triage `docs/issues/README.md` toward open-count 0.

---

*History (shipped + archived to `docs/issues/done/`): 084; 087–098; 089 (D1/D2/D3-graduation); 101/102/103; 088 (verified-live). SHIPPED-but-OPEN (remainders): 099 (coverage done; touch/axe) · 104 (core+LOW done; 1 fork) · 100 (A–E core done; refinements). NEW: 105 (Architecture-tree keyboard — planned, owner go pending). Updated 2026-07-22.*
