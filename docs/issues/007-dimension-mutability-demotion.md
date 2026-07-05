# 007: Dimension add/remove with draft demotion

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 005, 006

## Slice

As a designer I can change my mind about a canvas's dimensions after contexts exist — adding a dimension demotes complete contexts to drafts until re-bound; removing one deletes its bindings, undoably, with an impact warning first (SPEC invariant 4).

## Scope

- Store: add-dimension marks affected contexts draft (their binding sets are now incomplete); remove-dimension cascades soft-deletes to its bindings; both emit one undoable command.
- UI: confirmation with impact counts ("Removing Process deletes 7 bindings; 5 contexts become drafts"); register column appears/disappears; documented/coverage selectors recompute.

## Design brief

- **The one confirm in the app**: dimension *remove* is destructive at a distance, so it gets an anchored confirm popover (not a modal): impact counts in mono ("Deletes **7** bindings · **5** contexts become drafts"), danger-colored confirm, Esc/click-away cancels. Add never confirms — it destroys nothing.
- **After add**: no dialog; the register shows the new (empty) column immediately and the status line reports "5 contexts need a *Priority* binding". Demoted rows show their standard draft signifiers (dashed chip, hollow cells) — no new visual vocabulary.
- **Wayfinding to repair**: the new column's empty cells are the affordance; clicking the status line selects the first draft. A count chip on the canvas header ("5 drafts") persists until re-binding is done.
- **Undo prominence**: both operations narrate in the status line with "Undo" inline — a full round-trip is one keystroke, which is why a heavier confirmation is unnecessary.
- **Error prevention**: the impact preview is computed by the same pure function the test suite uses — the numbers in the popover are the tested numbers, not a parallel estimate.
- **Microcopy**: verbs first, numbers mono: "Remove *Process*? Deletes 7 bindings." Never "Are you sure?".

**References**: SPEC invariant 4 · SITEMAP §2 (status-bar narration, context-bar draft count) · STYLE_GUIDE §2.2 (danger/warning), §4 (popover), §9 · issues 004 (draft signifiers), 006 (undo)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

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
