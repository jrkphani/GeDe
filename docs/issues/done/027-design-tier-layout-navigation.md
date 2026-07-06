# 027: Design tier — layout cleanup + clearer depth navigation

- **Status**: SHIPPED (main, commit cd822c4)
- **Milestone**: M6 (Polish)
- **Blocked by**: 009, 011 (SHIPPED)

## Slice

As a designer on the Design tier — especially a **drilled-in child canvas** — the screen reads cleanly (balanced canvas + register, one calm empty-state message) and I can always tell **where I am and how to move up/down the recursion** at a glance.

## Bug report (from user testing)

> "This visually needs to be cleaned up and the navigation is not very obvious."

Observed on a child canvas (drilled into α, refining four parent bindings) with no sub-parameters/contexts yet. Concrete problems in the screenshot:

**Layout / visual clutter**
1. **Unbalanced two-pane**: the register floats as a short panel top-right with a large empty gap beneath it while the canvas fills the left — they don't read as the intended side-by-side pair where "neither is secondary" (SPEC §4.1). Register looks like an afterthought.
2. **Redundant empty-state messaging**: a full-width "This canvas needs parameters…" banner **+** canvas-center "Bind your first context" **+** "Refining …" lineage **+** an empty register all say "nothing here yet" at once.
3. **Orphan controls**: the "New context" button floats alone under the banner with no grouping; the Dimensions popover overlaps the register (horizontal cramping).
4. Large dead space in the lower two-thirds; overall the surface feels sparse *and* cluttered at the same time.

**Navigation not obvious**
5. **Breadcrumb is buried**: "Root • α" is small and low-contrast inside a crowded context bar — yet SITEMAP §2 makes breadcrumbs the *primary* depth navigation. Getting back to Root isn't prominent.
6. **Overloaded context bar**: breadcrumb + long lineage string + "Dimensions" + "Canvas/Coverage" toggle + "0/0 documented" + "0 drafts" all sit at similar muted weight — no hierarchy; hard to parse "where am I / how do I move."
7. **Duplicated lineage**: the parent tuple appears both in the context bar and again in the canvas center ("Refining …").
8. **Weak current-location cues**: the active tier tab (Design) and the fact that this is a *child* canvas (vs. root) are both subtle.

## Scope

- Rebalance the Design surface so canvas + register read as an intentional two-pane layout at wide widths (SPEC §4.1), including the **empty/near-empty** state.
- Consolidate the empty-state messaging into **one** calm prompt appropriate to the canvas's state (needs-parameters vs. needs-contexts), not three overlapping ones.
- Raise **navigation prominence**: make the breadcrumb the clear primary way up/down; give the context bar a legible hierarchy (location vs. controls vs. stats); remove the duplicated lineage.
- Make current location obvious: active tier, and root-vs-child canvas.

Out of scope: the canvas parameter-dot/label rendering (issue 023), grid column/zebra styling (024), button affordance (026), the recursion/drill mechanics themselves (issue 011 — this is presentation, not behavior).

## Design brief

- **Two-pane balance** (SPEC §4.1, STYLE_GUIDE §7 responsiveness): at ≥640px, canvas and register share the row as deliberate columns; the register keeps a sensible min-width and doesn't collapse to a floating strip. Below 640px they stack per the §7 table. The empty state should still fill the panels gracefully (no short floating register over dead space).
- **One empty-state voice** (STYLE_GUIDE §9 voice, §1 principles): show a single prompt keyed to what's actually missing — "This canvas needs parameters — add sub-parameters in the dimension manager" (child, no params) **or** "Bind your first context" (has params, no contexts) — never both. Drop the redundant center-lineage if the breadcrumb/context bar already states it.
- **Navigation hierarchy** (SITEMAP §2, STYLE_GUIDE §3 "hierarchy from weight and spacing"):
  - Breadcrumb `Root ▸ α ▸ …` is the prominent location/anchor — crumbs are clearly links (accent on hover/focus), current crumb is `--ink`, per SITEMAP §2. It should be the first, clearest thing in the context bar.
  - Separate the **location** (breadcrumb) from **controls** (Dimensions, Canvas/Coverage toggle) from **stats** (documented / drafts) with spacing/weight so the bar parses in one glance.
  - Show the child-canvas lineage **once** — prefer the breadcrumb + a single quiet "Refining …" line in one place, not two.
- **Current tier**: active tab per STYLE_GUIDE (ink + 2px accent underline) — verify it reads as clearly active.
- Keep it token-driven, square, calm (STYLE_GUIDE §1/§4); no new colors — hierarchy from weight/space.

**References**: SPEC §4.1 (side-by-side register + canvas, "neither is secondary"), §4.2 (canvas) · SITEMAP §2 (shell bands, context bar, breadcrumbs as primary depth nav) · STYLE_GUIDE §1 (principles), §3 (typographic hierarchy), §4 (space/shape/elevation), §7 (canvas responsiveness), §9 (voice) · issue 009 (design surface), issue 011 (recursion, breadcrumbs, child-canvas banners)

> This touches shell/layout defined across SITEMAP §2 and STYLE_GUIDE — treat concrete visual choices as small, reviewable refinements to those documents where they go beyond what's already specified. Because "cleaned up" is partly subjective, a focused design critique (see below) should precede implementation to fix the target.

## Test-first plan

1. Component (`DesignSurface.test.tsx`): in the child-no-params state, exactly **one** empty-state prompt renders (assert not both the banner and the center prompt); the register and canvas both mount in the two-pane container.
2. Component: the context bar renders breadcrumb, controls, and stats in distinct groups (assert grouping/structure), and the lineage appears once.
3. Visual/e2e: at ≥640px the register panel has a real min-width beside the canvas (not a short floating strip); at <640px they stack.
4. Regression: existing design/recursion e2e (drill-in/out, breadcrumbs) pass unchanged — this is presentation only.

## Acceptance criteria

- [ ] Canvas + register read as an intentional two-pane layout in the empty and populated states (no short floating register over dead space).
- [ ] A single, state-appropriate empty-state prompt (no triple messaging); lineage shown once.
- [ ] Breadcrumb is the clear primary depth-navigation; context bar parses as location / controls / stats at a glance; active tier + root-vs-child are obvious.
- [ ] `npm run verify` green; no behavioral regression in recursion/drill navigation.

## Implementation notes

- Recommend a short **design critique pass first** (the `critique` / `design-is` skill) to pin the exact layout + context-bar hierarchy before coding — the ask is partly subjective and worth one round of design direction.
- Likely files: `DesignSurface.tsx` (empty-state consolidation, two-pane container), the context-bar composition (breadcrumb + controls + stats grouping — issue 016/011 shell slots), `Breadcrumbs`/`ChildCanvasBanners` (011), and `base.css` layout for `.canvas-shell` + register panel min-width / two-pane grid (mind the HANDOFF gotcha: the design row briefly inherited `.projects`' `max-width` — check the shared wrapper).
- Consider splitting into (a) layout + empty-state cleanup and (b) navigation/context-bar hierarchy if one PR gets large (per the ≤5-file phase rule).
- Minor to verify while here: the footer showed "Exported Jotter v0.0.1" — confirm that's intended project-name presentation, not a stray label.
