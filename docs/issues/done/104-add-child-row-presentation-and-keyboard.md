# 104: Add-child child rows — oversized edit height, odd spacing, keyboard nav

- **Status**: ✅ **RESOLVED (2026-07-22)** — core shipped 2026-07-21 (all 3 facets; tsc/eslint/stylelint clean; vitest 1665; full e2e; adversarially reviewed); LOW remainder (2)+(3) shipped `85a5e47`; the last open fork item (1) empty-space-dismiss was **DECIDED by owner: leave as-is**. Nothing remains. Surfaced immediately after 102 shipped (the child row appears; its presentation was the problem).
  - **SHIPPED:** (Facet 1) description cells get a **compact** rich-text editor (`RichTextCellKind.roomy` default off; only the register justification opts into `roomy:true`) — a short description no longer balloons the row from ~40px to ~88px on click. (Facet 3a) **continuous, non-blocking** add-child: a `beginEditing` seam in `EditableGrid` makes a NEW edit (click/Tab another cell) cleanly DISMISS the armed phantom (`InlineRowConfig.onDismiss`) instead of being blocked — while 102's arm-while-editing suppression stays intact ("whichever the user did last wins"). (Facet 3b) **grid-aware Tab** from the add-child field (`PhantomInput.onTab`): forward Tab commits the child then lands focus on the next grid cell (section-scoped `gridBoundaryFocus` helpers), Shift+Tab on the first cell; Enter still creates + continues. (Facet 2) resolved by Facet 1 — no extra pass.
  - **Remainder (LOW, from adversarial review):**
    - **(1) — DECIDED: LEAVE AS-IS (owner, 2026-07-22).** Clicking empty space leaves the add-child phantom armed (dismiss via Esc or a cell click). The owner confirmed the current tested behavior is intended — do NOT add an outside-pointerdown dismiss. Test edge (d) locks this in. **This was 104's last open item → 104 is now fully resolved.** (Follow-up: issue **105** evolves the add-child KEYBOARD grammar — P0 drops "Add child" from the tab order, P1 adds Enter=sibling — while PRESERVING 104's behavior, not reverting it.)
    - **(2) — SHIPPED (2026-07-21).** Four edge tests in `e2e/architecture.spec.ts` (`104 (edge a–d)`): (a) Escape dismisses with `dismissOnBlur=false`; (b) a plain-text (Name) cell click while armed dismisses+edits; (c) Shift+Tab lands the first editable cell (polled — the focus handoff is a rAF); (d) clicking a non-cell region (table title) leaves the phantom armed. Full e2e 94/94.
    - **(3) — SHIPPED (2026-07-21).** The rAF-after-unmount focus handoff invariant is now documented inline at `ArchitectureSurface` `onTab` (React-18 discrete-event sync flush guarantees the add-child row is unmounted before the next frame; do not collapse the rAF to a sync call).
- **Milestone**: M7. **Depends on / follows**: 102 (add-child now works), 084 (typed add-child), 089 D1 P5 (rich-text description cells).

## Facet 1 — the child row is much taller than the parent (edit-mode editor height)
When a description cell is being edited, the Lexical editor has a fixed **72px min-height** (`base.css` `.grid-cell--richtext .rich-text-editor-root { min-height: 72px }`, mirrored by `.grid-cell__input--multiline`). That floor was designed for the Design register's multi-sentence **justification** prose (issue 085 Phase B, Decision 4 — "roomy editor"). In an Architecture table, descriptions are short, so a cell in edit mode balloons the row to ~72px+ while every read-mode row is ~40px — jarring, and the reported "row height is especially very big." It collapses back on blur.
- **Fix direction (no owner-fork needed):** right-size the description editor for the *table* context — e.g. an auto-growing editor that starts at the row's rest height (~40px) and grows with content, rather than a fixed 72px floor; or scope the 72px floor to the register/justification cell and give the Architecture/Foundation description cell a smaller floor. Must not regress the register justification editor (085 Decision 4).

## Facet 2 — spacing looks odd
Largely a symptom of Facet 1 (a tall edit-mode row next to short read-mode rows) plus the child indentation (`--depth`). Re-evaluate once Facet 1 is fixed; may need a small vertical-rhythm pass on child rows.

## Facet 3 — keyboard tab-rotate "does not work as expected" (two causes)
1. **The add-child phantom isn't wired into the grid's Tab navigation.** It's a bare `PhantomInput` (`ArchitectureSurface.renderAddChildCell`) with no `chain`/`chainId`, so Tab from it falls through to browser-default focus movement instead of rotating to the next grid cell like the normal editing grammar.
2. **102's `armed` suppression blocks editing while the add-child phantom is up.** The add-child phantom **stays armed** after creating a child (to let you type the next sibling), and 102's fix suppresses cell-editing whenever the inline row is armed (`effectiveEditing = armed ? null : editing`). So until the user presses Esc to leave add-child mode, the table's normal keyboard editing feels dead. This is a direct, acknowledged consequence of the 102 fix — the two-way exclusion of "editing a cell" vs "add-child armed" now always lets *armed* win.

## The interaction-design FORK (blocks Facet 3's fix)
After adding a child via the add-child phantom, should it be:
- **(A) Single-shot** — create one child, dismiss the phantom, land focus sensibly (new child's name, or the next cell). Predictable; add another child by clicking "Add child" again.
- **(B) Continuous** (current) — stay in "add sibling" mode, Enter adds another child and keeps going, Esc exits. Faster bulk entry, but modal — and today it blocks editing other cells and its Tab isn't grid-aware.
- **(C) Continuous but non-blocking** — stay in add mode, but clicking/Tabbing to another cell cleanly exits add mode and edits that cell (no suppression), and Tab is grid-aware.

The fix for Facet 3 differs materially by choice. (C) is the most consistent with the grid grammar but the most work; (A) is the simplest and most predictable.

**DECISION (owner, 2026-07-21): (C) Continuous, non-blocking.** After each child, stay in add-sibling mode (Enter keeps adding); BUT clicking or Tabbing to any other cell cleanly EXITS add mode and edits that cell (no dead editing), and Tab from the add-child field rotates within the grid grammar (not browser default). The 102 `armed` suppression must therefore become "starting a new edit dismisses the add-child phantom," not "block all editing while armed" — while KEEPING 102's protection (arming add-child while a cell is mid-edit must still suppress that prior editor synchronously so the phantom isn't focus-killed). Whichever the user did LAST wins.

## Gate (once decided)
- Child row edit height is comfortable in a table (not a 72px jump); register justification editor unchanged.
- Keyboard: Tab from the add-child affordance rotates within the grid grammar (per the chosen model); editing other cells is not dead while/around add-child; no lost edits.
- e2e covering the chosen add-child interaction + the row-height behavior; existing 102 tests stay green.
