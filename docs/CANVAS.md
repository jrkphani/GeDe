# GeDe — Circle Canvas

## v1.0 · 2026-09-12 · companion to SPEC.md v0.2 (§4.2), STYLE_GUIDE.md v1.0 (§7), SITEMAP.md v1.0

The **circle canvas** is the Design tier's spatial projection: one arc per dimension around a ring, parameter dots on each arc, context nodes inside, spokes from a context to the parameters it binds. This document is the authoritative, implementation-normative specification of that surface as it ships on `main` (`3954c73`). It supersedes the eight-bullet sketch in SPEC.md §4.2; where the sketch and the shipped behaviour differ, §0 says so and the rest of this document describes what shipped. Every normative statement below is traceable to source, tests, or a closed issue — the reference in §14 lists them.

Two things this document is **not**: it is not a redesign proposal (nothing here is aspirational unless flagged in §13), and it does not restate the shell (SITEMAP.md) or the domain model (SPEC.md §2–3) beyond what the ring needs.

---

## 0. Status against SPEC v0.2 §4.2

| SPEC v0.2 §4.2 promised | Shipped |
| --- | --- |
| SVG, responsive; n **equal** arc segments with gaps, in dimension colour | **Changed.** Arcs are **proportional to parameter count** (issue 085). Equal spans only when every dimension has the same count (or all are empty). |
| n = 2 renders as two half-circles; n > 8 arcs compress and labels collapse to a legend | **Partly.** No n = 2 special case exists — two equal-count dimensions naturally produce two near-half-circles. There is **no n-driven compression or label collapse**; label collapse is driven by container **width** only (§5). n > 8 is untested and undocumented. |
| Canvas header exposes dimension management | **Changed.** Dimensions and parameters are authored in the persistent rail inside the register node, not on or above the ring (issues 082/085). `d` focuses the rail. |
| Context nodes at the centroid of bound parameters, hash-seeded jitter for collisions | **Shipped as written** (ADR-0005, issue 008). |
| Selecting a context draws n spokes and populates a composer bar (legend + tuple + statement) | **Changed.** Spokes ship — one per **bound** dimension, as bundled splines (issue 039). The **composer bar was removed** (issue 085); selection highlights the register row instead, which is the composer. |
| Children badge; double-click / Enter drills in | **Shipped, then re-shaped.** On the default canvas, drilling mounts a **live child core** (register + ring) beside the parent with an edge (issue 100); the fallback surface still navigates. Breadcrumbs/URL retained as spatial deep-links. |
| Empty state: dimmed arcs + "bind your first context" | **Shipped**, plus dual-prompt suppression for child canvases that still need seeding (issue 099). |
| Click dot while composing = bind; click bound dot = unbind; keyboard-completable | **Shipped** (issue 010) — with the guided pointer advancing to the next unbound dimension. Arrow-between-dimensions and type-ahead picker were **not** built on the ring; the register's per-dimension combobox is the keyboard path. |
| §4.4 "duplicate an existing context" composer entry point | **Not found** in source, tests, or issues. |
| §4.5 coverage matrix | **Shipped** as an **edge-connected twin node** below the ring (`v`), not a route swap, on the default canvas; the fallback surface still swaps views. |
| Invariant 5 — layout derived, never stored | **Held**, including React Flow node positions. |
| Invariant 6 — two projections, one tree | **Held** — selection is a single store field shared with the register. |

---

## 1. Principles

