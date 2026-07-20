# 099: Canvas-default — e2e coverage + a11y follow-ups (from 089-P7 review)

- **Status**: OPEN — non-blocking follow-ups banked from the 089-P7 default-flip adversarial review (2026-07-20). None block the P7 ship; each is a coverage/robustness improvement on the now-default canvas surface.
- **Milestone**: M7 (089 canvas). **Depends on**: 089-P7 (SHIPPED).

## Context

089-P7 made the React Flow canvas the DEFAULT workspace (capability-gated ≥ 1024px + not data-saver); `WorkspaceSurface` is the < 1024px / reduced-data fallback. The e2e strategy that shipped: the 21→22 `@dev-flag` `d3-canvas.spec.ts` specs are the **canvas** suite; the ~57 non-`@dev-flag` specs were re-pinned to the **WorkspaceSurface fallback** (via `e2e/workspaceSurface.ts::forceWorkspaceSurface`, a `prefers-reduced-data` matchMedia shim). Both surfaces ship, so both are covered — but the review flagged that a few behaviors are now tested ONLY on the fallback, plus one plausible latent bug and a touch-device gap. P7 added a canvas `main` landmark + a canvas axe smoke (WCAG2 A/AA serious/critical, design view) which passes; these items go beyond that.

## Follow-ups

1. **Canvas-side coverage for behaviors currently only on the fallback.** Add `@dev-flag` canvas specs (or widen the axe/interaction coverage) for:
   - **Hover-driven dot/context mute + emphasis** (fallback: `canvas-focus.spec.ts`, 4 specs) — the ring lives in a node on the canvas; hover-emphasis at node scale is untested.
   - **Container-width label-tier degrade** (`labelTierForWidth`; fallback: `canvas-parameters.spec.ts`, `canvas.spec.ts:110`'s 400px-crossing test).
   - **Dual-empty-state suppression** (fallback: `design-layout.spec.ts` — "exactly one empty-state prompt, not the canvas prompt too").

2. **Label-tier vs RF transform — INVESTIGATED (2026-07-20): NON-ISSUE, confirmed.** The tier is driven by `ResizeObserver`'s `entry.contentRect.width` (`Canvas.tsx:64`) = the ring's zoom-INVARIANT layout width, compared against `labelTierForWidth`'s 640/400 layout-px thresholds (`domain/canvasResponsive.ts`). Uniform RF `scale()` shrinks ring + labels together, so relative legibility holds and the tier correctly does NOT flip on zoom. No screen-space threshold to break. (Minor self-correcting one-frame flicker: the line-61 initial `getBoundingClientRect()` IS screen-space, immediately overwritten by the `contentRect` callback.) **Closed — no fix needed.** Optional: a canvas test asserting the tier is STABLE across zoom, to lock the invariant.

2b. **[FOUND] `CoverageMatrix` ARIA-grid structure is invalid (CRITICAL a11y, BOTH surfaces).** `CoverageMatrix.tsx:388` has `role="grid"` whose cells (`role="gridcell"`, `:441`) are ABSOLUTELY POSITIONED (`style={{ left, top }}`, `:452`) directly under the grid with **no `role="row"` parent** → axe `aria-required-parent` + `aria-required-children` (critical). Pre-existing on both the canvas twin and the WorkspaceSurface coverage view; never caught because no axe test covered the matrix (the P7 canvas axe smoke does now, which surfaced it). **Fix:** wrap each row's cells in a `role="row"` element (with `aria-rowindex`), likely via `display: contents` so the absolute-positioned layout is preserved; then re-enable the coverage-twin axe scan (a `test.fixme` sketch of it is in `d3-canvas.spec.ts`'s populated-register axe note). Verify on both surfaces.

2c. **[FOUND] `Canvas.tsx:130` hit-radius is transform-blind (touch-target shrinks under zoom).** `dotHitRadiusUnits(width)` is fed the zoom-invariant `contentRect` width but its own comments require the ON-SCREEN width so the dot hit target stays ~44px "at any zoom". At zoom 0.5 the physical target is ~22px — a real WCAG 2.5.5 target-size shrink under canvas zoom (the exact INVERSE of the label-tier non-issue: this consumer WANTS screen-space and gets layout-space). **Fix:** feed a screen-space width (e.g. track the live RF zoom and multiply, or read `getBoundingClientRect().width`) into the hit-radius calc only. Pairs with the touch/tablet item (#4).

3. **Automated a11y beyond the smoke.** The P7 axe smoke covers the design-register canvas view (serious/critical WCAG2 A/AA). Extend to: the Foundation + Architecture lanes on the canvas, the coverage-twin + satellite states, and keyboard-nav landmarks/focus order across RF nodes.

4. **Touch / tablet verification.** `canvasCapable()` gates on width + reduced-data only (no `pointer:coarse`/`hover:none`). iPad landscape (~1024 CSS px, touch) now gets the canvas by design (tablet-first). Manually verify — and ideally add coverage for — pan/zoom + node-drag-reorder on a real touch device; decide whether a `pointer: coarse` narrow-fallback nudge is warranted.

5. **Harden the cross-node Tab spec (`d3-canvas.spec.ts:414`) against full-suite flake.** It passes 3/3 in isolation but flaked once under full `npm run e2e` parallelism (focus-timing across table nodes via the `onExitBoundary` seam). Mitigated at P7 with `retries: CI ? 2 : 0` in `playwright.config.ts`; the real fix is a deterministic focus-settle wait (e.g. `waitForStableViewport` / awaiting the focused cell) so it never needs the retry.

## Non-goals

Re-adapting the WorkspaceSurface-pinned specs back onto the canvas (they test the fallback surface, which genuinely ships). Live mid-session resize re-seeding of `canvasMode` (a documented deliberate deferral — see `canvasMode.ts`).
