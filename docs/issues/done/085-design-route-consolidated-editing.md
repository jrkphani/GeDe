# 085: Design route — one editing zone, canvas-as-visual, proportional even-fill ring

- **Status**: ✅ SHIPPED — verified live (`index-CM_ZSx3K.js`, 2026-07-16)
- **Milestone**: M6 (UI polish, same track as 013/021/024/027/081/082). Design-route surgery only. Phase A is a pure client/render change (`layout` stays `fn(tree)`, ADR-0005 — no schema, no synced-column ripple). Phases B/C touch component structure + one store-selection wire, still client-only.
- **Blocked by**: none. **Sequences after 082 Phase 1** (shipped, `d413c03`) and the two canvas regression fixes (shipped, `5bbc8bc`: `MAX_DOT_HIT_RADIUS` hit-cap + spoke `pointer-events`). This issue reworks the same Design-route source, so land it on a green `main`.
- **Supersedes**: **082 Phase 2 (on-ring authoring — Direction C).** That phase turns the ring *into* an editing surface (ghost "+" gap segments, on-ring `foreignObject` rename). This issue makes the opposite, owner-chosen call — **the canvas is a visual representation only; all editing lives in the tables** — so 082 Phase 2 is formally shelved, not merely deferred. This issue also **completes 082's own unbuilt "Throughout — visual stability" clause** (`082:64-67`: "arc-span growth as an arc fills" + "ease any residual dot movement"), which Phase 1 dropped.

## User story

As a designer building the 2nd Tier — Design, I want to **define my whole model in one place with the keyboard** — pour in the dimensions and their parameters, then tab straight on into defining the contexts — **without the mouse ever crossing the screen, and without the same information repeated in three places**. Today the canvas sits *between* the two editing surfaces (rail on the left, register on the right), so every switch from "define the schema" to "define the contexts" is a mouse trip across the circle; a bottom **Composer strip** echoes the selected context's tuple and justification that the register row already shows; and the ring bunches every dimension's parameter dots — and therefore every context — into a narrow wedge, so with a few dimensions the circle looks lopsided and with several contexts they pile up in one arc. I want the two editing surfaces **adjacent and keyboard-continuous**, the redundant strip **gone**, and the canvas a **clean, proportional visual** I glance at — not something I reach across or read twice.

## The five settled decisions (owner, 2026-07-16 — build the spec around these)

1. **One editing zone.** The dimension/parameter **rail** and the context **register** are grouped into a single bordered surface with **one continuous tab order** (dimensions → parameters → contexts). The canvas moves **out from between them**.
2. **Canvas = visual only.** Primarily a visual representation. It moves to the side (proposed far-right; owner is not fixated on exact position). It is **not** an editing surface (this is what supersedes 082 Phase 2).
3. **Remove the Composer strip — it is a redundant echo.** Selecting a context (on the ring or elsewhere) **scrolls to and highlights that context's row** in the register instead of surfacing a second element. No duplicated information on screen.
4. **Justification editing = expand-the-cell-on-focus.** The strip's one genuinely non-redundant capability (a roomier prose editor than a narrow cell) is preserved by letting the register's justification **cell grow into a comfortable editor when the row/cell is focused** — no separate element.
5. **Proportional arcs + even parameter fill, animated.** Each dimension's arc span is **proportional to its parameter count** (a sparse dimension gets a short arc — explicitly fine); parameters are **evenly distributed across their arc**; adding/removing a parameter **re-flows the ring with a ~120ms reduced-motion-safe settle** (owner accepts the whole-ring motion). Dots "settle," never "jump."

## Investigation summary (grounds the design — file:line, from the UX + canvas-physics audits)

### The Composer strip is ~80% a read-only echo of the register row
Both render the same store (SPEC §58: *"Two projections, one tree. The circle canvas and the context register table render the same store."*). `src/components/Composer.tsx`:
- `:49` — `if (!selected) return null` → it exists **only** when one context is selected (a per-selection inspector, not a table).
- `:100-110` — a **read-only** legend (swatch + dimension + parameter per dimension), plain `<span>`s.
- `:112-122` — the `{Para …}` braces-tuple readout + duplicate-siblings badge.
- `:124-132` — a `MultilineEdit` **justification editor** (the one non-redundant thing — full-width prose vs a cramped cell).
- `:58,62-99` — in **compose mode** (`showPickers = composing && !readOnly`), the legend is replaced by a `Combobox` picker per dimension with the next-unbound dimension highlighted (`activeDimensionId`, derived at `DesignSurface.tsx:367` as `firstUnbound`) — the guided draft-binding form.