1. **Position is decorative; identity is the tuple.** A context's identity on the canvas is its binding set (SPEC invariant 1). Geometry is a pure function of `contexts × dimensions × parameters × bindings`; no coordinate is ever persisted or synced (SPEC invariant 5; ADR-0005). React Flow node positions on the workspace canvas are likewise derived (issue 089).
2. **Deterministic, byte-identical layout.** Same input → same SVG. There is no physics simulation in the interactive sense: d3-force is used only as a synchronous, fixed-tick collision solver seeded by a content hash, never by `Math.random()` (§4.5).
3. **The ring is presentational.** `Canvas.tsx` imports no store; everything arrives as props and leaves as callbacks (§3, §6). Selection, compose state, hover, and camera are owned by the host.
4. **Two projections, one tree.** The ring and the context register render the same store; selecting in one selects in the other (SPEC invariant 6).
5. **The camera is user-owned.** Focus, selection, compose, drill-in, coverage-twin open, node mounting, and measurement never pan, zoom, fit, or recentre the viewport. Only the Fit control and ⌘1/2/3 move the camera (§7.6; PR #17).
6. **Emphasis mutes others, never brightens self.** The resting state is fully legible; hover/focus/selection only fade unrelated elements (issue 028). This is what makes the grammar survive `prefers-reduced-motion` with nothing stranded.
7. **Authoring happens in the register, not on the ring.** The ring binds (compose mode) and selects; it does not create dimensions, parameters, or contexts directly (issue 085 decisions 1–3).

---

## 2. Where the ring is mounted

The same `<Canvas>` component (`src/components/Canvas.tsx`) is mounted in three places; none of them change its behaviour.

| Mount | Host | When |
| --- | --- | --- |
| **Primary ring node** on the unified workspace canvas | `DesignRingBody` in `src/components/DesignCoreAdapter.tsx`, inside React Flow node `workspace-canvas-design-ring` (`WorkspaceCanvas.tsx`) | Default on capable clients: viewport ≥ 1024 px and not `prefers-reduced-data` (`src/store/canvasMode.ts`, `canvasCapable()`; issue 089-P7). `?d3rf` forces it on for tests. |
| **Child core rings** (one per drilled-in context) | Same body, own store instance, React Flow node `workspace-canvas-design-ring:<contextId>` | Opened by drill-in (§7.3); subject to core LOD (§8). |
| **Fallback surface** | `src/components/DesignSurface.tsx` inside `WorkspaceSurface` | Narrow / reduced-data clients. Drill-in and `v` navigate instead of mounting nodes. |

On the workspace canvas the ring node sits **below** the design register node in a narrow vertical core (owner decision 2026-07-16: child clusters expand rightward, so a narrow core buys drill depth per screen). The coverage twin, when open, hangs below the ring on an edge (§7.4).

---

## 3. Data contract

### 3.1 Input — `CanvasLayoutInput` (`src/domain/canvasLayout.ts`)

```ts
DimensionInput   { id, name, color, sort }
ParameterInput   { id, name, sort }
ContextInput     { id, symbol, parentId: string | null }
CanvasLayoutInput {
  dimensions:            DimensionInput[]
  parametersByDimension: Record<dimensionId, ParameterInput[]>
  contexts:              ContextInput[]
  bindingsByContext:     Record<contextId, Record<dimensionId, parameterId>>
  childCountByContext?:  Record<contextId, number>
}
```

Dimensions and parameters are consumed in `sort` order regardless of array order. `bindingsByContext` is the only source of binding truth; an absent key is "unbound". `childCountByContext` overrides the derived count (number of contexts whose `parentId` is this context) when supplied.

### 3.2 Output — `CanvasGeometry`

```ts
Point        { x, y }                       // 1000×1000 user units
LabelAnchor  'start' | 'middle' | 'end'
ArcGeometry  { dimensionId, d, color, label, labelPos, labelAnchor, empty }
DotGeometry  { dimensionId, parameterId, x, y, color, label, labelPos, labelAnchor }
NodeGeometry { contextId, symbol, x, y, isDraft, childCount }
CanvasGeometry {
  viewBox: '0 0 1000 1000'
  arcs: ArcGeometry[]; dots: DotGeometry[]; nodes: NodeGeometry[]
  maxDotHitRadius: number                   // see §5.2
}
```

`layout(input)` is the only entry point. Exported constants: `CENTER`, `ARC_RADIUS`, `DOT_RADIUS`, `NODE_RADIUS`, `SPOKE_BUNDLE_PULL`; helper `spokePath(from, to)`.

### 3.3 Component props — `CanvasProps` (`src/components/Canvas.tsx`)

| Prop | Meaning |
| --- | --- |
| `dimensions`, `parametersByDimension`, `contexts`, `bindingsByContext` | Store rows, passed through to `layout()` |
| `selectedContextId`, `onSelect(id \| null)` | Controlled selection; the ring owns none |
| `composeContextId?` (null) | Non-null ⇒ compose mode for that draft |
| `activeDimensionId?` | Guided-binding pointer (§7.2) |
| `onBindParameter?(dimId, paramId)`, `onUnbindParameter?(dimId)`, `onExitCompose?()` | Compose callbacks |
| `onDrillIn?(contextId)` | Double-click / Enter on a node |
| `childCountByContext?` | Node badge counts |
| `lineage?: string[]` | "Refining a, b" line under the empty prompt on child canvases |
| `hoveredMark?`, `onHoverChange?(CanvasEmphasis \| null)` | Transient emphasis, owned by the host |
| `scale?` (1) | Quantised viewport zoom for hit-target sizing (§5.2) |

---

## 4. Geometry (normative)

All values are literal constants in `src/domain/canvasLayout.ts` unless noted.

### 4.1 Coordinate space

- Abstract space **1000 × 1000** user units; `viewBox="0 0 1000 1000"`. The SVG scales to its container; the geometry never rescales.
- `CENTER = 500`. `ARC_RADIUS = 400`. Arc band is 6 units wide: inner 397, outer 403 (`ARC_STROKE_HALF_WIDTH = 3`). Arcs are **filled bands**, not stroked paths (`.canvas-arc { stroke: none }`) — this realises STYLE_GUIDE §7's "6px stroke, butt caps".
- `LABEL_RADIUS = 360` (dimension label, inside the ring). `DOT_LABEL_RADIUS = 432` (parameter label, outside). `DOT_RADIUS = 8`. `NODE_RADIUS = 14`.
- Angles: **0 = 12 o'clock, increasing clockwise** (d3 convention). `pointAt(r, θ) = (500 + r·sin θ, 500 − r·cos θ)`.
- Arc path data is produced by `d3-shape`'s `arc()` **centred on the origin**; the renderer wraps it in `translate(500, 500)`.

### 4.2 Arcs

- Dimensions sorted by `sort`. `n = 0` ⇒ empty geometry (`arcs/dots/nodes = []`, `maxDotHitRadius = 400`).
- Fixed gap `GAP = 6°` between consecutive arcs. `availableSpan = 2π − n·GAP`.
- **Span is proportional to parameter count** (issue 085, decision 5): `span_i = availableSpan · m_i / Σm`. If `Σm = 0`, spans are equal (`availableSpan / n`). A dimension with `m_i = 0` among non-empty dimensions gets a **zero-width arc**; its label still renders. `arc.empty = (m_i === 0)`.
- Start angles accumulate: `start_i = Σ_{k<i} (span_k + GAP)`; dimension #1 starts at 12 o'clock. No rotation offset.
- Path: `arc({ innerRadius: 397, outerRadius: 403, startAngle, endAngle })`.
- **Not implemented / not special-cased:** n = 2 half-circles (falls out naturally when counts match), minimum arc span, any n-based compression or label collapse. n = 1 yields a single 354° arc.

### 4.3 Parameter dots

- Parameters sorted by `sort`. **Even fill**: `slot = span / (m + 1)`; dot *j* (0-based) at `angle = start + slot·(j + 1)`, position `pointAt(400, angle)`. First and last dots sit one slot in from the arc ends; the last dot never reaches the arc end.
- No lower bound on slot size: a dense arc compresses evenly (tested at m = 100).
- Adding or removing a parameter **re-flows every dot on that arc** (the 085 trade: proportionality over cross-edit stability). The renderer eases `cx/cy` and label `x/y` over `--motion-migrate` (120 ms) so dots settle rather than jump.
- Dots are keyed `"${dimensionId}:${parameterId}"` (`dotKey`, `src/domain/canvasAdjacency.ts`).

### 4.4 Labels

- **Dimension label**: `pointAt(360, midAngle)`, `text-anchor: middle`, always inside the ring, centred on the arc (issue 023).
- **Parameter label**: `pointAt(432, dotAngle)` on the dot's own ray. Anchor is side-aware with a dead-band at the poles: `sin θ > 0.2 ⇒ 'start'`, `sin θ < −0.2 ⇒ 'end'`, else `'middle'` (±0.2 ≈ ±11.5°). Labels read outward on their own side (STYLE_GUIDE §7).
- **Vertical declutter** (`declutterLabels`): per side (left/right of `CENTER.x`), sort by `y`, push each label to at least `MIN_LABEL_GAP = 20` below its predecessor, then shift the whole side so its mean `y` is unchanged. Only `labelPos.y` mutates; dots never move for label reasons.
- Truncation and legend behaviour are **renderer** concerns driven by the label tier (§5.1): at `truncated`, parameter labels cut to `PARAM_LABEL_TRUNCATE_LENGTH = 8` characters + `…`; at `legend`, dimension and parameter text labels are not rendered. Label positions are tier-independent — "shrink → truncate → legend, no jiggle" (STYLE_GUIDE §7).

### 4.5 Context nodes

- **Centroid**: mean of the positions of the dots the context binds, taken in dimension-sort order. Zero bindings ⇒ `(500, 500)`.
- **Seeded jitter**: offset the centroid by `JITTER_RADIUS = 8` at angle `hashUnit(id)·2π`, where `hashUnit` is FNV-1a over the context id. Purpose: no two simulation nodes ever share an exact start, so d3-force's internal `Math.random()` jiggle path is never taken.
- **Collision**: `forceSimulation` with **only** `forceCollide(COLLIDE_RADIUS = NODE_RADIUS + 6 = 20)`, `.stop()`, then exactly `SIMULATION_TICKS = 30` synchronous ticks with `alphaDecay = 1 − 0.001^(1/30)`. No charge, link, or centring forces.
- **Duplicate tuples**: identical centroid, different jitter ⇒ collision separates them; distinct on every render, byte-identical across renders.
- `isDraft = !isComplete(dimensionIds, boundKeys)` — complete iff every dimension of the canvas is bound and `n > 0` (`src/domain/completeness.ts`). Drafts are placed at the centroid of whatever bindings exist; there is no special draft placement.
- `childCount` from `childCountByContext` if provided, else derived from `parentId`.
- Placement has no explicit radial bounds; with ≥ 2 bindings the centroid is necessarily inside the ring.

### 4.6 Spokes

- `spokePath(from, to)` = `M from Q ctrl to` — a quadratic Bézier whose control point is `lerp(chordMidpoint, CENTER, SPOKE_BUNDLE_PULL = 0.35)`. Endpoints exact; the curve bends strictly toward the centre (issue 039, chord/edge-bundling aesthetic). Curvature is a fixed function of the endpoints — never animated, never density-adaptive (deferred, §13).
- The renderer draws one spoke per **bound** dimension, from node centre to dot position, `stroke = dimension.color`, for every context in the current adjacency set (§7.1) — which, absent hover, is exactly the selection.
- No routing or avoidance.

### 4.7 Determinism guarantees (tested)

- `layout` is pure: equal input ⇒ deep-equal output.
- Adding a context far from existing ones leaves every existing node byte-identical. (Collision is global, so a *colliding* addition can move neighbours; only the non-colliding case is pinned.)
- 100 contexts lay out within the frame budget asserted in `canvasLayout.test.ts`.

---

## 5. Responsiveness and hit targets

### 5.1 Label tier (`src/domain/canvasResponsive.ts`)

| Container layout width | Tier | Effect |
| --- | --- | --- |
| ≥ 640 px | `full` | Full external labels |
| 400 – 639 px | `truncated` | Parameter labels → 8 chars + `…` |
| < 400 px | `legend` | No text labels on the ring |

The width is the **ResizeObserver layout width** of `.canvas-shell`, which is invariant under React Flow's `transform: scale()`. Consequently the tier **does not change with canvas zoom** (issue 099-2; e2e "label tier is stable across zoom"). Unmeasured fallback width: 500. Shell width is `min(480px, 60vh, 100%)`, SVG `aspect-ratio: 1 / 1`, `max-height: 60vh` (`base.css`).

### 5.2 Hit targets (44 px floor, zoom-compensated)

- `maxDotHitRadius` (geometry): half the **global all-pairs** minimum distance between dots, across dimensions; `400` ("open") when ≤ 1 dot. This is the largest invisible hit circle that can never overlap a neighbour — so a tap can never bind the *wrong* parameter in compose mode (issue 085 phase A, 099-2c).
- `hitRadiusUnits({ layoutWidthPx, scale, maxDotHitRadius }) = min( dotHitRadiusUnits(layoutWidthPx · max(scale, 0.5)), maxDotHitRadius )` where `dotHitRadiusUnits(w) = 22 · 1000 / w` (i.e. a 44 px-diameter circle expressed in viewBox units at that on-screen size). `MIN_HIT_TARGET_PX = 44`, `MIN_HIT_SCALE = 0.5` (retained as a divide-by-zero guard; containment relies on the cap).
- `scale` is `quantizeHitScale(zoom) = max(0.5, floor(zoom / 0.25) · 0.25)`; NaN/∞ ⇒ 1. Flooring errs **larger** (never below 44 px) and the ring re-renders only when the zoom crosses a 0.25 bucket — never per frame (issue 099-2c).
- Pinned values (800 px layout): scale 0.5 → 55 units, 1 → 27.5, 2 → 13.75, 0.2 → 55.
- On a crowded ring the per-layout cap wins and the effective target **falls below 44 px** by design; STYLE_GUIDE §10's floor is honoured everywhere the cap allows.
- Every dot renders an invisible `circle.canvas-dot-hit` of that radius under the 8-unit visible dot.

---

## 6. Rendering and DOM contract

Paint order top → bottom inside `svg.canvas-svg`. Class names and `data-*` attributes are load-bearing: CSS, unit tests, and e2e specs select on them.

| Layer | Element | Attributes / modifiers |
| --- | --- | --- |
| Shell | `div.canvas-shell` | `data-label-tier="full\|truncated\|legend"`; ResizeObserver source |
| Root | `svg.canvas-svg` | `viewBox`, `role="img"`, `aria-label="Context canvas"`, `data-empty="true\|false"`. Click on the SVG itself (not a child) ⇒ `onSelect(null)` |
| Arc | `g.canvas-arc-group` | `data-dimension-id`, `data-active="true\|false"` (§7.2), `.canvas--muted` (§7.1); mouseenter/leave ⇒ `onHoverChange` in read mode |
| | `path.canvas-arc` | `data-dimension-id`, `data-empty`, inline `fill: <dimension color>` |
| | `text.canvas-arc-label` | Omitted at `legend` tier |
| Dot | `g.canvas-dot-group` | `data-dimension-id`, `data-parameter-id`, `--compose`, `--bound`, `.canvas--muted`; `tabindex="0"` in read mode only; focus/blur ⇒ `onHoverChange` |
| | `circle.canvas-dot-hit` | Invisible, `r = hitRadiusUnits` |
| | `circle.canvas-dot` | `r = 8`, inline `fill`; bound in compose: `r: 11px`, 2 px `--paper` stroke |
| | `text.canvas-param-label` | Truncated at `truncated` tier; omitted at `legend` |
| Spoke | `path.canvas-spoke` | `data-dimension-id`, inline `stroke`, `d = spokePath(...)`, `pointer-events: none`; one per bound dimension per adjacent context |
| Node | `g.canvas-node` | `data-context-id`, `role="button"`, `tabindex` (roving), `aria-label` (§10), `aria-pressed` (selected), `transform="translate(x, y)"`, `--draft`, `--dimmed`, `.canvas--muted` |
| | `circle` | `r = 14`; draft ⇒ hollow, `stroke-dasharray: 3 2`, 1.5 px |
| | `text` | Context symbol, `--font-mono`, `--paper` on `--ink` |
| | `text.canvas-node-badge` | Child count, rendered only when `> 0` |
| Empty | `text.canvas-empty-prompt` | "Bind your first context" |
| | `text.canvas-empty-lineage` | "Refining a, b" when `lineage` is non-empty |

Selection has **no** `data-selected`; it is `aria-pressed="true"` (styled `stroke: var(--accent); 2px`). Non-selected nodes get `--dimmed` (opacity 0.4) while any selection exists.

---

## 7. Interaction grammar

### 7.1 Read mode — emphasis (hover / focus / selection)

- `resolvedEmphasis = hoveredMark ?? (selectedContextId ? { id, role: 'context' } : null)`. `hasEmphasis = !composing && resolvedEmphasis !== null`. **Emphasis is fully suppressed while composing** (all hover/focus handlers are detached).
- Adjacency (`adjacentSet`, `src/domain/canvasAdjacency.ts`) is symmetric across the three roles (issue 028, STYLE_GUIDE §7):

| Emphasised element | Stays at full strength |
| --- | --- |
| **context** | itself + the dots it binds (no arcs) |
| **parameter dot** | the dot itself + every context bound to that parameter (any dimension) |
| **dimension arc** | the arc + all its dots (bound or not) + every context with a binding in it |

- Everything else gets `.canvas--muted` ⇒ `opacity: var(--canvas-muted)` = **0.2** light / **0.22** dark. Transition is opacity-only, ≤ 100 ms; `prefers-reduced-motion` makes it instant (STYLE_GUIDE §8). Resting state (no hover, no selection) is fully legible.
- Spokes are drawn for every context in the adjacency set — so hovering a parameter shows the spokes of everyone who uses it ("who uses this parameter?"); with no hover, the spokes belong to the selection.
- `onHoverChange` fires `{ id, role }` on mouseenter/focus and `null` on mouseleave/blur. Hosts keep it in component state and reset it to `null` when the canvas changes.
- **Selection**: click or Enter/Space on a node ⇒ `onSelect(id)`; the host writes `useContexts.select(id)` (shared with the register) and announces `describeContext(ctx)` — e.g. "α — Comfort, Users, draft" — through the status live region. Clicking the SVG background ⇒ `onSelect(null)`. Escape on a focused node clears selection (or exits compose, §7.2).
- **Roving tabindex**: the selected node is the tab stop, else the first node. ← ↑ / → ↓ move selection cyclically in layout order and move DOM focus with it.

### 7.2 Compose mode — guided binding

State machine `src/domain/composeMode.ts`; per-canvas store `src/store/canvasCompose.ts` (`createCanvasComposeStore`).

- **Entry points**: `c` (§7.5), the register's "New context" command, a coverage-twin gap cell (§7.4). `enterCompose(initialBindings?)` is a no-op if a draft is already open; otherwise it **creates a real, persisted context** via `useContexts.create()`, applies any initial tuple in dimension-sort order (wrapped in `commandLog.batch('compose from gap')` when pre-filled), selects it, and announces "Composing α — bind `<first unbound dimension>`".
- **Active dimension** is *derived*, not stored: `firstUnbound(dimensionsBySort, bindings)`. `data-active="true"` on that arc, `"false"` on the rest (opacity 0.4). In read mode every arc is `data-active="true"`.
- **Dot click** while composing: bound dot ⇒ `onUnbindParameter(dim)`; otherwise `onBindParameter(dim, param)`. After a bind the pointer advances to the next unbound dimension after the bound one, wrapping; after an unbind the pointer becomes that dimension. **Read mode has no dot click handler at all** (SPEC invariant 2 — the ring never blocks or mutates outside compose).
- **Completion** fires exactly once, on the transition incomplete → complete: announces "α complete — a, b, c". "Documented" additionally requires non-empty justification prose (`documentedStatus`: draft → complete → documented, `src/domain/completeness.ts`); nothing gates saving.
- **Exit**: `exitCompose` clears the compose id but **keeps the draft**, announcing "Draft α kept" with the action "Discard draft α". Escape exits compose (window capture listener; defers to an open Radix popover). Clicking away (`onSelect(null)`) while composing routes to `exitCompose`. Drill-in (double-click / Enter) is **disabled** during compose.
- `clearIfMissing` drops compose state if the draft vanishes (undo, sync).
- **Not on the ring**: arrow-key movement between dimensions, type-ahead parameter picking, ⌘⏎, duplicate-tuple warnings. Duplicates are surfaced by the register (`findDuplicateContextIds`, `ContextRegister.tsx`).
- **LOD interaction**: `registerCollapsed = zoom < 0.6 && !composeContextId` — entering compose force-expands a zoomed-out register so the tuple can be authored.

### 7.3 Drill-in and live child cores (issue 100)

- Nodes with `childCount > 0` show `text.canvas-node-badge`. Double-click or Enter on a node ⇒ `onDrillIn(id)` (not while composing).
- **Fallback surface**: navigates to the child canvas (`contextPath: [...path, id]`); breadcrumbs `Root ▸ α ▸ α2`, browser back mirrors them.
- **Workspace canvas**: `useCanvasSatellitesStore.openSatellite(id, parentCoreId)` — idempotent, carries **no camera state**. `WorkspaceCanvas` then emits two nodes per open satellite — `workspace-canvas-design-lane:<ctx>` (child register) and `workspace-canvas-design-ring:<ctx>` (child ring) — with `storeCanvasId = ctx`, `depth = coreDepth(...)`, connected to the parent register by edge `edge:<parentRegister>:<childRegister>` (`.wc-edge`). Satellites lay out as a column to the **right** of their parent, stacked by `satelliteHeight + vGap`, parents before children, and clear the widest **measured** design-column node (`src/domain/clusterLayout.ts`).
- **Per-canvas stores**: `getCanvasStores(key)` registry; `resolveCanvasStores(undefined)` is the default (root) instance; `CanvasStoresProvider` injects an instance into a child core; `releaseCanvasStores` tears down non-default instances on collapse. The `parameters` store stays global (dimension-keyed). Undo is one global history.
- **Active core**: `activeCanvas` (`canvasId ?? 'root'`) is set on body `focusin`/`pointerdown`; the `c`/`v`/`d` verbs are gated on it (§7.5). Collapsing a core cascades to its descendants, releases their stores, and resets `activeCanvas` if it pointed at a released core. Any route change resets all satellites.
- The child ring is the **same `<Canvas>`** with its own store instance; child context symbols (α1, α2 …) are plain `ContextRow.symbol` values, not special-cased.

### 7.4 Coverage twin (`v`)

- `v` toggles `useCanvasCoverageStore` (`toggle` / `collapse` / `setOpen`, all idempotent, no camera state). The register header's Canvas / Coverage buttons call the same store.
- Node `workspace-canvas-coverage-twin` (type `coverageTwin`, `div.wc-node--coverage-twin[data-testid="wc-coverage-twin"]`), edge `edge:workspace-canvas-design-ring:workspace-canvas-coverage-twin`, positioned below the ring. Deep link `?view=coverage` opens it; route change resets it.
- A gap cell (`data-documented="false"`, aria "Unexplored — `<tuple>`") ⇒ `onComposeTuple(tuple)` ⇒ `enterCompose(bindings)` as one command-log batch. **No camera call** (e2e "gap cell composes without moving the camera").
- Stat "N / M documented" (aria "N of M tuples documented") in the register header and in the matrix; live as dimensions/parameters change. Coverage math: `tupleSpaceSize = ∏ mᵢ` (0 if any `mᵢ = 0`); a tuple is documented iff ≥ 1 context on it is complete **and** `documented`; duplicates stack.
- **Fallback surface**: `v` swaps the view (`canvas ↔ coverage`) and the matrix **replaces** the ring.

### 7.5 Keyboard map

| Key | Scope / gate | Effect |
| --- | --- | --- |
| `c` | canvas view · `activeLane === 'design'` · `activeCanvas === thisCore` · not in a text field · not read-only | `enterCompose()` |
| `v` | lane + core gated | Toggle coverage twin (fallback: view swap) |
| `d` | lane + core gated | Focus the dimension rail's first phantom input |
| `Esc` | while composing (window capture; defers to an open popover) | `exitCompose` — draft kept |
| `Esc` | focused node | Exit compose, else `onSelect(null)` |
| `Enter` / double-click | focused node, not composing | Drill in |
| `←↑` / `→↓` | focused node | Cycle selection in layout order |
| `Tab` | rail's last empty phantom | Jump to the register's phantom row |
| `⌘/Ctrl + 1 / 2 / 3` | any time a canvas instance is published | Pan to Foundation / Architecture / Design lane **at the current zoom**; sets `activeLane` |

Lane gating (issue 089 D2): `useActiveLaneStore.activeLane` is set on body focus/pointerdown and by ⌘-digit; `c`/`v`/`d` short-circuit unless it is `design` **and** the core is the active one (issue 100). Globals (`⌘K`, `⌘Z`, `⇧⌘Z`) are in SITEMAP §4.

### 7.6 Camera rules (PR #17 — user-owned viewport)

- No initial fit on mount. Selection, focus, typing, compose enter/exit, drill-in, twin open/close, node mount, and measurement **never** change the viewport. Fit exists only as the control button. Only ⌘1/2/3 and explicit user gestures move the camera.
- Gesture grammar (Numbers/Excel): plain wheel / trackpad **pans** 2-D (`panOnScroll`, free mode); **Cmd/Ctrl + wheel** or **pinch** zooms (`zoomActivationKeyCode: ['Meta','Control']`, `zoomOnPinch`); double-click is reserved for drill (`zoomOnDoubleClick={false}`). One capture-phase gesture router on `.workspace-canvas` (`src/components/canvasGestureRouter.ts`, PR #23) guarantees zoom works uniformly over tables and ring alike and drives real two-finger pinch itself.
- Zoom bounds `minZoom 0.2`, `maxZoom 2`.

---

## 8. Level of detail

The **ring has no LOD of its own** — it renders the full geometry at every zoom. What changes with zoom is around it:

| Threshold | Constant | Behaviour |
| --- | --- | --- |
| zoom < 0.6 | `LOD_ZOOM` | Design register collapses to a tuple summary — **unless composing** (§7.2) or a cell is being edited (edit-aware: focus is tracked in a ref; a live editor is never unmounted) |
| zoom < 0.35 | `LANE_LOD_ZOOM` | Lane nodes render as summary cards; child cores are eligible for demotion |
| Child core | `shouldCoreBeLive({ zoom, depth, coreRect, viewportRect, isEditing }, { minZoom: 0.35, maxLiveDepth: 2, offscreenMargin: 960 })` | Demoted if zoom < 0.35 **or** depth > 2 **or** the core rect is off-screen beyond a 960-unit margin; **editing always wins**; the primary core never demotes. Boundaries are inclusive-live |

- Demotion is a **render-only stub swap**: `div.design-core-ring--stub > .wc-core-stub[data-testid="wc-core-stub"]` showing "◍ N contexts"; stores are kept, so promotion is instant and lossless.
- 0.35 is deliberately below 0.6 so a small project's ~0.5 fit-view keeps real grids and rings (issues 089-P5, 093).
- Re-render gating: `layout()` is memoised on its data props; `scale` is the quantised zoom (§5.2); register and core LOD are boolean selectors. Nothing on the ring re-renders per zoom frame. `onlyRenderVisibleElements` is deliberately **off** (it unmounts off-screen nodes and breaks zoom-into-node reads).

---

## 9. Empty and degenerate states

| State | Rendering |
| --- | --- |
| No contexts | `data-empty="true"`; arcs at opacity 0.35; `text.canvas-empty-prompt` "Bind your first context"; on a child canvas, `text.canvas-empty-lineage` "Refining a, b" |
| Child canvas whose dimensions still need sub-parameters (`needsSeeding`) | The ring's empty prompt is suppressed (`[data-suppress-canvas-empty]`) so only the register's `.canvas-seed-hint` speaks — one prompt, never two (issue 099) |
| Fewer than 2 dimensions | `.canvas-floor-hint` "Add a second dimension to start binding contexts."; "New context" disabled. (The removal guard "Minimum 2 dimensions…" belongs to `DimensionManager`, not the ring.) |
| `n = 0` | Empty geometry; SVG still mounts with `data-empty="true"` |
| A dimension with 0 parameters | Zero-width arc; label still drawn; contributes nothing to centroids |
| Zero-binding context | Node at `(500, 500)` + jitter; `--draft` |
| 1 dot total | `maxDotHitRadius = 400` (open hit circle, capped only by the 44 px rule) |

---

## 10. Accessibility

- `svg[role="img"][aria-label="Context canvas"]`.
- Context nodes: `role="button"`, `aria-label = describeContext(ctx)` ("α — Comfort, Users, draft"), `aria-pressed` for selection, roving `tabindex`, arrow-key navigation, Enter/Space activate, Escape clears. Hover drop-shadow on `:hover`.
- Parameter dots: `tabindex="0"` in read mode (focus ⇒ emphasis); no role or label of their own — the dimension arc label and position carry meaning; colour is never the sole channel (STYLE_GUIDE §10).
- Focus ring: global `:focus-visible { outline: 2px solid var(--accent) }`.
- Announcements via `useStatusStore.announce` (status-bar live region): compose enter / exit / complete, selection.
- Touch targets: 44 px invisible hit circles, zoom-compensated (§5.2), subject to the no-overlap cap.
- Verified axe-clean (WCAG 2 A/AA serious/critical) for the canvas, the populated register, the coverage twin, and each lane (e2e); the canvas is one `main` landmark and Tab stays inside it.

---

## 11. Visual and motion contract

Tokens live in `src/styles/tokens.css`; rules in `src/styles/base.css`.

- **Dimension colours**: `DIMENSION_PALETTE` (8 hex values — violet, teal, orange, magenta, ochre, blue, rose, slate; **never green**, which is reserved chrome per STYLE_GUIDE §2.2), `src/theme/palette.ts`; `paletteColor(i)` cycles by creation order; mirrored as `--dim-1 … --dim-8`. Stored per dimension row, user-overridable, and applied inline: `fill` on arc and dot, `stroke` on spoke. The presence palette (6 hues, issue 038) is deliberately disjoint so a collaborator cue never reads as a dimension.
- **Arcs**: 6-unit filled band (§4.1), `stroke: none`; empty-state opacity 0.35; inactive-in-compose opacity 0.4.
- **Dots**: `r = 8`; bound-in-compose `r: 11px` with 2 px `--paper` stroke; `r` transitions over `--motion-fast`; `cx/cy` and label `x/y` ease over `--motion-migrate` (120 ms).
- **Spokes**: `fill: none; stroke-width: 2px; opacity: 1`; fade-in keyframe `canvas-spoke-in` 100 ms; `pointer-events: none`.
- **Nodes**: `fill: var(--ink)`; symbol in `--font-mono`, `--paper`; draft hollow with `stroke-dasharray: 3 2`, 1.5 px; selected `stroke: var(--accent) 2px`; dimmed 0.4; `transform` eases 120 ms; badge `--text-label`, muted.
- **Labels**: `--font-ui`, `--text-mono` (13 px), `--ink-muted`.
- **Muting**: `--canvas-muted` 0.2 (light) / 0.22 (dark); opacity-only.
- **Drill motion**: `.canvas-zoom` scales 0.96 → 1 over `--motion-drilldown` (200 ms), `transform-origin: 40% 50%`, keyed on canvas id — the one choreographed motion (STYLE_GUIDE §8). Child cores carry a `border-top: 2px solid var(--accent)` depth accent.
- **Reduced motion**: `prefers-reduced-motion` removes every transition and animation, including drill-down; because emphasis only mutes others, nothing is stranded.
- **Dark mode**: token swap only (`[data-theme='dark']`); no ring-specific rules.
- **Ground**: the graph-paper grid shows behind the circle — the drawing sits on the paper (STYLE_GUIDE §7).

---

## 12. Verification targets

Behaviour above is pinned by these tests; a change to the ring that breaks one of them is a spec change and belongs in §0/§13.

**Geometry & domain (vitest)** — `src/domain/*.test.ts`

- `canvasLayout`: one arc per dimension at n = 2/3/4; purity; same-tuple contexts distinct and deterministic; draft flag; zero-parameter arc has no NaN; empty geometry; adding a context changes only its node; dot labels outside the arc with side-aware anchors and vertical de-collision; proportional spans + `Σm = 0` fallback; even fill, whole-arc spread, settle-on-add, centroid follows; `maxDotHitRadius` is half the true global minimum including cross-dimension pairs; contexts spread across regions; 100 contexts within budget; `spokePath` curved, deterministic, bends inward, endpoints exact.
- `canvasAdjacency`: the three role sets, boundary cases, determinism.
- `canvasResponsive`: 640/400 tiers; 44 px → viewBox units; zoom compensation honours the cap; `quantizeHitScale` never 0 across 0.2–2 and monotonic.
- `composeMode`: bind advances the pointer; completion fires exactly on the n-th bind; unbind/re-bind semantics.
- `coverage`: every tuple reachable exactly once for any axis choice; partition matches a brute-force oracle; stat counts complete + justified only; duplicate stacking; two-largest default axes.
- `clusterLayout`: satellite to the right, stacked, one edge each, clears measured width, grandchild anchored to its parent column, pure.
- `coreLod`: editing overrides every demotion axis; inclusive `minZoom`; depth ≤ 2; off-screen margin.
- `completeness`, `laneLayout`, `d3CanvasNav` (⌘2 is a position-only pan; snaps under reduced motion).

**Stores (vitest)** — `canvasSatellites` (open carries no camera state; idempotent; cascade collapse returns ids), `canvasCoverage` (idempotent, no camera state), `canvasStores` (registry lifecycle), `coreEditing` (per-core isolation, stable reference on no-op).

**Component (vitest + RTL)** — `src/components/Canvas.test.tsx` (43 tests): arc/dot/node counts; empty arc; draft dashed ring; empty prompt; tier switch on resize; selection aria/dim/spokes/roving tabindex/arrow wrap/Escape/background click; drill via double-click and Enter; child badge; dot labels and tier degradation; compose — read mode never binds, bind/unbind, hit circle = min(44 px, cap), zoomed-out host scales up, crowded arc caps, active-dimension mark, Escape keeps draft; adjacency by hover and focus, lock + hover composition, no hover-mute while composing; dot easing and the reduced-motion blanket. `CoverageMatrix.test.tsx`: live stat, gap composes the full tuple, documented cell selects, virtualised ~10 k cells, empty-dimension prompt.

**e2e (Playwright)** — `e2e/d3-canvas.spec.ts` (canvas-serial lane; all `@dev-flag`-tagged as a rollback lever): register over ring with cross-node `c` compose at zoom ≠ 1; register extends right and collapses at 0.6; live independent child core; child clears the widened register; `v` opens the twin with the URL unchanged and `v` collapses it; gap cell composes **without moving the camera** with the stat live; volume overview renders summary cards below 0.35 and zooming in remounts real grids; an editing node never collapses on zoom-out; compose force-expands the register; axe-clean canvas / register / twin / lanes; single `main` landmark; label tier stable across zoom; click and tap never pan the viewport; camera stable while focusing, typing, mounting; wheel pans, Ctrl-wheel zooms, live %; touch pan / real two-finger pinch / tap; child ring suppresses its empty prompt; hover-mute on the ring. Fallback-surface specs: `canvas`, `canvas-focus`, `canvas-compose`, `canvas-selection`, `canvas-spline`, `canvas-parameters`, `design-layout`, `coverage`, `recursion`, and the promote-to-dimension rows of `architecture`.

---

## 13. Deliberate non-features, known gaps, open items

### 13.1 Deliberate (do not "fix" without a decision)

- No on-ring authoring of dimensions, parameters, or contexts; no composer bar; no ghost "+" gaps (issues 082 P2 shelved, 085 decisions 1–3).
- No arrow-between-dimensions or type-ahead on the ring; the register combobox is the keyboard path.
- Spoke curvature is a single constant (`0.35`); density-adaptive bundling was deferred (issue 039).
- Dots re-flow on parameter add/remove (proportional arcs over cross-edit stability, issue 085).
- The ring never moves the camera; there is no auto-fit (PR #17).
- `onlyRenderVisibleElements` and `content-visibility` are off (issue 089-P5).
- Visual-snapshot e2e was descoped to structural assertions (CI font/OS drift, issue 008).
- Rich identifiers stay plain (`name`, `symbol` feed the tuple hash).

### 13.2 Gaps and open items

- The ring has no LOD of its own; a very dense ring at 0.2 zoom renders every dot and label.
- n > 8 dimensions: SPEC promised compression + legend; nothing is implemented, tested, or documented. Behaviour is "functional but unoptimised".
- No e2e for the child-core stub swap (106-①) or grandchild wiring (106-②); grandchild breadcrumb depth follow-up open.
- Touch: physical-hardware fidelity (momentum, palm rejection) is manual-only; the touch drag-reorder spec is `test.fixme` (CI-load flake).
- Bare Escape after focus has left the canvas does not clear selection (issue 009, accepted).
- Doc drift: issues 101, 093, 089-P6 describe a focus-pan camera model superseded by PR #17; the register-node "New context" onboarding affordance has no issue record; SITEMAP §4 lacks the wheel / Cmd-wheel grammar (this document is now the reference for both).

---

## 14. References

- **ADRs**: 0001 (circle, one arc per dimension, position decorative), 0002 (optimised range 2–8 dimensions), 0005 (pure deterministic layout, collision-only d3-force).
- **Issues (`docs/issues/done/`)**: 008 (first ring), 009 (selection, spokes), 010 (compose/guided binding), 012 (coverage), 023 (outward labels), 028 (adjacency emphasis), 039 (bundled splines), 082 (rail authoring), 085 (proportional arcs, composer bar removed, hit radius), 089 (unified canvas D1/D2/D3, P5 LOD, P7 graduation), 093 (register extends right, 0.6 collapse), 096 (deploy gate), 100 (live child cores), 104, 106 (child-core refinements, culling); 099 (open: 44 px zoom compensation, label tier, dual-prompt, touch).
- **PRs**: #17 (user-owned camera, Numbers/Excel gesture grammar), #23 (uniform gesture router — zoom over tables).
- **Source**: `src/domain/canvasLayout.ts`, `canvasAdjacency.ts`, `canvasResponsive.ts`, `composeMode.ts`, `coverage.ts`, `completeness.ts`, `clusterLayout.ts`, `coreLod.ts`; `src/components/Canvas.tsx`, `DesignCoreAdapter.tsx`, `DesignSurface.tsx`, `WorkspaceCanvas.tsx`, `CoverageMatrix.tsx`, `canvasGestureRouter.ts`, `d3CanvasNav.ts`; `src/store/canvasCompose.ts`, `canvasSatellites.ts`, `canvasCoverage.ts`, `canvasStores.ts`, `activeCanvas.ts`, `coreEditing.ts`; `src/styles/base.css`, `tokens.css`; `src/theme/palette.ts`.
