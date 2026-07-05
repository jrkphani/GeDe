# 003: Parameters on a dimension

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 002

## Slice

As a designer I can populate each dimension with its ordered parameters, edited Numbers-style: type in the phantom row to add, click to rename, drag to reorder.

## Scope

- Schema/store: `parameters` (dimension-scoped, `parent_param_id` nullable — schema ships now, sub-parameter UI arrives in slice 011), sort order.
- UI: per-dimension parameter list (inside the dimension manager), phantom row at bottom, in-place rename, drag reorder.

## Test-first plan

1. Unit: parameter created with correct dimension scope and next sort value; reorder stable; delete soft-deletes and closes the sort gap.
2. Unit: `parent_param_id` accepted by schema (insert a sub-parameter directly) even though no UI exists yet.
3. Component: phantom row — typing creates the row; Enter commits + fresh phantom focused; Esc on empty phantom is a no-op.
4. e2e: build the example's Stake dimension (Buyers, Maintainer, Users) → reload → intact and ordered.

## Acceptance criteria

- [ ] m is unbounded and independent per dimension.
- [ ] Phantom-row grammar matches STYLE_GUIDE §4 exactly.
- [ ] Deleting a parameter that has bindings is blocked with a typed error naming the count (full resolution UX in later slices).