The register row already carries all of it and more: `src/components/ContextRegister.tsx` — symbol (`:125-133`), documented dot (`:140-153`), **one combobox per dimension** bind/unbind (`:155-175`), a justification cell using the **same** `kind:'multiline'` primitive (`:176-187`), children drill (`:188-209`), duplicate badge (`:210-236`), and a justification-first phantom "New context" row (`:266-278`). **Verdict:** in selection mode the legend/tuple/badge duplicate the row (whose cells are even *editable*); the compose pickers duplicate the phantom-row's per-dimension binding; only the roomier justification survives — and Decision 4 rehomes that into the row. So the strip can be removed outright.

### The canvas sits between the two editing surfaces
`DesignSurface.tsx` renders `.design-surface-row` as **rail · canvas · register** (the rail is `.dim-rail`, `base.css:1361`; layout `base.css:1295-1339`, canvas 40% / register 60% at `base.css:1377-1383`). The canvas being the middle column is exactly what forces the mouse across it when moving from schema entry (rail) to context entry (register).

### The clustering: fixed-step dots inside fixed, equal arcs (quantified)
`src/domain/canvasLayout.ts`:
- `:300` — `const segmentSpan = (2*Math.PI - totalGap) / n` → **every dimension gets an equal arc**, regardless of parameter count.
- `:337-339` — `offset = Math.min(DOT_START_OFFSET + j*DOT_ANGLE_STEP, maxOffset)` → dots at a **fixed 4° step from the arc start** (082 Phase 1's append-only choice), soft-clamped at `maxOffset` (`:336`).

The mismatch (fixed-4° dots inside an oversized equal arc) leaves huge empty tails: **4 params on an 84° arc (n=4) occupy the first ~16° — ~81% empty**; the table across n=2..8 runs 91%→59% empty, flipping to the *opposite* failure (dots clamped on top of each other) past ~9 params. Because a **context node is placed at the centroid of its bound dots** (node migration eases "to the recomputed centroid," `Canvas.tsx:355-362` per `082:33`), clustered dots ⇒ clustered centroids ⇒ **contexts pile into the same narrow wedge** — the owner's #6 pain. Spreading the dots spreads the contexts by construction.

### Chord-diagram prior art (what to copy)
`d3.chord()` sizes each group's arc **proportional to its total** and packs subgroups sequentially from the group start with a uniform `padAngle` between groups — GeDe already packs-from-start; it just kept a fixed-size container. No chord library freezes positions across data changes; they **recompute and tween (key-by-id)** — the correct invariant is *"never jump — settle,"* not *"never move."* GeDe already ships the two harder pieces: bundled spokes toward center (`spokePath`, `SPOKE_BUNDLE_PULL=0.35`, `canvasLayout.ts:197-223`) and hover-fade adjacency (`Canvas.tsx`). Sources: d3js.org/d3-chord, nivo.rocks/chord, d3indepth.com/enterexit, circos.ca ticks.

### Reusable anchors
- The node-migration transform transition (`Canvas.tsx:355-362` + `base.css` node rule) is the proven ~120ms reduced-motion-safe ease — the template to extend to **dots** (which today transition only `r`, `base.css:1153-1155`).
- `MAX_DOT_HIT_RADIUS` (`canvasLayout.ts:83`) + its render-side cap (`Canvas.tsx:124`, from `5bbc8bc`) is currently a **constant** derived from the fixed 4° step; once spacing is data-dependent it must be recomputed **per-layout** from the actual tightest slot.
- Context selection state already exists in `DesignSurface.tsx` (drives the current Composer + canvas emphasis); Decision 3 re-points it at "scroll+highlight the register row."

## Design brief

North star: **all editing in one keyboard-continuous place, zero duplicated information, canvas as a clean proportional visual.** Three independently-mergeable phases; A is lowest-risk and highest-visible-payoff, so it ships first.

### Phase A — proportional, even-fill, settling ring (canvas physics)
- **Proportional arcs.** Replace the equal `segmentSpan` (`canvasLayout.ts:300`) with span ∝ this dimension's parameter count: `segmentSpan_i = (2π − N·GAP) · (m_i / Σm)`, `GAP_RADIANS` as the inter-arc pad. A 1-param dimension gets a short arc (Decision 5 — fine). Guard the all-zero / single-dimension / zero-dimension cases (fall back to equal or full-ring, matching Canvas's existing empty geometry at `canvasLayout.ts:243`).
- **Even-fill dots.** Replace the fixed-step placement (`:337-339`) with `slot = segmentSpan/(m+1)`, dot j at `startAngle + slot·(j+1)`. **Clamp `slot` to a minimum gap** (the chord length matching the ≥44px hit target / `MAX_DOT_HIT_RADIUS`) so a crowded arc never collides; optionally a max gap so 2 params don't fling to the arc's extremes.
- **Per-layout hit radius.** `MAX_DOT_HIT_RADIUS` becomes a function of the actual minimum inter-dot spacing produced by the layout (not a constant); `Canvas.tsx:124`'s `Math.min(dotHitRadiusUnits(w), cap)` reads the per-layout cap. Preserves the no-overlap guarantee `5bbc8bc` established, now under variable spacing.
- **Settle, don't jump.** Move dot position onto a group `transform` (like nodes) and add a `transform` transition, `prefers-reduced-motion` → snap. Contexts inherit this via their centroid nodes (already transitioned). This is 082's dropped "ease residual movement" clause, finally implemented.
- **No new editing on the ring.** Explicitly *not* adding on-ring authoring (supersedes 082 Phase 2).

