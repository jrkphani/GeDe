# 022: EditableGrid keyboard editing grammar (Tab across, Enter down, no focus loss)

- **Status**: OPEN
- **Milestone**: M6 (Polish — keyboard flows)
- **Blocked by**: 004 (SHIPPED)

## Slice

As a designer entering data I stay on the keyboard: **Tab** commits the current cell and opens the **next** editable cell; **Enter** commits and opens the cell **below** in the same column; and at row/column boundaries focus never gets stranded. This is the Numbers/Excel grammar the register was modeled on (ADR-0004) — today it is half-implemented and drops focus.

## Bug report (from user testing)

> "There are issues in tab switching to edit the next field in the TanStack tables, and so is the next-row shortcut to quickly edit."

Confirmed empirically by driving the running app with Playwright and reading `document.activeElement` after each keystroke:

| Gesture | Expected | Actual (observed) |
| --- | --- | --- |
| Editing a cell → **Tab** | commit, move to next editable cell **and open it for editing** | focus moves to the next cell but it is a **display element** (`<button class="grid-cell--combobox">`, `isEditor: false`) — you must click/Enter again to edit it |
| Editing a cell → **Enter** (mid-list) | commit, move **down** one row in the same column **and open it for editing** | focus moves to the next row's cell but as a **display `<div role="gridcell">`** (`isEditor: false`) — not an editor |
| Editing the **last** data row → **Enter** | commit, move into the phantom "new row" (or stay put) | **focus is lost to `<body>`** (`activeElement.tagName === "body"`, `rowId: null`) — the keyboard user is stranded |
| Editing the **last column** → **Tab** | wrap to the first editable cell of the next row (or phantom) | falls through to native tab order, leaving the grid entirely |

Root cause (in `src/components/EditableGrid.tsx`):

- **Tab is unhandled while editing.** The editing `<input>`/`<textarea>` `onKeyDown` calls `e.stopPropagation()` and handles only Enter/Escape — Tab falls to native DOM focus order, landing on whatever the next focusable node is (a display cell) without entering edit mode.
- **`moveFocusDown` focuses a display cell, not an editor.** After Enter it calls `focusCell(nav, nextRowId, columnId)` which focuses the next cell's display `<div>`/`<button>` (the ref registered in display mode), so editing does not continue down the column.
- **`moveFocusDown` can target a nonexistent ref.** `nav.rowIds` includes the phantom row, but the phantom row only renders a cell for `phantom.columnId`. From the last data row in any other column, `focusCell` finds no ref → focuses nothing → focus resets to `<body>`.

## Scope

- **Tab / Shift+Tab while editing**: commit the current cell, then move to the next / previous **editable** cell in the row and put it into edit mode (text/mono/multiline enter edit directly; combobox focuses its trigger, ready for type-ahead/Enter to open — auto-opening a popover on every Tab is disorienting). At the last/first editable column, **wrap** to the next/previous row's first/last editable cell; from the last data row this wraps into the phantom row.
- **Enter while editing** (single-line text/mono/combobox): commit, move **down** one row in the same column, and enter edit mode there — continuous column entry. From the last data row, move into the phantom input if this column is the phantom column; otherwise commit and keep focus on the just-committed cell (display mode) — **never drop to `<body>`**.
- **Shift+Enter in multiline**: unchanged (inserts a newline; Enter commits + moves down).
- **Boundary hardening**: `moveFocusDown` / any focus move must no-op safely (keep focus where it is) when the target cell has no editable ref, instead of stranding focus.
- Applies to **every** `EditableGrid` consumer (register, Foundation, Architecture, parameters, dimensions) — shared primitive, one fix.

Out of scope: accessible naming/semantics of those cells — **issue 021**. Global shortcuts (⌘K/⌘1-3/⌘Z/c/v/Esc) are untouched; this surface-local grammar **must not shadow the globals** (SITEMAP §4).

## Design brief

- **Mental model = Numbers/Excel**: Tab walks right across a record and wraps down; Enter walks down a field. Both keep you *in edit mode* so a designer can type a whole context (symbol → bindings → justification) without ever reaching for the mouse. This is the "keyboard-completable" register/composer the SPEC calls for (SPEC §4.2 "keyboard-completable: arrow between dimensions, type-ahead parameter picker"; §4.3 "inline editing").
- **Commit semantics unchanged**: advancing always commits via the existing `onCommit` (rejected commits revert to last-known-good, as today); Escape still cancels without moving. The batching/undo model (issue 006) is unaffected — one commit per advance, as now.
- **Combobox nuance**: Tab/Enter *lands on* the combobox trigger focused (announced by 021's aria-label); typing or Enter opens it (type-ahead parameter picker, SPEC §4.2). Picking a value already advances down (existing `moveFocusDown` in `onChange`) — align it to the new "advance into edit mode" behavior.
- **Never strand focus** (STYLE_GUIDE §10 focus order): every boundary has a defined, visible resting focus. A perf/timing note: advancing must survive the phantom-row's optimistic clear (HANDOFF gotcha — wait for the row's visible effect) — the e2e must assert the *editor* is focused, not just that a keystroke fired.
- **No visual change** beyond an editor appearing where a display cell was; tokens/focus ring per STYLE_GUIDE §6.

