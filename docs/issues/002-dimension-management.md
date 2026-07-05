# 002: Dimension management on the root canvas

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 001

## Slice

As a designer I can give my project's root canvas its dimensions — add, rename, recolor, reorder — with the n ≥ 2 floor enforced.

## Scope

- Schema/store: `dimensions` (project-scoped, `context_id` null for root), sort order, color.
- Palette: colors auto-assigned from the style-guide categorical palette in sort order; user-overridable.
- UI: canvas-header dimension manager (list with in-place rename, drag reorder via dnd-kit, color swatch picker, add/remove).
- Out of scope: demotion effects on existing contexts (slice 007), child canvases (slice 011).

## Design brief

- **Surface**: dimension manager lives in a popover from its context-bar trigger (SITEMAP §2; 0 radius, the app's single shadow token) — a compact list, not a settings page.
- **Row anatomy**: color swatch (square, 16px) · name (in-place edit) · drag handle on hover · remove. Swatch opens the 8-slot palette picker; current slot marked, custom hex allowed.
- **Guided start**: a canvas with < 2 dimensions replaces the register/canvas area with a quiet prompt: "Add at least two dimensions to begin designing" + the manager already open.
- **Error prevention**: remove is disabled on the last two dimensions with tooltip "A canvas needs at least 2 dimensions" — *and* the store rejects it (belt and braces; the test asserts both).
- **Reorder**: drag via handle; keyboard alternative Alt+↑/↓. One undo step per drop.
- **Feedback**: palette color applies live to the swatch and (once the canvas exists) the arc — no save button, mutations commit instantly.
- **Focus**: popover traps focus while open, returns to the trigger on close (Esc).
- **Microcopy**: names default "Dimension 3" ready-to-edit; never "Untitled".

**References**: SPEC §1 (dimensionality), §3 (dimensions) · SITEMAP §2 (context-bar trigger) · STYLE_GUIDE §2.3 (palette), §4 (popover shadow) · ADR-0002

## Test-first plan

1. Unit: adding dimensions assigns palette colors in sort order; reorder rewrites `sort` stably; removing below n = 2 is rejected with a typed error.
2. Unit: rename propagates to selectors; color override survives reorder.
3. Component: dimension row in-place rename; add button creates "Dimension N" ready-to-edit.
4. e2e: create project → add 3 dimensions → reorder → reload → order and colors persist.

## Acceptance criteria

- [ ] n ≥ 2 invariant enforced in the mutation layer (not just disabled UI).
- [ ] Dimension count is pure row data — nothing anywhere encodes "3" (ADR-0002).
- [ ] Reorder is undo-ready (command emitted; full undo lands in slice 006).
