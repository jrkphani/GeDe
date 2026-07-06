# 023: Canvas shows no parameters — add parameter labels + legible dots

- **Status**: SHIPPED (main, commit 32021a4)
- **Milestone**: M2 (canvas completeness gap) / M6 polish
- **Blocked by**: 008 (SHIPPED)

## Slice

As a designer looking at the circle canvas I can **see the parameters on each dimension** — each arc shows its parameter dots at a legible size, each labeled with its parameter name outside the arc — so the canvas is a readable projection of the design, not just empty rings. SPEC §4.2 and STYLE_GUIDE §7 both require this; it is currently unimplemented.

## Bug report (from user testing)

> "The canvas is not showing the parameters in each dimension."

Confirmed by driving the running app with Playwright + a screenshot (2 dimensions, 2 parameters each). The parameters **are** in the DOM but are effectively invisible and unlabeled:

| Finding | Evidence |
| --- | --- |
| Parameter dots render at **~4.3px on screen** | canvas SVG is 483px wide; dots are `r=5` in a 1000-unit viewBox → 5/1000 × 483 ≈ 2.4px radius. Specks. |
| **No parameter labels at all** | `Canvas.tsx` renders `.canvas-arc-label` for *dimension* names only; the dots map (lines 185–221) renders `<circle>` with **no `<text>`**. Probe: 0 parameter-label nodes; none of `Comfort/Warmth/Users/Buyers` appear anywhere in the canvas text — only the two dimension names do. |
| Net user experience | two labeled arcs with a few barely-visible unlabeled dots — you cannot tell what any parameter is, or often that any exist. |

This directly violates **SPEC §4.2** ("Parameter dots ordered along each arc; **labels outside**") and **STYLE_GUIDE §7** ("parameter dots on the arc; **labels outside (`--ink-muted`)**").

## Scope

- Render a **parameter label** for every dot, placed outside the arc (radially), in `--ink-muted`, per STYLE_GUIDE §7.
- Make dots **legible** at rest (larger visual radius and/or a clear ring) while keeping the invisible ≥44px hit circle already present in compose mode (STYLE_GUIDE §7 responsiveness: "every dot/node carries an invisible ≥44px hit circle regardless of visual radius").
- **Responsive label degradation** per STYLE_GUIDE §7's canvas-responsiveness table: full external labels ≥640px → truncated + tooltip 400–640px → legend/tap-to-reveal <400px. Reuse the existing `canvasResponsive` label-tier machinery that already drives the dimension arc labels (`labelTier`).
- Applies to root and child canvases (child-canvas dims are the parent tuple's sub-parameters — same rendering).

Out of scope: changing dot layout/geometry math (`canvasLayout.ts` already computes correct dot positions and carries `label` on each `DotGeometry` — this issue consumes that existing `label`), and compose-mode binding behavior (unchanged).

## Design brief

- **Labels outside the arc**: each dot's label sits just beyond `ARC_RADIUS` along the dot's own radial angle, `--ink-muted`, Inter (canvas-label size per STYLE_GUIDE §3/§7). `canvasLayout` already has the dot angle/position; add a `labelPos` per dot (mirror the arc's `labelPos` at `LABEL_RADIUS`) so placement stays in the pure layout fn (ADR-0005 — no geometry in the component).
- **Legible dots**: raise the visual radius to a readable size at typical scale (the arc stroke is 6px = 3 units either side of `ARC_RADIUS`; dots should read clearly against it — tune to STYLE_GUIDE §7). Keep the compose-mode bound-dot ring (issue 010) and the 44px hit circle.
- **Crowding**: when parameters are many/labels collide, degrade deterministically (truncate → legend) exactly like dimension labels — "No jiggle" (STYLE_GUIDE §7). Don't invent a new degradation rule.
- **Accessibility**: labels are visible text, not just `title`; dots/labels are not color-only (name + position carry meaning) per STYLE_GUIDE §10.
- **No motion on render** (STYLE_GUIDE §8) — labels appear with their dots, nothing animates on data load.

**References**: SPEC §4.2 (parameter dots + labels outside) · STYLE_GUIDE §7 (Canvas: dots on arc, labels outside `--ink-muted`; responsiveness table; 44px hit circles) · STYLE_GUIDE §3 (canvas label type), §10 (a11y) · issue 008 (canvas layout, `DotGeometry.label` already present), issue 009 (arc labels + `canvasResponsive` tiers) · ADR-0005 (layout is a pure fn — no geometry in the component)

## Test-first plan

1. Unit (`canvasLayout.test.ts`): each `DotGeometry` gains a `labelPos` outside `ARC_RADIUS` on the dot's radial angle; snapshot at n=2 and n=3 stays deterministic (ADR-0005 purity).
2. Component (`Canvas.test.tsx`): with 2 dims × 2 params, the canvas renders **4 parameter-name labels** with the correct text; a dot's visual radius is above the legibility threshold.
3. Component: label tier degradation — at a narrow measured width, labels truncate/collapse per the §7 table (reuse `labelTierForWidth`).
4. e2e (`canvas-parameters.spec.ts`, new): set up dims + params, assert the parameter names are visible on the canvas (the exact check that failed in this bug report — regression guard).

## Acceptance criteria

- [ ] Every parameter dot has a visible, correctly-placed label outside its arc (`--ink-muted`), matching SPEC §4.2 / STYLE_GUIDE §7.
- [ ] Dots are legible at rest at ≥640px; the 44px hit target is preserved.
- [ ] Labels degrade deterministically (full → truncate → legend) with container width, reusing the existing tier machinery.
- [ ] `npm run verify` green; layout snapshots regenerated and reviewed.

## Implementation notes

- `canvasLayout.ts`: `DotGeometry` already has `label`; add `labelPos: Point` computed at `LABEL_RADIUS` (or a dot-specific radius) on the dot's angle — reuse `pointAt`.
- `Canvas.tsx`: inside the `geometry.dots.map`, render a `<text className="canvas-param-label">` at `dot.labelPos`, gated by `labelTier` (hide/collapse at `legend` like arc labels); bump the `.canvas-dot` visual radius (token or constant) and verify against the compose-mode ring + hit circle.
- `base.css`: add `.canvas-param-label` mirroring `.canvas-arc-label` (`--ink-muted`, canvas-label size), plus the `[data-label-tier='legend']` hide rule already used for arc labels.
- Watch STYLE_GUIDE §7 crowding: at high parameter counts, labels will collide — start with truncate-on-narrow and a legend fallback; a full anti-collision solver is out of scope (note it if deferred, per "no silent caps").
