# 006: Undo/redo across all mutations

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 004

## Slice

As a designer I can undo and redo anything — cell edits, reorders, deletes — with ⌘Z/⇧⌘Z, and the store never desyncs from the database.

## Scope

- Command-log middleware on the Zustand store: every mutation records an inverse; undo/redo replay through the same mutation layer (so persistence stays consistent).
- Batching: one user gesture = one undo step (e.g. a drag-reorder is one command, not one per row shifted).
- Depth: bounded log (e.g. 200 steps), cleared on project switch.

## Design brief

- **Controls**: ⌘Z/⇧⌘Z (Ctrl on Windows) plus two toolbar icons (Lucide undo-2/redo-2, 16px) — disabled state at stack ends, tooltip shows the step name ("Undo: bind Users → α").
- **Feedback**: the persistent status bar (SITEMAP §2) narrates the last action for 3s: "Undid: bind Users → α" (12px muted mono). No toasts, nothing stacks, nothing to dismiss.
- **A11y**: the status line is an `aria-live="polite"` region — screen readers hear what undo did, since the visual change may be anywhere on screen.
- **Spatial continuity**: undoing a change on an entity that's off-screen scrolls/selects it (selection is the app's pointing device — reuse it to show *what* changed).
- **State persistence**: the log is session-scoped and clears on project switch; this is stated in the tooltip on first disabled hover ("Undo history starts fresh each session").

**References**: SPEC §4.7 (undo/redo) · SITEMAP §2 (status bar = narration home), §4 (⌘Z/⇧⌘Z globals) · STYLE_GUIDE §5 (icons), §9, §10 (live region) · TECH_STACK §5 (command log)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Property test: apply a random sequence of N mutations (create/rename/bind/reorder/delete across all entities), undo N times → state deep-equals initial; redo N times → state deep-equals final. Run across seeds.
2. Unit: batch boundaries — drag-reorder emits one command; phantom-row create+first-edit is one step.
3. Unit: undo of a soft delete restores visibility and sort position.
4. e2e: edit a cell → ⌘Z reverts it → reload → the reverted state is what persisted.

## Acceptance criteria

- [ ] The property test is part of `npm run verify` (not a separate manual suite).
- [ ] Undo/redo works identically when triggered from register and (later) canvas — command layer is UI-agnostic.
- [ ] Persistence after undo proven by the e2e reload test.
