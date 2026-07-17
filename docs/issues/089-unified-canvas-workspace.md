# 089: Unified canvas workspace — three tiers as one zoomable canvas + a global rich-text toolbar

- **Status**: **D1 SHIPPED** (2026-07-17) — the global rich-text toolbar is merged to `main` and deploying (frontend-only + a value-gated heal-on-load; **no schema migration**). **D2 SHIPPED** (2026-07-17) — the three tiers now render as side-by-side vertical lanes on one page (frontend + store changes; **no schema migration**), merged to `main` and deploying. **D3** (pan/zoom canvas) and **rich identifier columns** remain **OPEN**. See `## D1 — SHIPPED (implementation notes)` and `## D2 — SHIPPED (implementation notes)` below. The rest of this doc is the design cycle that must precede any *zoom* canvas implementation (mirrors how 085 got a full spec before a line changed).
- **Milestone**: post-M6 (call it **M7 — workspace unification**). No sync/infra blocker for the toolbar half (D1 — now shipped); the zoom-canvas half is the largest client-side surgery the app has attempted and should be gated behind a spike (see Recommended sequencing). This supersedes nothing yet — it *proposes* to partially supersede the tier-tab routing model (SITEMAP §1) and re-open a tension 085 explicitly closed (canvas-as-visual). Both are named honestly below.

## D1 — SHIPPED (implementation notes)