**References**: SPEC §4.2 (keyboard-completable canvas/compose), §4.3 (context register inline editing) · SITEMAP §4 (global keyboard map — surface grammars must not shadow globals) · STYLE_GUIDE §10 (full keyboard operability as acceptance criterion; focus order) · ADR-0004 (EditableGrid Numbers-style grammar) · issue 004 (grid core), issue 005 (multiline cell)

> **UI build convention (018–020):** reuse `EditableGrid`; no hand-rolled controls; tokens only (ADR-0007).

## Test-first plan

1. Component (`EditableGrid.test.tsx`): editing a text cell → **Tab** → the next column's cell is now an **editor with focus** (assert `document.activeElement` is the next cell's `<input>`/trigger, not a display `<div>`). (Fails today.)
2. Component: editing a text cell → **Enter** → the **same column, next row** is an editor with focus. (Fails today.)
3. Component: editing the **last data row** in a non-phantom column → **Enter** → focus is **not** on `<body>`; it rests on a defined target (phantom input if applicable, else the committed cell). (Fails today — lands on `body`.)
4. Component: **Shift+Tab** mirrors Tab backwards; wrapping at the first column moves to the previous row's last editable cell.
5. Component: **Tab from the last editable column** wraps to the next row's first editable cell (does not exit the grid).
6. Component: **Shift+Enter** in the multiline justification cell inserts a newline and does **not** advance; **Enter** commits + advances down.
7. Property/unit (optional): a pure `nextEditableCell(nav, rowId, colId, dir)` helper returns the correct wrap target for all boundary combinations (last row, last col, phantom-only column) — extracted so the boundary logic is unit-testable without the DOM.
8. e2e (`grid-keyboard.spec.ts`, new): in the real register, type a symbol, **Tab** through the dimension bindings and justification of one context, then **Enter** to drop into the next row — asserting an editor is focused at each step and no focus lands on `<body>`.
9. Regression: existing register/foundation/architecture/parameters/dimensions e2e specs pass unchanged (arrow-key roving in display mode still works; commit-on-blur still works).

## Acceptance criteria

- [ ] Tab / Shift+Tab while editing commits and opens the next / previous editable cell (wrapping across rows); focus is on an editor (or a combobox trigger) at each step.
- [ ] Enter while editing a single-line cell commits and opens the cell below in the same column for editing.
- [ ] No gesture ever leaves `document.activeElement` on `<body>` or exits the grid unexpectedly — verified at every row/column boundary.
- [ ] Shift+Enter still newlines in multiline; Escape still cancels without moving; global shortcuts still fire (grammar does not shadow SITEMAP §4).
- [ ] `npm run verify` green; no regression in existing grid specs.

## Implementation notes

- **Central boundary helper**: add a pure `nextEditableCell(nav, rowId, columnId, dir: 'right' | 'left' | 'down' | 'up')` that returns `{ rowId, columnId } | null`, skipping non-editable columns (`static` cells) and resolving phantom-row availability per column. Unit-test it directly; both Tab and Enter route through it. This replaces the current naive `moveFocusDown` index math that assumes every column exists in every row.
- **Advance = focus + open**: introduce `advanceTo(target)` that sets `nav.setEditing(target)` for text/mono/multiline and focuses the freshly-mounted editor; for combobox it focuses the trigger without opening. Because editors mount on `editing` state, focusing must happen after the editor renders — mirror the existing `autoFocus` path or focus in an effect keyed on `editing`.
- **Handle Tab in the editors' `onKeyDown`**: currently they `stopPropagation` and ignore Tab. Add `if (e.key === 'Tab') { e.preventDefault(); commit(draft.trim(), false); advanceTo(nextEditableCell(nav, rowId, columnId, e.shiftKey ? 'left' : 'right')) }`. Keep `stopPropagation` so global handlers don't double-fire.
- **Fix `moveFocusDown` focus-loss**: route it through `nextEditableCell(..., 'down')` and no-op when the result is `null` (do not call `focusCell` with a missing ref). This alone fixes the `<body>` strand even before the "open-for-editing" enhancement.
- **Combobox `onChange`** already calls `moveFocusDown`; switch it to `advanceTo(nextEditableCell(..., 'down'))` for consistency.
- **Phantom row**: after the phantom commits (Enter creates the row), the existing refocus-self behavior stays for rapid multi-add; Tab from within the phantom should move across the phantom's (single) editable column then behave sensibly at its boundary (no strand).
- **Coordinate with 021**: same file. If 021 converts to a full ARIA grid, the roving-tabindex contract changes — land these together or land 021's semantics decision first so the focus targets this issue creates are already correctly named/roled.
- Watch the HANDOFF gotchas: editors that stop propagation can swallow bubble-phase globals (globals are already capture-phase — fine); and don't assert on focus before the optimistic phantom clear settles (wait for the editor to mount).
