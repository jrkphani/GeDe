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

## Test-first plan

1. Unit: adding dimensions assigns palette colors in sort order; reorder rewrites `sort` stably; removing below n = 2 is rejected with a typed error.
2. Unit: rename propagates to selectors; color override survives reorder.
3. Component: dimension row in-place rename; add button creates "Dimension N" ready-to-edit.
4. e2e: create project → add 3 dimensions → reorder → reload → order and colors persist.

## Acceptance criteria

- [ ] n ≥ 2 invariant enforced in the mutation layer (not just disabled UI).
- [ ] Dimension count is pure row data — nothing anywhere encodes "3" (ADR-0002).
- [ ] Reorder is undo-ready (command emitted; full undo lands in slice 006).