### Phase B — remove the Composer strip; selection highlights the row
- **Delete `src/components/Composer.tsx`** and its mount in `DesignSurface.tsx`; remove its styles from `base.css` (`.composer-*`).
- **Re-point selection.** The existing selected-context state drives, instead of the strip: (i) canvas emphasis (unchanged) and (ii) **scroll-into-view + highlight the matching register row** (a `row--selected` style + `scrollIntoView({block:'nearest'})` on the `ContextRegister` row keyed by context id). Selecting on the ring highlights the row; selecting the row emphasises the ring (two projections, one selection).
- **Justification expand-on-focus (Decision 4).** The register justification cell (`ContextRegister.tsx:176-187`) grows into a roomier multiline editor when its row/cell is focused (min-width/height bump + wrap), collapsing to a single-line summary when blurred. Reuses the existing `MultilineEdit` primitive — no new component.
- **Compose flow.** Drafting a new context uses the register's justification-first phantom row (`:266-278`) + per-dimension comboboxes (`:155-175`) — the guided sequencing the Composer's pickers provided now lives in the row (optionally: highlight the next-unbound dimension cell, reusing `activeDimensionId`).

### Phase C — the one editing zone + continuous tab order
- **Group rail + register.** Reorder `.design-surface-row` to place the rail and register **adjacent** inside one bordered "editing zone" container, with the canvas as a **side visual panel** (proposed far-right; a top band is an acceptable alternative — owner not fixated). Canvas gets a min-height floor so the ring stays legible without being the hero.
- **Continuous tab.** Wire a single tab order: dimension name → its parameters → next dimension → … → the register's first context cell → across the row → the phantom "new context" row. Bridges the rail→register seam so bulk entry never dead-ends (extends the 082 Phase 1 keyboard grammar across the boundary).
- **Tablet.** <640px the zone stacks (rail → register), canvas moves below as a collapsible visual. Phantom inputs stay native/touch-friendly.

## Files / layers touched (per phase, file:line)

**Phase A (canvas physics):**
1. `src/domain/canvasLayout.ts:300` — proportional `segmentSpan`; `:337-339` — even-fill `slot`; `:83` — `MAX_DOT_HIT_RADIUS` → per-layout min-spacing function; empty/degenerate-count guards (`:243`).
2. `src/components/Canvas.tsx:124` — read the per-layout hit cap; `:288-296` — dot position onto a group `transform`.
3. `src/styles/base.css:1153-1155` — extend the dot transition from `r`-only to `transform` (reduced-motion-safe).
4. `src/domain/canvasLayout.test.ts`, `src/components/Canvas.test.tsx` — rewrite append-only assertions (see tests).

