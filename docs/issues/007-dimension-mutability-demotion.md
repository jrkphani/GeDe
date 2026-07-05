# 007: Dimension add/remove with draft demotion

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 005, 006

## Slice

As a designer I can change my mind about a canvas's dimensions after contexts exist — adding a dimension demotes complete contexts to drafts until re-bound; removing one deletes its bindings, undoably, with an impact warning first (SPEC invariant 4).

## Scope

- Store: add-dimension marks affected contexts draft (their binding sets are now incomplete); remove-dimension cascades soft-deletes to its bindings; both emit one undoable command.
- UI: confirmation with impact counts ("Removing Process deletes 7 bindings; 5 contexts become drafts"); register column appears/disappears; documented/coverage selectors recompute.

## Test-first plan

1. Unit: add dimension → every previously complete context's completeness flips to draft; documented count drops accordingly.
2. Unit: remove dimension → its bindings soft-deleted; contexts' tuple_hashes recomputed; undo restores bindings, completeness, and hashes exactly.
3. Unit: impact preview function returns exact counts without mutating.
4. Component: confirm dialog shows the preview numbers; cancel is a true no-op.
5. e2e: 3-dim canvas with a complete α → add 4th dimension → α shows draft → bind the 4th → complete again (mirrors SPEC §6 M2 done-when, table-side).

## Acceptance criteria

- [ ] Both operations are single undo steps that fully round-trip (property-test extension of slice 006).
- [ ] No orphan bindings possible — asserted by a DB-level integrity test.
- [ ] Impact copy follows STYLE_GUIDE §7.
