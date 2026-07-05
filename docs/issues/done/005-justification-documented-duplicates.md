# 005: Justification, documented status, duplicate-tuple warning

- **Status**: SHIPPED
- **Milestone**: M1
- **Blocked by**: 004

## Slice

As a designer I record *why* a combination matters, and the app tells me when a tuple is already taken — without ever blocking me (SPEC invariant 2: capacity, not completeness).

## Scope

- Justification cell in the register (in-place, multiline-capable).
- Documented status: complete bindings **and** non-empty justification.
- Duplicate detection via `tuple_hash`: creating/editing a context onto an existing tuple shows a non-blocking inline badge listing the existing context symbol(s) (STYLE_GUIDE §4 — muted badge, never a popup).

## Design brief

- **Justification cell**: in-place multiline — the row grows to fit while editing (the one sanctioned row-height exception); display mode truncates to 2 lines with full text on focus/hover title.
- **Documented signifier**: a filled square dot (ink) in a slim status column; draft = hollow, complete-but-unjustified = half-filled. Shape + fill carry the state, never color alone (A11y baseline).
- **Duplicate badge**: muted mono badge `= β` at the row end — quiet, non-blocking (SPEC invariant 2). Focus/hover reveals a tooltip "Same tuple as β"; Enter/click on the badge selects β (navigation, not dismissal — the badge never has an ✕).
- **Error prevention as information**: while a combobox pick would complete a duplicate tuple, the badge previews *live* in the open popover row, so the designer knows before committing — and may commit anyway.
- **Microcopy**: "Same tuple as β" / "Same tuple as β, θ" — no warnings-speak ("duplicate!", "conflict") because duplicates are legal.
- **Feedback**: documented dot fills the instant justification commits; the coverage stat (once 012 exists) increments in the same frame.

**References**: SPEC §2 (Statement), §4.4, invariant 2 · STYLE_GUIDE §9, §10 · issue 004 (grid cells)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: documented selector — complete + justified = documented; complete + empty justification = not documented.
2. Unit: duplicate detection returns existing context ids for a tuple; save is **not** rejected.
3. Component: badge renders on the duplicate row, names the sibling symbol, disappears when either context re-binds away.
4. e2e: two contexts on the same tuple both save; both appear in the register with warning badges.

## Acceptance criteria

- [x] No code path blocks a save due to tuple duplication.
- [x] Documented status never gates saving, exporting, or navigation (SPEC invariant 2 wording).
- [x] Warning copy follows STYLE_GUIDE §7 voice (quiet, specific).

## Implementation notes

- `domain/completeness.ts`: `documentedStatus(complete, justification)` — tri-state (`draft` / `complete` / `documented`), rendered as a hollow / half-filled / filled square dot (`.status-dot`) in a new "Documented" column right after Symbol.
- `domain/duplicates.ts` (new): `tupleKeyFor`/`findDuplicateContextIds` — purely over already-loaded `bindingsByContext` (no extra DB read; mirrors the `tuple_hash` computed in `db/mutations.ts`). Two contexts are duplicates once they share the same ordered tuple of *currently bound* dimensions — never blocks, purely informational.
- `EditableGrid`: new `multiline` cell kind (auto-growing `<textarea>` while editing, 2-line CSS clamp + `title` full-text on display) — the one sanctioned row-height exception. Also added `data-row-id` on every `<tr>` as a generic external-navigation hook.
- `ContextRegister`: Justification switched to the `multiline` kind; new trailing "Duplicate" column renders a muted mono `Button` badge (`= β`) naming sibling symbol(s), title = "Same tuple as …"; click/Enter focuses the sibling's row via `data-row-id` (canvas-based selection is issues 008–010; this is the pre-canvas stand-in).
- Deferred (not in acceptance criteria / test-first plan): the composer's *live* duplicate preview while hovering an unselected combobox option — scoped out to avoid speculative UI; can be added when the composer (issue 010) exists.