**Shipped 2026-07-17** — the global rich-text toolbar (the vision's second half) is merged to `main` and deploying. Commits: `feat(089-D1)` phases 1-5 + `fix(089-D1)` P6 (latest `ded2ff4`). **No schema migration** (the target columns were already `text`; migration count untouched). **Verify:fast 1424 tests + full e2e 51/0.**

### What landed
- **A global `FormatStrip`** (`src/components/FormatStrip.tsx`) in the context bar, bound to whichever rich editor is focused via a **focused-editor registry** (`src/store/focusedEditor.ts`). Focus-reveal: the band appears when a rich editor takes focus, no always-on chrome (a softer read than a permanent format band, keeping the drafting-table restraint).
- **Every PROSE field is now rich**: `tier1_purpose.body` (Purpose is now a standalone `RichTextEditor`, like existing-scenario, replacing the old `MultilineEdit`), `tier1_props.description`, `tier2_entries.description`, and `contexts.justification` (a new **`richtext` `EditableGrid` cell kind** with an explicit escape grammar — **Cmd+Enter = commit-down**, **Esc = revert**, **Tab stays out** — so a Lexical editor swallowing Enter/Tab no longer breaks the Numbers grammar).
- **A plain↔Lexical bridge** (`src/domain/richText.ts`: `richTextToPlainText` / `plainTextToRichJson`) plus the repaired search/status consumers of justification (they now extract plain text from the Lexical state rather than reading the raw string).
- **A repeatable, value-gated heal-on-load** (`src/store/richTextConvert.ts`, wired in `DesignSurface`): converts legacy plain-string prose to Lexical JSON on project open, `op='update'`, idempotent, **bypasses the command log**, and **re-heals** cells that an un-upgraded peer clobbers back — because LWW is **value-blind** and would otherwise let an old client overwrite the converted value with plain text again.

### Owner's locked choices (the forks D1 resolved)
- **Toolbar form: persistent context-bar strip** (fork 2), not a selection popover — most discoverable, no transform math, and it drops straight into the existing context bar. Realized as focus-reveal rather than always-on.
- **Back-compat: a one-time convert, realized as a *repeatable* value-gated heal** (fork 3), *not* the display-only fallback the original doc recommended. The convert had to become repeatable precisely because LWW is value-blind (an un-upgraded peer re-clobbers), so a one-shot migration would silently regress; the heal re-converts on every load until every peer is upgraded.
- **Which fields: prose now, identifiers deferred** (fork 4) — all four prose columns are rich; the `*.name` / `contexts.symbol` identifier columns are **deferred pending an owner decision** (see below).

### Corrections the build proved vs the original doc
The build confirmed three things the doc's plan had already flagged as likely, plus surfaced one it hadn't:
1. **No migration needed** — the columns were already `text`, so Lexical JSON fits with zero schema change (the plan predicted this; the build confirmed it — migration count untouched).
2. **`contexts` has no `name` column** — only `justification` is the rich target on the Design grid (the "make every cell rich" framing over-reached; there was no name cell to convert).
3. **Only `justification` was actually searched** — the search/semantic consumers touched justification, not every description, so the plain-text-extraction repair was scoped to it.
4. **The strip's auto-bind had an effect-ordering bug** (surfaced by the pre-push gate, not the plan/tests): the strip failed to auto-bind on grid cells because of effect ordering; **fixed by having the registry reconcile the currently-active editor** on register rather than relying on the focus event alone. The gate also caught two smaller misses the plan/tests didn't: a hardcoded `"Add justification…"` placeholder, and 4 e2e specs still driving justification as a `<textarea>`.

### Identifier columns — deferred, owner decision pending
Making `*.name` / `contexts.symbol` rich is **hazardous** and is intentionally left out of D1:
- They feed the **duplicate-detection tuple hash** — any comparison site would need plain-text extraction *everywhere* they're compared, or the hash silently changes for identical-looking values.
- The `InlineEdit` callers (`DimensionManager`, `ParameterList`) **lack `readOnly` threading**, so a rich variant can't cleanly express a read-only state there without new plumbing.
- **Recommendation:** keep identifiers **plain**, OR — if a rich identifier is truly wanted — introduce a **lists/indent-disabled, single-line-rich variant** (no block formatting, no newline) so identifiers stay hashable and single-line. This is an explicit owner call, not a D1 follow-through.

## D2 — approved implementation plan (2026-07-17)

> Code-grounded, owner-approved plan for **Direction D2 (single lane page)** so a future session can execute it. This supersedes the framing in `### D2 — One scrollable page…` below where the two differ — the key difference is called out first. D1 (shipped) is unaffected.

### Key correction vs the doc's D2 framing

**Do NOT collapse the route grammar.** Keep `/p/:id/foundation|architecture|design[/:ctx…]?view=…&canvas=…` exactly as `routes.ts:32-103` parses today — it carries Design's `contextPath` / `view` / `canvasId` state that **011** (recursion), **012** (coverage), and **090** (shipped `canvases` + `?canvas=` switcher) and their e2e all depend on.

D2 changes only **WHAT the route mounts**: one `WorkspaceSurface` rendering all three lanes, instead of `App.tsx:41-86`'s switch picking a single surface. It **ADDS** a scroll-to-lane effect keyed on the route. Tabs + ⌘1/2/3 still `navigate()` (preserving back/forward + `tab--active`) and merely *also* scroll. This is the minimal reading of fork 8 and shrinks the e2e blast radius.

### Two settled tensions

- **"Page never scrolls"** (`SITEMAP.md:34` — the doc body cites `:32`, now stale): the fixed app-bar / context-bar / status-bar chrome is preserved; the single existing `.surface` scroll region (`base.css:252-255`) now hosts three co-scrolling lanes (horizontal at narrow widths). This is a **deliberate SITEMAP §2 spec change**.
- **Does NOT re-open 085.** D2 adds **zero** on-ring authoring; the Design lane keeps its `[editing-zone | canvas]` layout (`DesignSurface.tsx:645-713`). The 089-doc "stack register over ring" idea is a **D3** concern, out of scope for D2.

### Fork resolutions

| Fork | Resolution |
|---|---|
| **Fork 6** (one plane vs three scrolls) | **ONE shared page scroll** (the existing `.surface`); lanes are non-stretching flex columns. Lane-local scroll rejected — nested-scroll traps fight `EditableGrid` + capture-phase handlers. |
| **Fork 8** (routes as deep-links) | **Keep all 3 routes** as scroll-to-lane deep-links via a pure `laneForRoute(route)`. |
| **Fork 9** (cross-lane keyboard) | **Independent per-lane Tab scopes** + ⌘1/2/3 as the explicit "go to lane" key; no continuous cross-lane Tab chain. |
| **Context bar** | **PER-LANE STICKY HEADERS.** The single `.context-bar` slot in `slots.tsx` can't host three tiers' bars — Design's (`DesignSurface.tsx:522-591`) and Architecture's (`ArchitectureSurface.tsx:52-69`) would jumble. The shell `.context-bar` band hosts only the global `FormatStrip` (focus-revealed). |

### Phases (≤5 files each, red-first)

**P1 — mount all three lanes on one route**
- NEW `src/components/WorkspaceSurface.tsx` — 3 lanes in a `.workspace` flex row; passes Design its `contextPath` / `view` / `canvasId`.
- `src/App.tsx` — route project / tier / design → `WorkspaceSurface`; keep the `lastTierRoute` redirect.
- `src/styles/base.css` — `.workspace` row + lane framing; neutralize `.foundation` max-width (`:1721-1724`) and `.architecture` (`:2161-2164`) inside a lane.
- NEW `e2e/workspace.spec.ts`.
- **Red:** all three tier headings + the Design editing-zone visible on **one** URL.
- Note: all load effects (tier1, tier2 ×2, canvases, dimensions, contexts, parameters, `healRichTextOnLoad`) are idempotent / projectId-keyed — **no orchestration rewrite**.

**P2 — scroll-to-lane deep-links**
- NEW `src/shell/laneTarget.ts` (`laneForRoute`) + test.
- `src/App.tsx` — scroll-to-lane effect.
- `AppShell.tsx` — tabs + ⌘1/2/3 still `navigate()` (now *also* scroll).
- `shell.test.tsx` — adjust.
- Keeps `shell.spec` `goBack` / `goForward` + `tab--active` + command-palette tier-jump green.

**P3 (the hard part) — scope Design's global handlers to the active lane**
- NEW `src/store/activeLane.ts` slice (mirror `focusedEditor.ts`).
- `WorkspaceSurface` sets `activeLane` on each lane's `focusin` / `pointerdown` + ⌘1/2/3.
- Gate Design's global handlers: `c` (`DesignSurface.tsx:311-328`), `v` (`:353-375`), `d` (`:384-406`) → gate on `activeLane === 'design'`.
- `Esc` (`:338-349`) keep as-is (already `composeContextId`-gated); `Tab` seam (`:426-448`) no change (self-scopes via unique `.dim-rail`).
- **Behavior flag:** with no lane active, `c` / `v` / `d` are no-ops until a lane is focused / ⌘3'd.
- **Red:** `c` from the Foundation lane does NOT create a Design draft; from the Design lane it does.

**P4 — per-lane sticky context headers + narrow reflow**
- Move Design's `ContextBar` (`:522-591`) + Architecture's `ContextBar` (`:52-69`) into in-lane sticky headers.
- `base.css` — `.workspace__lane-header { position: sticky; top: 0 }` + a `<1024px` reflow from 3-col row to stacked column (⌘1/2/3 scroll-to-lane becomes load-bearing).
- Shell context bar now shows **only** `FormatStrip`.
- **Red:** Design breadcrumbs / switcher / coverage AND Architecture quick-jump visible simultaneously in their lanes; `FormatStrip` still binds on rich-editor focus in any lane. **Screenshot-verify.**

**P5 — Rule-12 e2e/unit sweep**
- Most (~18) `getByRole('link', { name: 'Design' })` setups + URL / `tab--active` assertions keep passing (routes retained).
- Real work = strict-mode selector collisions now that 3 surfaces co-mount → scope queries to a lane container (e.g. `.workspace__lane--design`).
- Sub-batches:
  - **5a** selector scoping (`canvas*` / `dimensions` / `parameters` / `coverage` / `context-register` / `recursion` specs).
  - **5b** genuine URL/history (`shell.spec`, `recursion.spec:77-137`, `canvas-switcher.spec:19,52`, `projects.spec:20`, `sync-status.spec:23`).
  - **5c** unit + palette (`shell.test.tsx:64-72`, `command-palette.spec:40-49`).
- **Gate:** full `verify:fast` (1424 unit) + full e2e (D1 baseline **51/0**).

### Risks & open sub-decisions (owner)

1. **Shared lockstep scroll** — a short lane trails whitespace. Ship it; revisit only if it bites.
2. **`activeLane` null** → `c` / `v` / `d` are no-ops until a lane is active (vs defaulting to Design).
3. **`v` from another lane** navigates + scrolls to Design.
4. **`DesignSurface` null render-gate** (`:509`) → Design lane briefly empty; maybe hoist a skeleton.
5. **tier2 double-load** — cosmetic, idempotent.
6. **Narrow breakpoint value** + always-show tab bar in stacked mode.
7. **Strict-mode e2e collisions** — the largest effort unknown until 5a.

### SITEMAP sections to update in lockstep (§6: deviations are spec changes)

- **§1 route map** — routes retained as scroll-to-lane deep-links.
- **§2 shell anatomy** — nuance "page never scrolls"; context content → per-lane sticky headers; shell bar hosts only `FormatStrip`.
- **§4 keyboard** — ⌘1/2/3 = navigate + scroll; `c` / `v` / `d` active-lane-scoped.
- **§5 responsive** — 3-col → stacked breakpoint.

## D2 — SHIPPED (implementation notes)

**Shipped 2026-07-17** — the three tier routes now render as **side-by-side vertical lanes on one page**, merged to `main` and deploying. Commits: `feat(089-D2)` phases 1-5 (latest `6916024`). **Frontend + store changes — NO schema migration** (positions stay derived from the existing ordinal `sort`; migration count untouched). **`verify:fast` 1446 unit + full e2e 53/0.**

### What landed

- **One page, three lanes.** `src/components/WorkspaceSurface.tsx` renders all three tiers (Foundation / Architecture / Design) as non-stretching flex columns inside the shared `.surface` scroll region, replacing `App.tsx`'s single-surface switch. The three surfaces now co-mount in the DOM (previously only one was ever mounted).
- **Route grammar RETAINED** (the correction vs the exploratory D2 framing held). `/foundation|architecture|design[/:ctx…]?view=&canvas=` still parse / serialize and still drive `tab--active`. D2 changed only **WHAT the route mounts** and **ADDED a scroll-to-lane effect** (`src/shell/laneTarget.ts`, pure `laneForRoute`). Tabs + ⌘1/2/3 still `navigate()` (preserving back/forward + `tab--active`) and now *also* scroll to the lane. This kept 011/012/090 and most of the e2e suite intact.
- **`activeLane` slice** (`src/store/activeLane.ts`, mirroring `focusedEditor.ts`) re-scopes Design's capture-phase global verbs (`c` / `v` / `d`) to the active lane. It is set on each lane's `focusin` / `pointerdown` and by ⌘1/2/3; `Esc` and the Tab seam self-scope. **Behavior flag:** with no lane active, `c` / `v` / `d` are no-ops until a lane is clicked / ⌘'d — so a `c` from the Foundation lane does not create a Design draft.
- **Cross-lane reactive refresh** (`notifyLocalApply` in `src/store/sync.ts`, wired into `tier2.ts` promote / rename-propagate / resolve). A cross-tier write in one lane now refreshes the co-mounted Design lane — which no longer remounts — by bumping the same `*AppliedAt` signals the 075B subscriptions already watch. Offline-safe and respects 090 canvas-scoping.
- **Per-lane sticky context headers.** Each surface's context bar moved into an in-lane sticky header (Architecture's quick-jump; Design's breadcrumbs + the 090 `CanvasSwitcher` + view-toggle + coverage stats) — the single shell `.context-bar` slot can't host three tiers at once. The shell context bar now hosts **only** the focus-revealed D1 `FormatStrip`. **Narrow-screen reflow** at ≤1024px stacks the 3 columns (⌘1/2/3 scroll-to-lane becomes load-bearing there).

### Two real regressions caught by the full-e2e gate + fixed (not papered over)

1. **Export unclickable.** The sticky lane-header (`z-index: 5`) painted over the body-portaled Radix `.popover`, so Export couldn't be clicked → `.popover` z-index raised to 50 (above the header, below the command palette at 100).
2. **FormatStrip didn't bind on a justification cell's autoFocus.** React StrictMode's dev double-invoke unbound the editor → fixed in the autoFocus effect (order-independent, scoped) so the strip binds regardless of effect order.

### Fork resolutions (shipped answers)

- **Fork 6** (one plane vs three scrolls) — **RESOLVED: one shared page scroll** (the existing `.surface`); lanes are non-stretching flex columns, no lane-local scroll.
- **Fork 8** (routes as deep-links) — **RESOLVED: all 3 routes retained** as scroll-to-lane deep-links; the grammar was not collapsed.
- **Fork 9** (cross-lane keyboard) — **RESOLVED: independent per-lane Tab scopes** + ⌘1/2/3 as the explicit "go to lane" key; no continuous cross-lane Tab chain.
- **Context bar** — **RESOLVED: per-lane sticky headers**; shell bar hosts only `FormatStrip`.

### Known follow-up (not blocking)

- **Undo/redo of cross-tier ops has the same co-mount staleness** the reactive refresh fixed on the forward paths (promote / rename-propagate / resolve). The forward writes now refresh the co-mounted Design lane; the undo/redo paths of those same ops do not yet. Worth a later pass — it does not block D2 shipping.

## Vision (owner)

Merge GeDe's three separate routes — **Foundation** (Tier 1), **Architecture** (Tier 2), **Design** (Tier 3) — into **one open, zoomable canvas page**. Each tier is its own vertical **lane**; lanes sit side by side on an infinite grid canvas and **grow downward** as more tables/rows are added. The whole page **pans and zooms** — zoom into the section you want to focus on, zoom out for the overview — like Figma / Miro / tldraw, but with *structured table content* inside the lanes rather than free-floating shapes.

Additionally: a **single set of rich-text editing controls** — a popover near the selection, or a persistent topbar — available to **all editable text** in the tables across **all three tiers**. Today rich text exists in exactly one place: the Tier-1 "Existing scenario" panel (`FoundationSurface.tsx:187`).

## North star (the app's existing yardstick)

The same one 082/084/085 measure against, verbatim from `084:13`: **get the user to enter as much information as they like in the shortest time, entirely from the keyboard, on a surface that reads as one coherent instrument.** Plus the drafting-table identity (`STYLE_GUIDE.md:5`): a precision instrument, not a dashboard — *"the app never animates what it can simply do."* Every direction below is judged on: does it make bulk keyboard entry faster and more coherent, or does it add a spatial layer the user must manage before they can type?

This matters because **an infinite pan/zoom canvas is, at its core, a spatial-arrangement tool** — and `STYLE_GUIDE.md:16` principle 4 is *"Position is derived. Nothing on the canvas is draggable-to-mean-something. Selection, not arrangement, is the user's spatial verb."* The vision's "zoom to focus" is a *viewport* verb (legitimate, meaning-free) but the moment lanes are hand-placeable it collides with that principle. Keep the distinction sharp throughout.

## Decision (owner, 2026-07-16) — canvas substrate & positioning model

Resolved after the library research below (which had defaulted to "reject React Flow; use CSS-transform + a gesture lib"). The owner **overrides that default** with eyes open, and pins the positioning model so React Flow does NOT violate principle 4:

- **Engine: `@xyflow/react` (React Flow)** as the pan/zoom canvas — chosen for its batteries-included viewport (pan, zoom, minimap, controls, background grid) with **real-DOM nodes**, so `EditableGrid`'s inline editing + keyboard grammar survive inside a node. This offloads the drag/zoom "physics" (incl. drag-under-zoom coordinate math) to the library.
- **Positioning stays DERIVED (principle 4 preserved).** Tables are **NOT** freely placeable and we do **NOT** persist absolute `{x,y}`. Instead:
  - Keep the existing ordinal **`sort`** per table (**no schema change** — no position columns).
  - **Auto-layout** (dagre or elk) computes node positions into **three tier lane-columns**, ordered vertically by `sort` — lanes "grow downward" as tables are added.
  - **Node drag is constrained to its lane**; dragging a table up/down **reorders** the lane and persists the new `sort`. Reorder is the only meaning drag carries — position itself remains a pure function of (tier, sort).
- **Accepted tradeoff**: React Flow has no native auto-layout, so we bolt on dagre/elk + a constrained-drag handler (the research's "worst of both" caveat). The owner accepts this to keep React Flow's viewport chrome while honoring derived positioning. React Flow's constrained node-drag supersedes `dnd-kit` for table reordering *on the canvas* (`dnd-kit` stays wherever it's already used in-table).
- **The rich-text toolbar half is unaffected** by this decision and should still ship first (D1), decoupled from the canvas merge — see Recommended sequencing.

Open sub-questions this decision leaves (for the spike): dagre vs elk; how a lane's internal tree (Tier-2 nested entries) renders inside a node vs as its own subflow; Radix popovers anchored inside a zoomed React Flow node (Floating-UI-under-transform, below); and level-of-detail perf when all three lanes are mounted.

> **RESOLVED (owner, 2026-07-18) — substrate is React Flow (`@xyflow/react`).** The contradiction below (this Decision picking React Flow vs. the appended **§5** research recommending a **CSS-transform plane + `@panzoom/panzoom`**) was put back to the owner, who **reconfirmed React Flow** with the §5 CSS-transform alternative as the considered-and-overridden option. D3 now proceeds **spike-first on React Flow** per **Recommended sequencing** step 3 — a time-boxed spike must clear the four pass/fail gates (EditableGrid grammar at scale≠1; constrained node-drag reorder / dnd-kit-under-zoom; Radix popovers under transform via body portal; focus-driven pan) before the production D3 build starts. Positioning stays DERIVED (auto-layout into tier lane-columns by `sort`; node-drag = reorder only; no persisted `{x,y}`) per the Decision above. D1/D2 (shipped) are unaffected; they depend on neither substrate.
>
> *(Historical note, retained: the appended §5 research reached the opposite conclusion — reject React Flow for a CSS-transform plane + a small gesture lib — on the grounds that React Flow is position-authoritative and only relocates GeDe's hard problems. The owner accepts that tradeoff to keep React Flow's batteries-included viewport; the spike's gates exist precisely to prove the relocated problems are tractable.)*

## Recursion (drill-in) & coverage on the canvas (owner decisions, 2026-07-16)

Two Design-tier features are today *view/route swaps* that fight the "one canvas" model. Both resolve to the **same spatial pattern — adjacent, edge-connected, on-demand satellite nodes** — so a "canvas" on the plane is a small cluster: a **{ring + register} core** with optional satellites hanging off it. Nothing is a subpage anymore; depth and view become **spatial state**, not routes.

- **Recursion / drill-in (issue 011).** *Today*: "Open ▸" on a context grows a URL `contextPath` (`routes.ts:12`), pushes a breadcrumb, and re-scopes both ring + register to the child canvas — a page-swap, unlimited depth. **Decision — "adjacent cluster + edge":** Open spawns the context's child canvas as a **new cluster beside the parent, connected by an edge**; pan/zoom to it; **collapse to hide**. Depth is navigated by panning along edges; the breadcrumb survives as a fast-jump / collapse-all HUD. Position stays derived (auto-layout places the child cluster; the edge is the only *meaning* the arrangement carries — parent→child). **Unlimited depth is tamed by lazy-mount + LOD**: only clusters on/near the open path mount; a deeply-nested collapsed child renders as a single stub node until opened.
- **Coverage (issue 012 / SPEC §4.5).** *Today*: a per-canvas pivot of the whole tuple space (documented vs unexplored square-grid), reached by the `v` view-toggle that REPLACES the ring (`DesignSurface.tsx:284,302`); clicking a hollow gap cell jumps to the canvas in **compose mode pre-filled** (`:192-196`). **Decision — ditto:** Coverage becomes the canvas's **analytical twin node, adjacent and edge-connected**, opened on demand — the `v` toggle becomes *open/collapse the companion*, not a route swap. A gap-cell click still enters compose — now a short pan back along the edge to the linked ring, pre-filled — and the edge makes the coverage↔canvas link visible. The **~26k-cell matrix needs virtualization + LOD**: zoomed out, the companion shows only the headline stat ("N / M documented") + a mini heat-strip; zoomed in, the full interactive grid.

**Routing consequence:** this removes the `DesignView = 'canvas' | 'coverage'` view param **and** the `contextPath` depth from the URL model (`routes.ts:6,12`) — both become spatial state on the canvas. Any deep-link we keep targets a **cluster/node id + viewport**, not a path. A real simplification of the tier-tab + design-route model the unified canvas already proposed to partially supersede (SITEMAP §1).

**Canvas-node internal layout — stack register over ring (owner, 2026-07-16).** Today the Design surface is horizontal: `[rail | register | ring]` (085's editing-zone + canvas-as-side, optimized for a fixed non-scrolling viewport, `SITEMAP §32`). On the canvas, **stack them vertically instead** — `[rail | register]` on top, **ring below** — so a Design canvas node reads top-to-bottom and is a **narrow vertical column** rather than a wide band. Rationale: the drill-in child cluster expands **rightward** (edge), so a narrower core frees horizontal room and fits more drill *depth* per screen; it also suits the "lanes grow down / zoom a frame" model. This is **consistent with 085, not a reversal**: 085's intent was "one editing zone, canvas out of the tab path" — ring-*below* still keeps the canvas out from *between* editing elements and preserves the rail→register Tab bridge; only the *fixed-viewport* constraint 085 optimized for is gone. Orientation: register on top (the authoring/keyboard surface), ring below (derived visual). **Caveat:** the register can be wide (one column per dimension), so stacking removes the ring's width but the table still drives cluster width — the lever if footprint bites at depth is a **level-of-detail register** (compact when zoomed out, full grid zoomed in), reusing the same LOD machinery recursion depth and the coverage matrix already require.

## SITEMAP & routing impact (must land WITH this issue — `docs/SITEMAP.md`)

This proposal rewrites the route model SITEMAP §1 locks; per SITEMAP §6, "deviations are spec changes," so **`docs/SITEMAP.md` must be updated in lockstep when this ships** (a forward-pointer note is already parked at the top of SITEMAP §1). Precise changes:

- **§1 Route map (`SITEMAP.md:14-18`)** — the per-tier routes plus the recursion/view segments collapse into **one workspace route**. `/p/:projectId/foundation|architecture|design`, the `/design/:ctx/:ctx…` child-canvas segments, and `?view=canvas|coverage` are all removed; `/p/:projectId` **is** the canvas. **Tier, canvas depth, and view stop being URL state** and become viewport/cluster state (`routes.ts:6,12` — `DesignView` + `contextPath` go away).
- **Deep-link semantics (`SITEMAP.md:25`)** — "restore tier, canvas depth, view, and selection" → "restore **viewport + focused cluster/node id**" (and, with **090**, the **root-canvas id**). A shareable link encodes a region + zoom, not a path.
- **§2 Design context bar (`SITEMAP.md:58`)** — the **canvas/coverage view toggle** and URL-backed breadcrumbs change: coverage is an adjacent companion node (open/collapse), depth is spatial; breadcrumbs become a pan/collapse HUD, not route state.
- **§4 Keyboard map (`SITEMAP.md:80,83`)** — **⌘1/2/3** become *pan/zoom-to-lane* (Foundation/Architecture/Design lanes) rather than route switches; **`v`** becomes *open/collapse the coverage companion* rather than a `?view=` toggle.
- **§3 Command palette (`SITEMAP.md:72`)** — "canvases (by lineage `α ▸ α2`)" resolves to **pan-to-cluster** rather than a route push; add "jump to lane" and (090) "jump to canvas" sources.

Net: the tier-tab + design-route model becomes **one pannable surface with spatial state**; SITEMAP §1's route table is replaced by a "canvas regions + viewport deep-link" description, and §2/§3/§4 are amended as above. Keep SITEMAP authoritative until this ships.

## Current state (file:line)

### How the three routes work today

Routing is a hand-rolled parse/serialize (`shell/routes.ts`) over three distinct route kinds:

- `Tier = 'foundation' | 'architecture'` and a separate `design` kind (`routes.ts:5,8-18`). `parseRoute` maps `/p/:id/foundation`, `/p/:id/architecture`, `/p/:id/design/:ctx…?view=` to those kinds (`routes.ts:20-49`); `serializeRoute` is the inverse (`routes.ts:51-74`).
- The shell renders exactly **one** surface per route. Tier switching is a tab click or `⌘1/⌘2/⌘3` (`AppShell.tsx:65-69` `TIER_TABS`, `:297-303` the keymap, `:331-347` the tab bar). `routeForTab` (`:71-75`) builds the target route; `navigate()` (`shell/router.ts`) pushes history. So **a user moves between tiers by replacing the whole surface** — never by scrolling or panning; the three surfaces never co-exist in the DOM.
- The shell is three fixed chrome bands (app bar / context bar / status bar) with **one scroll container between them**: `.surface { flex: 1; overflow: auto }` (`base.css:182-185`). `SITEMAP.md:32` is explicit: *"everything between them scrolls per-surface (the page itself never scrolls)."* Each tier owns that scroll region alone.
- Per-route context bars (`SITEMAP.md:56-60`): Design mounts breadcrumbs + view toggle + coverage stats (`DesignSurface.tsx:446-493`); Architecture mounts a table quick-jump (`ArchitectureSurface.tsx:52-69`); Foundation's bar is empty and hidden.

### What is shared vs bespoke

- **Shared:** `EditableGrid` (`EditableGrid.tsx`) — TanStack Table v8 headless + one custom cell layer (ADR-0004), implementing the Numbers grammar **once**: click/Enter swaps a borderless input, Enter commits + moves down (`:308-310`), Tab traverses (`:311-313`), Esc reverts (`:314-319`), phantom-row Tab creates-and-continues across a new record (`:594-620,721-756`). `nextEditableCell` (`:180-215`) is the pure boundary resolver. Cell kinds: `text · mono · combobox · static · multiline` (`:52-57`). It has **zero knowledge of tiers** — callers pass `getValue`/`onCommit` closures. Foundation, Architecture (per-table), and Design's register all mount it.
- **Bespoke per surface:** Foundation's rank cell + dnd-kit re-rank (`FoundationSurface.tsx:28-51,200-213`); Architecture's tree/select/meta cells, promote + delete-resolution popovers (`ArchitectureSurface.tsx:183-327,385-537`); Design's whole compose-mode machine, the dimension rail, the Canvas, and ~5 capture-phase key handlers (`DesignSurface.tsx:244-380`).

### Where rich text is / isn't

- **Rich text exists in exactly one field:** Tier-1 "Existing scenario" (`FoundationSurface.tsx:185-194` mounts `RichTextEditor`). It is Lexical, storing `JSON.stringify(editorState.toJSON())` — **never HTML** (`rich-text-editor.tsx:44-60,73-76`), guarded by `safeRichTextJson` against a node whitelist (`domain/richText.ts`, `RICH_TEXT_NODES`). The toolbar is **internal to each editor instance** (`Toolbar` reads one specific `editor` via `useToolbarState(editor)`, `:162-303`); it renders inside `EditorChrome` (`:344-345`) and is hidden when `readOnly`. Commits happen **on blur**, not per keystroke (`:335-341`). `Cmd/Ctrl+B/I/U` are wired by a bespoke `ShortcutsPlugin` (`:92-114`).
- **Everything else is plain text.** Foundation's Purpose uses `MultilineEdit` → stores to `tier1_purpose.body` as a plain string (`FoundationSurface.tsx:162-177`, `schema.ts` `body: text(...)`). Every `EditableGrid` `multiline`/`text` cell is a plain `<textarea>`/`<input>` storing a raw string: `tier1_props.description`, `tier2_entries.description` (`schema.ts` — both `text(...)` nullable), Design's justification cell. So **the entire "make all text rich" surface is currently plain strings in plain `text` columns.**

### The canvas / zoom baseline

- `Canvas.tsx` is SVG over a **scale-free 1000×1000 abstract space** projected through one `viewBox` (`Canvas.tsx:185-188` `viewBox={geometry.viewBox}`; `STYLE_GUIDE.md:131` *"Geometry is scale-free… → SVG viewBox"*). Layout is a pure `fn(tree)` (`domain/canvasLayout.ts`, invariant 5 `SPEC.md:57`) — no stored x/y, ever.
- **There is no interactive pan or zoom anywhere in the app.** The one thing named "zoom" is `.canvas-zoom` (`base.css:1485-1499`): a **one-shot CSS entrance animation** (~200ms `scale(0.96)→1`) replayed on drill-down, keyed on the canvas id (`DesignSurface.tsx:500`). It is not gesture-driven, not continuous, and resets to identity. The canvas responds to container width via `ResizeObserver` (`Canvas.tsx:54-71`) purely to pick a label tier — not to zoom.
- **So page-level pan/zoom is net-new infrastructure.** Nothing today reads wheel/pinch/drag to transform a viewport.

## Directions (lowest-risk → most ambitious)

### D1 — Global rich-text toolbar across all cells (decoupled from any canvas merge; shippable alone)

Keep the three routes exactly as they are. Introduce **one** rich-text control surface that binds to whatever editable text field is focused, and make `EditableGrid`'s text/multiline cells rich-capable.

```
  ┌─ APP BAR ──────────────────────────────────────────────┐
  │ GeDe ▸ Tavalo   Foundation·Architecture·Design   ⌘K ↶ ↷ │
  ├─ CONTEXT BAR (+ optional global format strip) ──────────┤
  │  B  I  U   • ≣   ⇤ ⇥        ← binds to focused editor    │
  ├─────────────────────────────────────────────────────────┤
  │  1st Tier · Foundation                                   │
  │  Purpose  [ rich cell, focused → toolbar lights up ]     │
  │  ┌ Rank │ Name │ Description (rich) ───────────────────┐ │
  │  │  1°   │ …    │ **Comfort** on demand…    ← focus     │ │
  │  └──────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────┘
        (identical toolbar appears on Architecture / Design)
```

- **Interaction cost:** unchanged for typing; +1 discoverable surface for formatting. Popover-on-selection = 0 permanent chrome; topbar = always-visible but costs a chrome band.
- **Pros:** delivers the entire *second* half of the vision with **none** of the canvas risk; independently testable; aligns with the north star (richer content, same keyboard flow); no routing change. Fixes the real inconsistency (one rich field in the whole app).
- **Cons:** the data-model / back-compat work (see the global rich-text plan) is the actual cost and it is non-trivial; a persistent topbar spends a chrome band the shell has so far kept for navigation only.
- **Build size:** **M** (medium). Toolbar-detach + focused-editor registry + a `richtext` cell kind + a plain-string→Lexical back-compat path + tests. No routing, no canvas, no layout.

### D2 — One scrollable page, three lanes stacked, shared toolbar (no zoom yet)

Collapse the three routes into a **single URL** (`/p/:id/workspace`, or keep `/p/:id` as the canonical) rendering all three surfaces as **vertical lanes side by side** inside the existing `.surface` scroll region. Lanes grow downward; the page scrolls (both axes if needed) but does **not** pan/zoom. Tier tabs become **scroll-to-lane** anchors (like Architecture's existing quick-jump, `ArchitectureSurface.tsx:46-48`).

```
  ┌─ APP BAR ───────────────────────────────────────────────────┐
  │ GeDe ▸ Tavalo   [Foundation][Architecture][Design]  B I U ≣  │  ← tabs scroll-to-lane; toolbar global
  ├──────────────────────────────────────────────────────────────┤
  │  FOUNDATION        │  ARCHITECTURE        │  DESIGN           │
  │  ┌──────────────┐  │  ┌────────────────┐  │  ┌─ rail ─┬ reg ┐ │
  │  │ Purpose      │  │  │ + Name a table │  │  │ dims   │ ctx │ │
  │  │ Scenario     │  │  │ Stakeholders   │  │  ├────────┴─────┤ │
  │  │ 1° Comfort   │  │  │   Users        │  │  │   ◯ canvas   │ │
  │  │ 2° Mobility  │  │  │ Value          │  │  │  (still SVG) │ │
  │  │ 3° …    ↓grow│  │  │   Speed   ↓grow│  │  └──────────────┘ │
  │  └──────────────┘  │  └────────────────┘  │        ↓grow      │
  └──────────────────────────────────────────────────────────────┘
              (one page scroll; lanes are columns; no viewport transform)
```

- **Interaction cost:** the three tiers become visible-at-once (good for the "one coherent instrument" goal); switching is a scroll, not a route replacement. Keyboard entry inside each lane is *unchanged* (each lane still mounts its own `EditableGrid`s). Cross-lane Tab is a new question (see risks).
- **Pros:** realizes "one page, lanes grow downward" and *most* of the coherence win, with **no pan/zoom infra**; the shared toolbar (D1) drops straight in; reversible (routing can still deep-link to a lane). The three surfaces already render into a flex container — this is a layout + routing change, not a rewrite of the surfaces.
- **Cons:** rendering **all three surfaces at once** means all their stores load and all their `EditableGrid`s (and the Design Canvas + compose machine) mount simultaneously — today only one is ever mounted. The ~5 Design capture-phase global key handlers (`DesignSurface.tsx:244-380`, all `window.addEventListener(..., true)`) were written assuming Design is the *only* surface; three lanes mean `c`/`v`/`d` fire regardless of which lane has focus unless re-scoped. Horizontal + vertical scroll on one page contradicts `SITEMAP.md:32` ("the page itself never scrolls") — a deliberate spec change. Narrow screens can't show three columns — lanes must reflow to a stack, which is just today's tabs by another name.
- **Build size:** **L** (large). New route + shell layout + lane framing + re-scoping every Design global handler + store-load orchestration + the shared toolbar. No new rendering engine.

### D3 — Pan/zoom infinite canvas, three lanes, focus-by-zoom, shared toolbar (the full vision)

D2 plus a **continuous, gesture-driven viewport transform** over the lane plane: wheel/pinch to zoom, drag-empty to pan, zoom-to-fit a lane, zoom-out for overview. Lanes are positioned on an infinite plane; table content lives inside them at 1:1 and stays crisp (HTML, not rasterized).

```
   zoomed OUT (overview)                 zoomed IN (focus one lane)
  ┌───────────────────────────┐        ┌───────────────────────────┐
  │ ░F░  ░░A░░   ░░░D░░░       │        │  ARCHITECTURE             │
  │ ░░░  ░░░░░   ░░░░░░░       │  wheel │  + Name a table           │
  │ ░░░  ░░░░░   ░░░░░░░  pan  │  ────▶ │  ▾ Stakeholders  2 entries│
  │       [minimap ▢]         │  pinch │    ⌄ Users     → Persona  │
  └───────────────────────────┘        │      Name an entry…       │
     lanes are cards on a plane        └───────────────────────────┘
     grid-paper ground shows through   crisp HTML text at 1:1 inside
```

- **Zoom/pan infra choice** (three options, with a recommendation):
  1. **CSS `transform: scale()/translate()` on a lane-plane container** + a gesture lib (`@use-gesture/react` for wheel/pinch/drag) driving the transform. Content stays real DOM → `EditableGrid` inputs, focus, and a11y keep working; text stays crisp at any zoom. **This is the recommended path** — it keeps the existing surfaces as ordinary DOM subtrees and only wraps them in a transformed plane. Watch: `position: fixed`/sticky bars, focus-scroll-into-view, and popover positioning (Radix) all compute against the untransformed viewport and need care.
  2. **A canvas library** (`react-zoom-pan-pinch` for a batteries-included transform wrapper, or `tldraw`/`react-flow` for a full scene graph). `react-zoom-pan-pinch` is the lightest and still lets DOM children be real; `tldraw`/`react-flow` own the scene and would fight `EditableGrid`'s own keyboard model and the drafting-table CSS — **rejected** for structured-table content.
  3. **Extend the SVG `viewBox` model.** The Design Canvas already lives in `viewBox` space (`Canvas.tsx:185`); one could put *everything* in SVG `foreignObject`. `foreignObject` + contentEditable + focus is notoriously fragile across browsers — **rejected** for the table lanes (fine to keep the Design ring itself as SVG *inside* a lane).
- **Perf strategy:** mounting three full surfaces and transforming them is the risk. Mitigations: (a) **render lanes at low detail when zoomed out** — swap dense `EditableGrid`s for a lane summary card below a zoom threshold, mount the real grid only when a lane is near 1:1 (virtualization by *lane*, not by row); (b) `content-visibility: auto` on off-screen lanes; (c) `@tanstack/react-virtual` inside a lane once a table exceeds ~10k rows (ADR-0004:18 already names this as the trigger); (d) the transform must be GPU-composited (`transform` only, never re-layout) and reduced-motion must snap.
- **How `EditableGrid`'s keyboard grammar survives inside a zoomable canvas:** because content is real DOM (option 1), the grammar is untouched *inside* a lane — `nextEditableCell` (`:180-215`) and the phantom chain (`:594-620`) don't care about the viewport transform. The new problems are all at the seams: (i) focusing a cell must **pan the viewport to it** (not the browser's native `scrollIntoView`, which assumes a scroll container, not a transform); (ii) the ~5 Design global handlers and the shell's `⌘1/2/3` must be re-scoped to "focused lane"; (iii) Tab must not silently walk *out* of a lane into another lane's grid across the plane (a Tab-boundary decision, extending the 085 seam-bridge idea at `DesignSurface.tsx:358-380`).
- **Interaction cost:** highest. The user gains a spatial overview but must now *manage a viewport* (pan/zoom state) before/while typing — a cost the tab model doesn't impose. Zoom-to-lane keyboard shortcuts are mandatory so bulk entry never requires the mouse (north star).
- **Pros:** the full owner vision; a genuinely novel "see the whole method at once, dive into any part" instrument.
- **Cons:** largest lift by far; re-opens the 085 canvas-as-visual decision (below); accessibility of a zoomable canvas is hard (focus management, screen-reader reading order across a transformed plane, `SITEMAP.md:95` "< 400px read-mostly"); mobile/touch pinch competes with scroll; Radix popovers (`ui/popover`, used by promote/resolution/menus) position against the viewport and will need transform-aware anchoring.
- **Build size:** **XL** (extra-large, multi-session). Gate behind a spike (Recommended sequencing).

## The global rich-text plan (dedicated subsection)

This is the vision's second half and is **separable from the canvas merge** — it is D1, and it is the highest value-to-risk item in the whole proposal.

### Binding one toolbar to the focused editor

Today `Toolbar` is constructed with a specific `editor` and reads its state via `useToolbarState(editor)` (`rich-text-editor.tsx:199-200`), rendered *inside* each `EditorChrome` (`:344-345`). To make it global:

- Introduce a small **focused-editor registry** (a Zustand slice or React context): each mounted `RichTextEditor` registers its `LexicalEditor` and reports focus/blur; the registry holds the *currently focused* editor (or null).
- Lift `Toolbar` out of `EditorChrome` into **one instance** in the shell (context bar strip) or a **selection popover**. It reads the registry's active editor, re-subscribes `useToolbarState` to *that* editor when it changes, and dispatches `FORMAT_TEXT_COMMAND` / list commands to it (`:210-261` are already editor-agnostic dispatches).
- Preserve the critical `onMouseDown={preventDefault}` selection-guard (`:294`) — a global toolbar button must still not steal the focused editor's selection.
- `ShortcutsPlugin` (`Cmd+B/I/U`, `:92-114`) stays per-editor (it's local key handling) — the global toolbar is the *discoverable/mouse* path; shortcuts remain the keyboard path.

### Popover-on-selection vs persistent topbar

- **Popover-on-selection** (Medium/Miro-style: appears above a text selection): zero permanent chrome, contextual, matches "in-place, always" (`STYLE_GUIDE.md:14`). Cost: popover positioning must survive the D3 viewport transform; harder to discover; needs a selection-change listener to show/hide.
- **Persistent topbar** (a format strip in/under the context bar): always discoverable, trivially keyboard-reachable, no positioning math. Cost: spends a chrome band the shell reserved for navigation; reads as "dashboard chrome," slightly against the drafting-table restraint; mostly-disabled when no editor is focused.
- **Recommendation:** persistent **context-bar strip** for D1/D2 (simplest, most discoverable, no transform math), with a **selection popover** reconsidered only if D3 ships (where a floating popover reads better on the plane). The two are not mutually exclusive — the registry supports both.

### What has to change to make every text field rich

- **`EditableGrid`:** add a `richtext` cell kind alongside `multiline` (`:46-57`), wrapping `RichTextEditor`. The cell's edit affordance differs from today's click-to-swap-input model: `RichTextEditor` is *always-live* contentEditable (`:56-59`), so a rich cell is either always-editable-in-place or gains a focus-to-activate wrapper. This interacts with the grammar (`nextEditableCell`, `advance`, `:273-279`) — a Lexical editor swallows Enter/Tab for its own formatting, so the "Enter commits down / Tab right" contract needs an explicit escape (e.g. Esc-then-Tab, or Cmd+Enter to commit-and-advance) inside a rich cell. **This is the subtle part** and is why D1 is M not S.
- **`rich-text-editor.tsx`:** detach `Toolbar`; add the registry hookup; parameterize the namespace/aria (`:400,349`) so many instances coexist.

### Risks — the data model

- **Table cells are plain strings today**, in plain `text` columns (`tier1_props.description`, `tier2_entries.description`, `tier1_purpose.body`). Lexical serialized JSON is *also* a string, so **no schema migration is strictly required** — the JSON fits the existing `text` column (exactly how `existing_scenario` works, `schema.ts:117`). But:
- **Back-compat is the real cost.** `safeRichTextJson` returns `null` for any non-Lexical-JSON string (`rich-text-editor.tsx:395`, `domain/richText.ts`), so an existing plain-text description would render as **empty** in a rich cell. Options: (a) a **display-only fallback** — if the stored value isn't valid Lexical JSON, render it as a plain paragraph (read plain, write rich-on-first-edit); (b) a **one-time convert** of existing plain strings to Lexical JSON (a data migration through the mutation layer, LWW-safe). Option (a) is lower-risk and reversible; recommend it.
- **Sync/write-path:** these columns already flow through the write outbox and Electric read path (existing scenario proved the path — `pgWriteStore.contract.test.ts:512-546`). A rich value is still just a string on the wire, so the sync layer is unaffected — but every newly-rich column must be confirmed to be a synced column, not a local-only one.
- **Export/search:** `SPEC.md:48,147` says justification is *"first-class, searchable"* and full-text search runs over justifications/descriptions. Rich JSON is not human-readable text — search and the semantic index (`store/semanticSearch`) must extract plain text from the Lexical state, or they silently stop matching. This is a real, easy-to-miss regression surface.

## Tradeoffs & risks

- **Perf (D2/D3):** three full surfaces mounted at once is the headline risk — today exactly one is. The Design surface alone mounts the Canvas, the compose machine, and multiple stores; add Foundation's dnd-kit and Architecture's N table grids and the initial mount cost multiplies. D3's viewport transform on top demands lane-level virtualization (render summary cards when zoomed out). Mitigations exist (`content-visibility`, lane-detail LOD, `react-virtual` per ADR-0004:18) but they are work, not free.
- **Keyboard-grammar continuity across lanes:** `EditableGrid`'s grammar is airtight *within* a grid. The unsolved questions are cross-lane: does Tab walk from Foundation's last row into Architecture's first? (085 already had to hand-bridge one such seam, `DesignSurface.tsx:358-380`.) Three lanes = three-way seams. Recommend lanes are **independent tab scopes**, with explicit "next lane" keys, not one continuous Tab chain — a continuous chain across a spatial plane is disorienting.
- **Discoverability:** tabs make "there are three tiers" obvious. A pan/zoom plane can hide lanes off-screen; a **minimap** and zoom-to-lane shortcuts become mandatory, not optional.
- **Interaction with route-based navigation:** D2/D3 fold `/foundation`, `/architecture`, `/design` into one route — a `SITEMAP.md:11-18` change. Deep links (`SITEMAP.md:25` "Deep links restore tier, canvas depth, view, and selection") must still work: a link should pan/zoom to the addressed lane/canvas. The Design route's own `contextPath` recursion + `?view=coverage` (`routes.ts:42-47`) must survive *inside* the Design lane — the drill-down is orthogonal to the lane merge and must not be lost.
- **Supersedes / re-opens 085:** this is the sharpest tension. `085` (shipped) settled *"the canvas is a visual representation only; all editing lives in the tables"* and made the Design ring a **side visual, out of the editing tab path** (`085:14-18`, Decisions 1-2; it *superseded* 082 Phase 2 on-ring authoring). A full **zoomable canvas whose lanes ARE the tables** re-promotes "canvas" to the primary organizing metaphor. These aren't strictly contradictory — 089's canvas is a *viewport over tables*, not an *editing-on-the-ring* surface, so 085's "no authoring on the Design ring" can still hold — but the owner should decide explicitly whether the workspace-canvas framing reverses the spirit of 085's "tables are the instrument, canvas is the glance."
- **Accessibility of a zoomable canvas (D3):** focus order (`STYLE_GUIDE.md:159` app-bar→context-bar→surface) assumes a linear surface. A transformed plane needs: focus-driven pan (not native scroll), a sane screen-reader reading order across lanes, visible focus rings that survive scaling, and `prefers-reduced-motion` snapping every pan/zoom. `SITEMAP.md:95` already concedes "< 400px read-mostly" — the zoom canvas is desktop-first by necessity.
- **Mobile / small screen:** three side-by-side lanes cannot fit narrow widths; they must stack — which is functionally today's tab model. Pinch-zoom competes with the browser's own. Recommend the workspace canvas is a **desktop/tablet** enhancement and narrow screens fall back to the stacked-lane (≈ tabbed) view.
- **Do the tier relationships still read?** The tiers aren't just adjacent — they're *linked*: Architecture entries **promote** into Design dimensions/parameters (invariant 7, `SPEC.md:59`; `ArchitectureSurface.tsx:435-537`), and the Design ring + child-canvas recursion carry their own meaning. Co-locating them as lanes could make the **promote flow** more legible (source and target visible at once — a real upside) *or* could bury it (the promote popover fires from an Architecture row; where does its result animate to across the plane?). And the Design **ring** inside a lane must stay a coherent circle at 1:1 — it can't just be another downward-growing table. Worth a specific design pass.

## Open design forks (owner decisions — each changes the build)

1. ~~**Ship the toolbar independently of the canvas merge?**~~ **RESOLVED — yes (D1 shipped 2026-07-17).** The toolbar shipped standalone with none of the canvas work.
2. ~~**Toolbar form:** persistent context-bar strip, selection popover, or both?~~ **RESOLVED — persistent context-bar strip** (`FormatStrip`), realized as focus-reveal (appears on rich-editor focus). Popover still reconsiderable if D3 ships.
3. ~~**Rich-text back-compat:** display-only fallback or a one-time convert migration?~~ **RESOLVED — convert, realized as a *repeatable* value-gated heal-on-load** (`richTextConvert.ts`), not the display-only fallback the doc originally recommended. It must repeat because LWW is value-blind (an un-upgraded peer re-clobbers the converted value with plain text).
4. ~~**Which fields become rich?**~~ **RESOLVED — prose now, identifiers deferred.** All four prose columns (Purpose, both descriptions, justification) are rich; `*.name` / `contexts.symbol` identifiers are deferred pending an owner call (see "Identifier columns — deferred" above).
5. ~~**Zoom/pan tech:** CSS transform + `@use-gesture`, `react-zoom-pan-pinch`, or a scene-graph lib?~~ **RESOLVED (owner, 2026-07-18) — React Flow (`@xyflow/react`)**, reconfirmed over §5's CSS-transform recommendation. **Still spike-first**: the four gates below must pass before the production D3 build (see the RESOLVED note under "## Decision").
6. ~~**Do lanes share one scroll/plane or stay independent?**~~ **RESOLVED (D2 shipped 2026-07-17) — one shared page scroll** (the existing `.surface`); lanes are non-stretching flex columns, no lane-local scroll.
7. **Is the Design ring still canvas-as-visual (085) inside its lane, or does the whole page-canvas replace that role?** (The 085 tension — needs an explicit call.) **STILL OPEN — a D3 gate.** D2 left the Design lane's `[editing-zone | canvas]` layout untouched, so the 085 tension only re-opens with the zoom canvas.
8. ~~**Keep the three routes as deep-links into canvas regions?**~~ **RESOLVED (D2 shipped 2026-07-17) — yes.** All three routes retained as scroll-to-lane deep-links (`laneForRoute`); the grammar was not collapsed, so links and ⌘1/2/3 still work (now navigate + scroll).
9. ~~**Cross-lane keyboard:**~~ **RESOLVED (D2 shipped 2026-07-17) — independent per-lane Tab scopes** + ⌘1/2/3 as the explicit "go to lane" key; no continuous cross-lane Tab chain.
10. **Lanes hand-placeable or auto-laid-out?** Free placement collides with `STYLE_GUIDE.md:16` principle 4 ("position is derived"). Recommend **auto-laid-out lanes, meaning-free viewport pan/zoom only** — arrangement never carries meaning. **STILL OPEN — a D3 gate** (D2's lanes are auto-laid-out flex columns; the hand-placeable-vs-derived question only bites once the zoom plane exists).

> **D3 gate status (owner, 2026-07-18):** **Fork 5 (substrate) RESOLVED — React Flow (`@xyflow/react`)**, reconfirmed over §5. Forks **7** (ring stays canvas-as-visual inside its lane — 085 holds) and **10** (lanes auto-laid-out; pan/zoom is meaning-free viewport only) are **taken at the doc's recommended resolutions by default**. D3 now proceeds **spike-first**: a time-boxed React Flow spike must clear the four pass/fail gates before the production build. D2 (shipped) depends on none of these; it added no viewport transform.

## Recommended sequencing

De-risk by splitting the vision along its natural seam — **the toolbar is separable from the canvas, and far cheaper.**

1. **Ship D1 first (global rich-text toolbar).** It delivers the entire second half of the vision, is decoupled from any routing/canvas change, and its hard parts (data back-compat, the rich-cell keyboard-escape, search plain-text extraction) are contained and testable. This is the high-value, low-regret move. Start with the **registry + detached context-bar strip + `richtext` cell kind + display-only plain-string fallback**, wired first on the two prose fields (Purpose, Justification) before every description cell.
2. **Then D2 (single scrollable lane page) as the reversible middle step.** It proves "one coherent instrument, lanes grow downward" with **no pan/zoom infra**, surfaces the real problems early (three surfaces mounted at once; the Design global-handler re-scoping; deep-link-to-lane; cross-lane Tab) at a fraction of D3's cost, and D1's toolbar drops straight in. Keep the three routes as deep-links into lanes.
3. **Spike D3 before committing (do not build it blind).** A **time-boxed spike** on option-1 infra (CSS transform + `@use-gesture` over the D2 lanes) that answers the four unknowns: (a) does focus-driven pan feel right for keyboard entry; (b) do Radix popovers anchor correctly under transform; (c) does lane-level LOD keep the overview cheap; (d) does `EditableGrid`'s grammar survive at 1:1 inside a transformed plane. Ship D3 only if the spike says the viewport cost doesn't tax the north star.

**Honest caveats:** the zoom-canvas half is the app's biggest client-side bet and it pushes against two settled positions — `SITEMAP.md:32` ("the page itself never scrolls") and `085`'s "canvas as side visual, tables are the instrument." Neither is immovable, but both are *deliberate* and reversing them should be an explicit owner decision, not a side effect of the merge. The toolbar half has no such tension and should not wait on the canvas.

## References

- Code (audited, file:line):
  - Surfaces: `src/components/FoundationSurface.tsx:28-51,162-194,196-215`, `src/components/ArchitectureSurface.tsx:33-105,183-327,435-537`, `src/components/DesignSurface.tsx:244-380,444-624`.
  - Shared primitives: `src/components/EditableGrid.tsx:46-57,180-215,273-319,571-620,661-756`, `src/components/Canvas.tsx:54-71,183-188` (viewBox), `src/domain/canvasLayout.ts` (pure `fn(tree)`).
  - Rich text: `src/components/ui/rich-text-editor.tsx:44-114,162-303,335-345,378-434`, `src/domain/richText.ts` (`RICH_TEXT_NODES`, `safeRichTextJson`), `src/components/ui/rich-text-editor.test.tsx`.
  - Routing / shell: `src/shell/routes.ts:5-49,51-74`, `src/shell/AppShell.tsx:65-75,281-347`, `src/shell/router.ts`, `src/styles/base.css:182-185` (`.surface`), `:1371-1466` (design-surface-row / editing-zone), `:1485-1508` (`.canvas-zoom`).
  - Data model: `src/db/schema.ts` (`tier1_purpose.body`, `existing_scenario`, `tier1_props.description`, `tier2_entries.description` — all `text`).
- Docs: `docs/SPEC.md` §1-2 (tier model, invariants 1-7), §4.1-4.6 · `docs/SITEMAP.md` §1 (route map), §2 (shell bands, "page never scrolls"), §4 (keyboard map) · `docs/STYLE_GUIDE.md` §1 (principle 4 "position is derived"), §6 (Numbers grammar), §7 (canvas, scale-free viewBox, ≥44px hit), §8 (motion, drill-down zoom), §10 (a11y) · `docs/adr/0004-tanstack-table-inplace-editing.md` (EditableGrid; virtualize trigger).
- Related issues: `done/085-design-route-consolidated-editing.md` (canvas-as-visual, one editing zone — the closest precedent and the sharpest tension), `done/082-design-route-ux.md` (Phase 1 shipped; Phase 2 on-ring authoring superseded by 085), `084-tier2-architecture-ux.md` (north star statement; Architecture UX), `done/081-tier1-existing-scenario-rich-text.md` (the one existing rich-text field; Lexical decision).

## Libraries & prior art (2026 research)

*Compiled July 2026 from current npm/GitHub/docs (not training-data recall). The governing constraint: GeDe's tier tables are `EditableGrid` (TanStack Table + real DOM `<input>`s) with a spreadsheet keyboard grammar (Enter/Tab/Esc, phantom rows) and Radix popovers. Any zoom engine that rasterizes content to `<canvas>`/WebGL (tldraw, Konva, PixiJS, Excalidraw's canvas, AFFiNE's edgeless Turbo renderer) breaks inline editing and is usable only for non-editable visuals. So the field narrows to engines that keep content as **real DOM under a CSS transform**. The app already uses `@dnd-kit/core` + `@dnd-kit/sortable` for reorder.*

### Direct answer to the owner's question

**"Do we need a NEW library, and are there existing GitHub projects that do this?"**

- **A new library is not strictly required, but one small one is the pragmatic choice.** GeDe can get D3's pan/zoom viewport with roughly one dependency (a CSS-transform wrapper or a gesture lib) while keeping every existing surface as ordinary DOM and keeping `dnd-kit` for reorder. You do **not** need a scene-graph framework, and adopting one (React Flow / tldraw) would cost more than it saves given the real-DOM-table constraint.
- **Existing GitHub projects that do "structured content on a pan/zoom infinite canvas" all fall into two camps:** (a) **canvas/WebGL-rendered** (tldraw, Excalidraw, AFFiNE edgeless) — these look closest to the Figma/Miro vision but are **cautionary, not transferable**, because their "editing" is simulated on a bitmap and cannot host a real `EditableGrid`; and (b) **real-DOM node canvases** (the React Flow family) — transferable in principle (nodes are real DOM, so an `<input>`/`<table>` inside a node works), but React Flow is a *position-authoritative node-graph* engine, which fights GeDe's "position is derived" principle (STYLE_GUIDE §1 principle 4). **No existing OSS project was found that puts spreadsheet-grade inline-editable tables with a full keyboard grammar on an infinite zoom canvas** — that specific combination is close to novel. The closest real-DOM references to study are small React Flow examples and CSS-transform starters (shortlist below).

### 1. DOM-preserving pan/zoom libraries — comparison

| Library | Latest (date) | Stars | React 19 | License | Bundle (min+gz) | Inline DOM inputs under transform | Verdict for GeDe |
|---|---|---|---|---|---|---|---|
| **react-zoom-pan-pinch** (BetterTyped) | 4.0.3 (2026-04) | ~1.9k | peerDeps `react:"*"` — installs clean; not formally pinned | MIT | ~12.4 kB | **Documented friction.** Issues [#246](https://github.com/prc5/react-zoom-pan-pinch/issues/246) (input not typeable inside `TransformComponent`), [#222](https://github.com/prc5/react-zoom-pan-pinch/issues/222) (text not selectable unless wrapper `disabled`) — wrapper swallows `mousedown`/pointer. Workable with `disabled`/stop-propagation but **not friction-free** — the exact risk we're avoiding | Batteries-included (fit-to-content, zoom limits), active in 2026, but **must validate `EditableGrid` typing before committing**. Candidate, with a spike |
| **@use-gesture/react** + manual CSS transform (react-spring optional) | use-gesture 10.3.1 (2024-03, **stale ~28mo**); react-spring 10.1.2 (2026-06, active) | ~9.6k / ~29k | `>=16.8` covers 19 (works); react-spring lists `^19` | MIT | ~8.7 kB + (19.6 kB if spring) | **Best control.** You own the transform and choose which nodes get gesture handlers, so inputs/contenteditable focus is trivial to preserve; you don't attach drag to the input | **Recommended path.** Canonical "roll your own CSS-transform pan/zoom." Cost: you write fit/bounds/zoom-limit yourself. Flag: use-gesture hasn't shipped since 2024-03 (functional, not broken); react-spring is optional (apply transform directly for smaller footprint) |
| **@panzoom/panzoom** (timmywil) | 4.6.2 (2026-04) | ~2.4k | Framework-agnostic vanilla DOM — no React coupling | MIT | **~3.6 kB (smallest)** | **Best-in-class escape hatch.** First-class `panzoom-exclude` class / `exclude` option keeps inputs/textarea fully focusable | Strong low-level candidate: tiny, zero-dep, active, explicit input exclusion. (npm `panzoom`@9.x is a *different* lib — anvaka; want `@panzoom/panzoom`) |
| **@xyflow/react** (React Flow 12) | 12.11.2 (2026-07) | ~37.7k | Yes (peer `>=17`; RF UI updated for 19+Tailwind4) | MIT (core; Pro tier sells *examples*, gates no features) | ~40–50 kB core | **Yes**, nodes are real DOM inside one CSS-transform viewport — but interactive elements **must** carry `nodrag`/`nopan`/`nowheel` classes or the canvas steals events ([utility-classes docs](https://reactflow.dev/learn/customization/utility-classes)) | See §"React Flow as all-in-one" — **rejected as the primary substrate**: no auto-layout, every node needs a stored `{x,y}` you manage → fights "position is derived" |
| **react-grid-layout** | 2.2.3 (2026-03, TS rewrite) | ~22.4k | Yes (peer `>=16.3`; fork `react-grid-layout-19` exists) | MIT | — | Fine (no transform-context issue) | Solves draggable/resizable/**reorderable** panels only — **no infinite pan/zoom**. Relevant to the reorder-tables need, not the zoom vision |
| **d3-zoom** | 3.0.0 (2021-06, **~5yr frozen**) | ~530 | math-only, no React coupling | ISC | ~15.1 kB | Maths only — no input help; `scaleExtent`/`translateExtent` give limits/bounds; no fit-to-content | Skip unless already on D3. Provides transform math you'd apply to CSS yourself |
| **svg-pan-zoom** (bumbu) | 3.6.2 (2024-10) | ~2.0k | vanilla | BSD-2 | ~7.8 kB | **SVG-only** — needs `foreignObject` for HTML, which reintroduces focus/editing fragility | **Disqualified** for HTML `<input>` table content (matches doc's own D3 option-3 rejection of `foreignObject`) |

**Reading of the pan/zoom field:** three libraries are actively maintained *and* keep real DOM editable — **`@panzoom/panzoom`** (smallest, explicit `panzoom-exclude`), **`@use-gesture/react` + manual transform** (most control, but the gesture lib is stale), and **`react-zoom-pan-pinch`** (most batteries-included but with *documented input-editing friction* — [#246](https://github.com/prc5/react-zoom-pan-pinch/issues/246)/[#222](https://github.com/prc5/react-zoom-pan-pinch/issues/222)). Note this **corrects the doc's D3 aside** that calls `react-zoom-pan-pinch` a safe "lets DOM children be real": it does render real DOM, but its wrapper swallows pointer events over inputs by default — a spike must confirm `EditableGrid` click-to-edit survives it. `@panzoom/panzoom`'s exclusion model is a cleaner fit for that exact problem.

### 2. Drag-to-reorder under a zoom transform (the dnd-kit gotcha)

**The problem is real and confirmed.** dnd-kit measures pointer movement in **screen pixels** and returns a `transform` delta in those same untransformed pixels. Inside a `transform: scale(s)` container, one screen pixel = `1/s` container-local pixels, so the dragged item **drifts from the cursor whenever `scale != 1`**. Droppable measurement is also corrupted because `offsetLeft/Top/width/height` ignore CSS transforms.

Cited issues:
- [clauderic/dnd-kit #1582](https://github.com/clauderic/dnd-kit/issues/1582) — most on-point (drag inside a scaled node; drift at zoom); **still open** for the placeholder/gap case.
- [#464](https://github.com/clauderic/dnd-kit/issues/464) / [PR #518](https://github.com/clauderic/dnd-kit/pull/518) — transformed SortableContext → offset `DragOverlay` (translate fixed; scale not fully).
- [#250](https://github.com/clauderic/dnd-kit/issues/250) — root cause: droppable rects ignore ancestor CSS transforms.
- [#50](https://github.com/clauderic/dnd-kit/issues/50), [#817](https://github.com/clauderic/dnd-kit/issues/817) — related scaled-container symptoms.

**Accepted fix — a scale-aware custom modifier** (de-facto community pattern; no first-party package):

```js
const scaleFactor = 1 / zoom;              // inverse of the container's CSS scale
const adjustScaleModifier = ({ transform }) => ({
  ...transform,
  x: transform.x * scaleFactor,
  y: transform.y * scaleFactor,
});
// <DndContext modifiers={[adjustScaleModifier]} … >
```

Caveats: (i) the **sortable placeholder/gap** is still measured pre-transform and stays `zoom×` too big ([#1582](https://github.com/clauderic/dnd-kit/issues/1582), unresolved) — teams work around it with custom `measuring` or by scaling only a wrapper and keeping the list at scale 1; (ii) `DragOverlay adjustScale` matches overlay *size* but not full position; (iii) `scaleX/scaleY` from `useDraggable` mean "size difference vs the droppable under it," **not** the ancestor CSS scale — a common confusion; (iv) heavy-zoom apps often supply custom collision/`measuring` because droppable rects ignore transforms.

**dnd-kit maintenance (2025–2026):** the stable line `@dnd-kit/core` is **frozen at 6.3.1 (2024-12)**, no `"use client"` directive, [React 19 friction tracked in #1654](https://github.com/clauderic/dnd-kit/issues/1654) (works in React 19 apps but needs manual `"use client"` in RSC/Next). The maintainer has pivoted to a ground-up rewrite `@dnd-kit/react` + `@dnd-kit/dom` (**0.5.0, pre-1.0, experimental**; [roadmap #1842](https://github.com/clauderic/dnd-kit/discussions/1842)). **Implication for GeDe:** the `dnd-kit` we already depend on is in maintenance mode; a future zoom-canvas leans on a frozen core plus a hand-rolled scale modifier. React Flow's built-in node drag sidesteps this (it handles scale internally) — but only if we adopt React Flow, which we're rejecting for other reasons.

### 3. Radix popovers/dropdowns anchoring inside a transformed container

**This is a Floating UI containing-block limitation inherited by Radix, not a Radix bug.** Radix positions via Floating UI; the floating content wrapper (`[data-radix-popper-content-wrapper]`) uses `transform: translate3d(...)`. A CSS `transform` (also `filter`, `perspective`, `will-change`, `container-type`, `backdrop-filter`) makes that ancestor the **containing block for `position: fixed`** descendants, so Floating UI's `fixed` strategy — which assumes the viewport is the containing block — anchors **off by the sum of ancestor transforms**.

Cited:
- [floating-ui #1488](https://github.com/floating-ui/floating-ui/issues/1488) — wrong placement when an ancestor uses `transform`/`translate`; in-thread confirmation that `left/top` on the ancestor (instead of `transform`) fixes it.
- [floating-ui #2386](https://github.com/floating-ui/floating-ui/issues/2386) — documented root cause (fixed strategy when containing block isn't the viewport).
- [radix-ui/primitives #2411](https://github.com/radix-ui/primitives/issues/2411) — Radix Popover mispositions under a new positioning context; **fix: ensure `@floating-ui/dom >= 1.4.3`** resolves under Radix.
- [shadcn-ui/ui #8392](https://github.com/shadcn-ui/ui/issues/8392) — native `<select>` mis-anchors under transformed ancestors (OS menu uses pre-transform screen coords) → **avoid native `<select>`; use Radix `Select`.**

**Workarounds (the design decision GeDe must make per overlay):**
1. **Portal OUTSIDE the transformed plane** (Radix `Portal` → `document.body`, the default). Popover renders at true screen scale; most reliable when you want the menu unscaled. Requires the anchor rect to be computed correctly (keep `@floating-ui/dom >= 1.4.3`).
2. **Portal INSIDE the transformed plane** via `<Popover.Portal container={zoomedContainerRef}>`. The popover then shares the scaled coordinate space, tracks the anchor, **and scales with content** — but its text/padding is scaled by `s` (usually undesirable) and can be clipped by `overflow`.
3. Prefer `left/top`-driven pan on a non-ancestor wrapper where feasible (per #1488); some teams counter-scale portalled content by `1/s`.
4. Avoid native `<select>` inside the plane.

For GeDe's promote/resolution/menu popovers, the likely answer is **option 1 (body portal, unscaled)** for menus, reconsidering **option 2** only for a selection-format popover that should visually belong to the plane — which is exactly the tension the doc flags at D3 cons and the rich-text "popover-on-selection" fork.

### 4. OSS prior art — shortlist to study

The lens: **is on-canvas content real DOM (editable inputs work) or canvas/WebGL (editing simulated)?**

| Repo | Stars | License | DOM or canvas | Transferability to GeDe's editable-table constraint |
|---|---|---|---|---|
| [xyflow/react-flow-mindmap-app](https://github.com/xyflow/react-flow-mindmap-app) | ~124 | MIT | **Real DOM** (`<input>` node, autofocus, inline edit, drag-create) | **Highest** — the concrete "editable input inside a canvas node" template |
| [xyflow/xyflow](https://github.com/xyflow/xyflow) (`@xyflow/react`) | ~37.7k | MIT | **Real DOM** nodes, CSS-transform viewport, React 19 | High as a *pattern* (drop a `<table>` in a custom node); but position-authoritative — see §5 |
| [BetterTyped/react-zoom-pan-pinch](https://github.com/BetterTyped/react-zoom-pan-pinch) | ~1.9k | MIT | **Real DOM** via CSS transform | High *if* rolling our own — but validate input-typing ([#246](https://github.com/prc5/react-zoom-pan-pinch/issues/246)) |
| [KarthikAravindR/infinite-canvas](https://github.com/KarthikAravindR/infinite-canvas) | ~79 | MIT | **Real DOM** children via CSS transform, fit-to-view 0.1–4x | High — tiny, readable end-to-end reference for placing arbitrary React nodes |
| [plait-board/drawnix](https://github.com/plait-board/drawnix) | ~14.3k | MIT | SVG/DOM (Plait + Slate; **not** React Flow) | Medium — full MIT product, different substrate |
| [toeverything/AFFiNE](https://github.com/toeverything/AFFiNE) (BlockSuite) | ~70.5k | MIT + source-available | Hybrid; edgeless leans **canvas** (worker Turbo renderer); [table column-resize broken in edgeless #14717](https://github.com/toeverything/AFFiNE/issues/14717) | Medium-low — best *product* reference, heavy/CRDT-coupled; the table-in-edgeless bug is a live warning |
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | ~90k | MIT | **Canvas** (+iframe embeds; text-edit is a transient overlay `<textarea>`) | Low — canvas editing, not DOM tables |
| [tldraw/tldraw](https://github.com/tldraw/tldraw) | ~48.8k | **Custom source-available** (paid for commercial; hobby watermark; enforces license key in prod) | Hybrid; **canvas-rendered editing** | Low — license + canvas text make DOM tables impractical; good *camera-math* reference only |

Also: [React Flow whiteboard guide](https://reactflow.dev/learn/advanced-use/whiteboard); write-ups on real-DOM CSS-transform canvases — Vikram Thyagarajan "Figma-like infinite canvas in React," Albert Purnama "use `transform` not top/left," Sandro Maglione "Infinite HTML canvas with zoom and pan" (transform the *container*, not each element — the exact model D3 option-1 proposes).

### 5. React Flow as an all-in-one — the decisive tradeoff

React Flow is the tempting all-in-one: real-DOM nodes, built-in minimap/controls/background-grid, node drag (= reorder), MIT, React 19. But three findings make it the **wrong substrate for GeDe**:

1. **No auto-layout; position is authoritative.** Every node **requires a stored `{x,y}` you manage**; auto-layout means bolting on dagre/elkjs and writing positions back into node state ([sub-flows docs](https://reactflow.dev/learn/layouting/sub-flows) confirm grouping via `parentId`/`group` nodes, but layout is manual). This **directly contradicts** GeDe's `SPEC.md` invariant 5 / `STYLE_GUIDE.md` §1 principle 4: *"position is derived; nothing on the canvas is draggable-to-mean-something."* We would be continuously computing and persisting x/y just to fake the structured, derived lane layout we actually want — and every node-drag would either mean nothing (fighting the engine) or mean position (violating the principle).
2. **It's a node-graph abstraction.** Zero-edge flows are valid, so you *can* use it as a free-form node canvas, and `group` parents can model lanes — but you'd be forcing a positioned-node graph to behave like a deterministic layout engine. That's more code than a CSS-transform plane over the existing surfaces, not less.
3. **It doesn't remove GeDe's hard problems — it relocates them.** Inputs inside nodes still need `nodrag`/`nopan`/`nowheel` annotations or the canvas eats `EditableGrid`'s clicks/keys/wheel-scroll; Radix popovers inside nodes still hit the same transform/containing-block issue (§3, portal fix). React Flow *does* solve drag-under-zoom internally (a genuine plus over hand-rolled dnd-kit + scale modifier), but that single win doesn't outweigh importing a scene-graph framework whose core model opposes ours.

**Versus the doc's D3 option-1 (CSS transform + gesture lib, keep dnd-kit):** option-1 keeps every existing surface an ordinary DOM subtree wrapped in one transformed plane, keeps `EditableGrid`'s keyboard grammar untouched inside a lane, keeps `dnd-kit` for reorder (with the scale modifier from §2), and keeps auto-derived lane layout. It costs us the fit/bounds/zoom-limit code React Flow ships — a bounded, well-understood cost — and the dnd-kit-under-scale gotcha, which has a known fix. That is the better trade.

### Recommendation for GeDe

1. **Toolbar half (D1): no new library.** Reuse Lexical + Radix already in the tree. This half has no canvas/zoom dependency and should ship first regardless of the canvas decision (as the doc already sequences).
2. **Zoom half — confirm the doc's prior, with one adjustment: CSS transform on a lane-plane + a gesture lib, keep `dnd-kit` for reorder. Reject the scene-graph route (React Flow / tldraw).** Rationale above: real-DOM `EditableGrid` survives, "position is derived" is preserved, dnd-kit stays, and the gotchas (drag-under-scale, Radix-under-transform) have known, cited fixes.
3. **For the gesture lib, spike two before choosing** — the doc names `@use-gesture` and `react-zoom-pan-pinch`; add **`@panzoom/panzoom`** as a third and arguably front-runner:
   - **`@panzoom/panzoom`** — smallest (~3.6 kB), active, framework-agnostic, and its `panzoom-exclude` class is the cleanest way to keep `EditableGrid` inputs interactive. Downside: you wire it to a ref manually and build a little React glue.
   - **`@use-gesture/react` + manual CSS transform** — most control over which nodes get gestures (so inputs stay editable by construction), but the gesture lib is stale (last release 2024-03) though functional on React 19; react-spring optional.
   - **`react-zoom-pan-pinch`** — most batteries-included (fit-to-content, zoom limits, active 2026) **but** carries documented input-not-typeable/text-not-selectable issues under its wrapper ([#246](https://github.com/prc5/react-zoom-pan-pinch/issues/246), [#222](https://github.com/prc5/react-zoom-pan-pinch/issues/222)); only pick it if the spike proves `EditableGrid` click-to-edit and Enter/Tab survive its transform.
   The **spike's pass/fail gate** (already implied by the doc's D3 step 3) must explicitly include: (a) `EditableGrid` click-to-edit + Enter/Tab/Esc + phantom-row Tab still work inside a lane at scale ≠ 1; (b) `dnd-kit` reorder tracks the cursor with the scale modifier (§2), including the placeholder-gap caveat; (c) Radix promote/resolution popovers anchor correctly (body portal, `@floating-ui/dom >= 1.4.3`, §3); (d) focus-driven pan replaces native `scrollIntoView`.
4. **`react-grid-layout` is not for the zoom vision** (no pan/zoom), but is a legitimate, separately-shippable option **if** the reorder-tables need is ever pursued *without* infinite zoom — it's MIT, actively maintained, and reorder is its core competence. Note it would duplicate `dnd-kit`'s role, so only if it replaces bespoke reorder wholesale.
5. **Net answer to the owner:** no scene-graph framework needed; add **one** small pan/zoom dependency (front-runner `@panzoom/panzoom`), keep `dnd-kit`, and treat the React Flow mindmap example + `infinite-canvas` starter as reference reading, not as the base. **No existing OSS project does spreadsheet-grade editable tables on an infinite zoom canvas** — GeDe would be building something close to novel, which is exactly why the doc's spike gate before D3 is the right call.
```