**Phase B (remove strip):**
5. `src/components/Composer.tsx` — **deleted**; `src/components/DesignSurface.tsx` — remove the Composer mount, wire selection → row scroll/highlight.
6. `src/components/ContextRegister.tsx:176-187` — justification expand-on-focus; row `scrollIntoView` + `row--selected` keyed by selected context id.
7. `src/styles/base.css` — remove `.composer-*`; add `row--selected` + focused-justification-cell styles.
8. Delete `src/components/Composer.test.tsx`; update `DesignSurface.test.tsx` / `ContextRegister.test.tsx`.

**Phase C (editing zone + tab):**
9. `src/components/DesignSurface.tsx` — regroup rail+register into one zone, canvas to side; single tab order across the seam.
10. `src/styles/base.css:1295-1383` — `.design-surface-row` → editing-zone + side canvas; canvas min-height floor; tablet stack.
11. `e2e/design-layout.spec.ts` (+ canvas specs) — new layout + keyboard flow.

## Test-first plan (red first)

**Phase A:**
1. **Proportional arcs** — `canvasLayout.test.ts`: given param counts [4,3,2,1], the four `segmentSpan`s are proportional (±gap) and sum to `2π − N·GAP`; a 1-param dimension's arc is the smallest. Red today (equal slices, `:300`).
2. **Even-fill** — `canvasLayout.test.ts`: m params land at `startAngle + span/(m+1)·(j+1)`, spread across the whole arc (last dot near the arc end, not ~16° in). Red today (fixed 4° step).
3. **Min-gap clamp** — `canvasLayout.test.ts`: on a crowded small arc, adjacent dot spacing never drops below the hit-target chord; `MAX_DOT_HIT_RADIUS` equals half the actual tightest slot. Red today (constant cap).
4. **Settle, not jump** — `Canvas.test.tsx`: adding a parameter renders dots with the `transform` transition class; `prefers-reduced-motion` snaps. Rewrites 082's `:126` "dots never move" acceptance to **"dots never *jump*"**; invert the old append-only unit test.
5. **Contexts spread** — `canvasLayout.test.ts`: with dots even-filled, two contexts binding different parameters get centroid nodes in different arc regions (not the same wedge) — the #6 regression guard.

**Phase B:**
6. **Strip gone, no dup** — `DesignSurface.test.tsx`: no `Composer` in the tree; selecting a context adds `row--selected` to its register row and calls `scrollIntoView`. Red today (Composer renders).
7. **Justification expand-on-focus** — `ContextRegister.test.tsx`: focusing the justification cell grows it to the multiline editor; blur collapses to a summary; edits persist via the same mutation. 
8. **Compose in the row** — `ContextRegister.test.tsx`: a new context is created justification-first in the phantom row with per-dimension binds; the removed Composer pickers have an equivalent in the row.

**Phase C:**
9. **One editing zone** — `DesignSurface.test.tsx`: rail and register share one editing-zone container with the canvas outside it (not between them), at all dimension counts.
10. **Continuous tab** — `DesignSurface.test.tsx` / e2e: Tab from the last parameter phantom lands in the register (new-context row); Tab across register cells works; focus never strands on the canvas.
11. **e2e** — `e2e/design-layout.spec.ts`: define 3 dimensions + params then 2 contexts **entirely by keyboard**, no mouse crossing to the canvas; selecting a context on the ring highlights+scrolls its row; ring shows proportional arcs; reload persists.

Standing gate each phase: `npm run verify:fast` (tsc, eslint, stylelint, vitest) + `npm run e2e` for items 11.

## Acceptance criteria

