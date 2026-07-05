# 006: Undo/redo across all mutations

- **Status**: SHIPPED
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

- [x] The property test is part of `npm run verify` (not a separate manual suite).
- [x] Undo/redo works identically when triggered from register and (later) canvas — command layer is UI-agnostic.
- [x] Persistence after undo proven by the e2e reload test.

## Implementation notes

- `store/commandLog.ts` (new): `useCommandLogStore` — `past`/`future` stacks of `{ label, undo, redo }`, bounded to 200, `batch(label, fn)` collects every `push()` call made while `fn` runs into one combined command (used by the phantom-row create+justify gesture). Session-scoped only (never persisted); `AppShell` clears it whenever the open project changes.
- Every store (`projects`, `dimensions`, `parameters`, `contexts`) pushes one command per mutating action, capturing whatever "before" state its own inverse needs (previous name/color/symbol/parameterId, or — for reorder/remove — the full previous id ordering) and replaying through the *same* mutation-layer functions the forward action uses, so undo/redo can never desync from what's persisted.
- New DB primitives (`db/mutations.ts`), all mirroring the soft-delete columns every table already had: `restoreDimension`/`restoreParameter` (un-delete **and** rewrite sort to a caller-supplied id order — required so undoing a *middle* removal restores the exact original position, not just re-appends at the tail) and `archiveContext`/`restoreContext` (contexts had no delete path at all before this — added solely as create()'s undo inverse; no sort-rewrite needed since create always appends at the tail).
- **Found via testing, not written into the plan up front**: `removeDimension`'s n≥2 floor check is a *user-facing* guard and must not apply to undo-of-add (undoing the very first add() can legitimately return to a below-floor guided-start state) — fixed by splitting out an internal `removeDimensionUnchecked` (exported as `undoAddDimension`) that the store's `add()` undo calls instead of the validated path. Caught by a dedicated store test before it ever reached the property test.
- The property test (`store/undoRedo.property.test.ts`, fast-check, 40 runs × 8–24 random ops each) seeds one parameter per dimension and one bound context *before* taking its "initial" snapshot — otherwise every modify-op's undo bug hides behind the (correct) undo-of-create archiving the whole row. Verified by deliberately injecting a bug into `setSymbol`'s undo and a `justification: null` vs `''` DB round-trip inconsistency; both were caught and both are fixed (the latter by normalizing the snapshot, since the app already treats null/'' as equivalent everywhere else).
- `EditableGrid` gets a `data-row-id` attribute on every `<tr>` (issue 005 added this pattern for the duplicate badge; issue 006 doesn't add anything new here, just relies on it).
- **AppShell**: ⌘Z/⇧⌘Z registered on the **capture phase**, not bubble — `EditableGrid`'s phantom-row input calls `stopPropagation()` on every keydown (to keep its own Enter/Escape/arrow grammar from leaking), which silently swallowed a bubble-phase global listener whenever focus was inside a phantom row. Since committing a cell edit moves focus to the next row (often the phantom one), this hit the *exact* scenario the test-first plan's e2e case exercises — caught by that e2e test, not by unit tests, and it turns out the pre-existing ⌘1/2/3 tier-switch shortcut had the same latent bug. Also: defers to the browser's native text-undo only when the focused field has *content* (`el.value.length > 0`) — an unconditional "defer while any input is focused" rule would swallow ⌘Z any time focus lands on an *empty* phantom input, which is the common case right after a commit.
- Status-bar narration (`Undid: …` / `Redid: …`) auto-clears after 3s, distinct from the persistent inline-Undo pattern (archive) that waits for the user to act. The pre-existing single-step `lastAction`/`undoLast` on the projects store was removed; `ProjectsList`'s archive flow now routes its inline "Undo" button through the shared command log instead.
- Deferred: canvas-triggered undo/redo (no canvas yet, issues 008–010) and the "spatial continuity" design-brief bullet (scrolling/selecting the changed entity) — there's no selection concept to reuse yet.
- **Found but out of scope for this issue**: verification turned up a pre-existing CSS layout bug from issue 005 — the sticky `.grid-col--symbol` column overlaps the following header by ~20px once the table is wide enough (e.g. a long justification value present). Not touched here; flagged for a follow-up.
