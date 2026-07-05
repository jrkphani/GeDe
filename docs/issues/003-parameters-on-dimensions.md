# 003: Parameters on a dimension

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 002

## Slice

As a designer I can populate each dimension with its ordered parameters, edited Numbers-style: type in the phantom row to add, click to rename, drag to reorder.

## Scope

- Schema/store: `parameters` (dimension-scoped, `parent_param_id` nullable — schema ships now, sub-parameter UI arrives in slice 011), sort order.
- UI: per-dimension parameter list (inside the dimension manager), phantom row at bottom, in-place rename, drag reorder.

## Design brief

- **Surface**: parameter lists nest inside each dimension's section of the manager popover — dimension name as an 11px uppercase head, parameters as 32px compact rows (popovers may be denser than document tables).
- **Empty state (per dimension)**: single phantom row, ghost text "Type to add a parameter".
- **Phantom-row grammar** (canonical here, reused everywhere): typing materializes the row; Enter commits and focuses a fresh phantom; Esc on an empty phantom is a no-op; Esc mid-edit reverts.
- **Ordering matters visually**: the list order *is* the arc order — a muted position index (mono, `1 2 3…`) precedes each name so the mapping to the canvas is legible before the canvas exists.
- **Error state**: deleting a parameter with bindings is rejected inline — the row shakes 0ms (no animation), shows "Bound by 3 contexts" in danger color for 2s. Nothing modal.
- **Feedback**: reorder reflects immediately; one undo step per drop.
- **Focus**: each dimension section is a roving-tabindex list; ⌘/Ctrl+Enter jumps to the next dimension's phantom row for fast bulk entry.

**References**: SPEC §2 (Parameter), §3 (parameters) · STYLE_GUIDE §6 (phantom row), §9 · issue 002 (manager surface)

## Test-first plan

1. Unit: parameter created with correct dimension scope and next sort value; reorder stable; delete soft-deletes and closes the sort gap.
2. Unit: `parent_param_id` accepted by schema (insert a sub-parameter directly) even though no UI exists yet.
3. Component: phantom row — typing creates the row; Enter commits + fresh phantom focused; Esc on empty phantom is a no-op.
4. e2e: build the example's Stake dimension (Buyers, Maintainer, Users) → reload → intact and ordered.

## Acceptance criteria

- [ ] m is unbounded and independent per dimension.
- [ ] Phantom-row grammar matches STYLE_GUIDE §4 exactly.
- [ ] Deleting a parameter that has bindings is blocked with a typed error naming the count (full resolution UX in later slices).
