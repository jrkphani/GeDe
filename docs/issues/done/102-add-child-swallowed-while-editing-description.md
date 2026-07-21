# 102: "Add child" does nothing while a rich-text description cell is being edited

- **Status**: ✅ SHIPPED (2026-07-21). Clicking "Add child" while a description cell was mid-edit produced no child row. Fixed in the shared `EditableGrid`; adversarially reviewed; RED→GREEN e2e on both surfaces. verify:fast 1660; full e2e 86/86.
- **Milestone**: M7 (089 canvas). **Depends on**: 084 (the typed add-child) + 089 D1 P5 (the description became a Lexical rich-text cell).

## Fix (shipped)

**Actual mechanism (differs from the initial hypothesis below):** the phantom DID mount — it was dismissed **appear-then-vanish** in the same frame. `RichTextCell` deliberately keeps `nav.editing` on blur (so the out-of-editor FormatStrip doesn't collapse the cell), so its Lexical editor stays mounted and re-grabs DOM focus the instant the add-child phantom's `autoFocus` input mounts; the phantom then blurs and its `onBlur → onCancel` (`inline-editor.tsx`) dismisses it before paint. My first two guesses failed because they acted too late (an after-paint effect) or targeted the wrong thing (the click was never the problem).

**Fix (`EditableGrid.tsx`):** when the inline add-child row is armed, suppress `editing` **synchronously during that render** via a derived `effectiveEditing = armed ? null : editing` (fed into `nav.editing` and the `onEditingChange` presence seam). The still-mounted editor therefore unmounts in the *same commit* as the phantom mounting, so it can never refocus. An effect then clears the underlying `editing` state (so dismissing the phantom never re-opens the editor) **and** clears the queued-focus refs (`pendingFocus`/`pendingPhantomEdit`) — an adversarial-review follow-up: a text/mono cell whose value CHANGED commits async on blur and queues a focus target that would steal focus from the phantom the same way (a ~50-60% timing race; the ref-clear closes it defensively). No data loss: the pointerdown that activates "Add child" already commits the edited value on the editor's blur before arming.

**Not changed:** `RichTextCell`'s blur behavior (FormatStrip depends on it) — verified intact. Inert for every non-add-child surface (`armed` is only ever true for ArchitectureSurface's inline add-child; `effectiveEditing === editing` everywhere else).

**Tests:** `architecture.spec.ts` "architecture 102" (description mid-edit) + "architecture 102b" (changed-name mid-edit); `d3-canvas.spec.ts` "architecture 102 (canvas)" variant. Note 102b passes with or without the ref-clear (the text-cell race is timing-dependent), so it guards the behavior rather than proving a hard RED.

---

*Original investigation (kept for the record):*

## Reproduction (confirmed)

1. Architecture lane → add a table (e.g. "Value") → add an entry ("Comfort").
2. Click the entry's **Description** cell and type (e.g. "Seating comfort"). This opens the Lexical rich-text editor; it stays focused (the global FormatStrip toolbar appears).
3. Without exiting the edit, hover the row and click **"+ Add child"**.
4. **Bug:** no child phantom row appears. Screenshot evidence (canvas surface) shows the description editor still focused with "Seating comfort" typed, the "+ Add child" button visible, and **no** child row under Comfort.

- **Reproduces on BOTH surfaces** (canvas `?d3rf` arch-table node AND the WorkspaceSurface fallback), so it is the shared `ArchitectureSurface`/`EditableGrid`/`RichTextCell` path, not a canvas-only issue.
- **The clean flow works:** with no cell mid-edit, "Add child" opens the phantom correctly (verified on both surfaces).
- **The differentiator is the active rich-text edit:** pressing **Esc** to exit the description edit first, then clicking "Add child", works every time (verified — the `DIAGNOSTIC` variant passed).

## Root cause (as far as verified)

While a Lexical rich-text cell (`RichTextCell`, `EditableGrid.tsx`) is focused/editing, the "Add child" interaction does not take effect — the inline phantom (`addingChildTo` → `EditableGrid` `inlineRow`) never renders. Relevant, confirmed facts:

- `RichTextCell` **deliberately does NOT clear `nav.editing` on blur** (unlike `TextOrMonoCell` at `EditableGrid.tsx:467`). This is intentional: the FormatStrip (bold/italic) lives *outside* the editor, so clearing on blur would collapse the cell the instant the user clicks a toolbar button. **Do not naively change this** — it will regress FormatStrip.
- So when "Add child" is clicked mid-edit, the description's Lexical editor stays mounted and focused.
- The exact failure mode (click swallowed by the editor's focus retention, vs. the phantom mounting and being dismissed in the same frame by its own `onBlur → onCancel → setAddingChildTo(null)` when the editor re-grabs focus) was **not** definitively isolated. Evidence leans toward "the phantom never renders at all" (see failed fixes), i.e. `setAddingChildTo` isn't producing a surviving phantom.

## Fixes TRIED that did NOT work (do not repeat)

1. **Clear `editing` when the phantom arms** (an effect in `EditableGrid` keyed on `activeInlineRow?.afterRowId`, calling `setEditing(null)`). The phantom still never appeared → the problem is upstream of the focus-fight this targeted, or the effect runs too late (after the phantom's blur-cancel).
2. **`onMouseDown={(e) => e.preventDefault()}` on the "Add child" trigger** (keep `onClick`) to stop the pointer-down focus shift from swallowing the click. No change — phantom still never appeared.

## Candidate directions for the fix (next session)

- **Instrument first** to settle click-swallowed vs. appear-then-vanish: log/observe whether `addingChildTo` is ever set on the click, and whether the phantom mounts for even one frame. This determines which class of fix applies.
- If **appear-then-vanish** (phantom's `onBlur → onCancel` fires from an immediate programmatic blur): make the inline phantom resilient — ignore a blur within N ms of mount, or only cancel on Esc / a genuine outside pointerdown, not on the mount-time focus churn.
- If **click swallowed**: route the arm through a capture-phase pointerdown higher up, or commit+exit the active rich-text edit *synchronously before* the phantom mounts (a derived `editing` suppressed for the arming render, not an after-paint effect).
- Whatever the fix: **keep RichTextCell's blur behavior** (FormatStrip), preserve the description value (it commits on the editor's blur — verify no data loss), and add the `test.fixme` back as a passing RED→GREEN regression (both surfaces).

## Gate

- The `e2e/architecture.spec.ts` "architecture 102" test (currently `test.fixme`) flips to passing: with a description cell mid-edit, "Add child" opens a persistent, typable child phantom; typing a name + Enter creates the child; the description edit is preserved.
- No regression to: the clean add-child flow, FormatStrip on description edits, the Numbers-grammar Tab/Cmd+Enter seam.