- [ ] **One editing zone (Decision 1)** — rail + register are adjacent in a single surface; the canvas is not between them. Test 9.
- [ ] **Continuous keyboard flow (Decision 1)** — dimensions → parameters → contexts is one uninterrupted tab order; no mouse trip to switch surfaces. Tests 10–11.
- [ ] **Canvas is visual-only (Decision 2)** — no editing affordance on the ring; 082 Phase 2 on-ring authoring is not built. (Reflected in this spec superseding it.)
- [ ] **No duplicated information (Decision 3)** — the Composer strip is removed; selecting a context highlights + scrolls its register row instead. Test 6.
- [ ] **Roomy justification preserved (Decision 4)** — the register justification cell expands on focus; prose editing is not degraded by removing the strip. Test 7.
- [ ] **Proportional + even-fill (Decision 5)** — arc span ∝ param count; dots fill the arc; a sparse dimension gets a short arc. Tests 1–2.
- [ ] **Contexts spread (owner #6)** — contexts no longer pile into one wedge; they distribute with their bound dots. Test 5.
- [ ] **Settle, not jump** — parameter add/remove and reorder ease at ~120ms, reduced-motion-safe; no hard jump. Test 4.
- [ ] **No hit-target overlap under variable spacing** — `MAX_DOT_HIT_RADIUS` per-layout keeps dots individually clickable at any density (preserves `5bbc8bc`'s guarantee). Test 3.
- [ ] **STYLE_GUIDE / lint met** — `verify:fast` green: tokens-only colors (stylelint), wrapped primitives + a11y (§10: roving tabindex on canvas, `row--selected` conveyed non-color-only, focus rings), motion §8 (≤120ms, reduced-motion).

## Open tensions (named)

- **Supersedes 082 Phase 2.** The canvas-as-visual decision retires on-ring authoring. Update `082`'s status to note Phase 2 is superseded by 085 so no one builds both. 082 Phase 1 (shipped) is unaffected.
- **Whole-ring reflow on schema change.** Proportional arcs mean adding/removing a parameter re-angles *every* dimension's arc (not just the edited one) — the cross-dimension stability 082 Phase 1 bought is traded away. Owner accepted this for the proportional aesthetic; the ~120ms settle is what makes it legible. (The equal-arc even-fill alternative kept cross-dimension stability but not proportionality — rejected per Decision 5.)
- **`MAX_DOT_HIT_RADIUS` coupling.** It was a constant from `5bbc8bc`; Phase A makes it data-dependent. The recompute must run wherever the cap is consumed (`Canvas.tsx:124`) and stay covered by test 3, or the just-fixed overlap regression can silently return.
- **Context-node placement assumption.** This spec assumes context nodes sit at the centroid of their bound dots (per `Canvas.tsx:355-362`). Phase A must confirm that before relying on "spread dots ⇒ spread contexts" (test 5); if node placement is independent of dot angles, #6 needs a separate node-distribution fix.
- **Sequencing.** Phase A is independently shippable and delivers the most visible win — ship it first. B and C can land in either order after A; C depends on B (removing the strip frees the layout).

## References

`docs/issues/082-design-route-ux.md` (predecessor; Phase 1 shipped, Phase 2 superseded here; house format + the "arc-span growth + ease" clause this completes) · `docs/SPEC.md` §4.2 (canvas as `fn(tree)`, ADR-0005 no stored x/y), §58 ("two projections, one tree"), §48 (justification first-class/searchable) · `docs/STYLE_GUIDE.md` §6 (phantom-row grammar, Enter-down/Tab-right), §7 (canvas, ≥44px hit circle, responsiveness), §8 (≤120ms reduced-motion-safe motion), §10 (a11y, roving tabindex, non-color-only state) · `docs/adr/0002-n-dimensional-canvases.md` (n dims × m params, optimized 2–8), `adr/0005` (deterministic `layout=fn(tree)`) · code (audited, file:line): `src/components/Composer.tsx:49,58,62-132`, `src/components/ContextRegister.tsx:125-236,266-278`, `src/components/DesignSurface.tsx:367` + `.design-surface-row`/selection, `src/components/Canvas.tsx:124,288-296,355-362`, `src/domain/canvasLayout.ts:83,197-223,243,300,336-339`, `src/styles/base.css:1153-1155,1295-1383` · external: d3js.org/d3-chord, nivo.rocks/chord, d3indepth.com/enterexit, circos.ca (ticks/spacing) · decision-aid mockups (this session): proposed layout + dot-distribution comparison artifacts.
