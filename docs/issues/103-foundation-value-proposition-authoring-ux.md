# 103: Foundation value-proposition authoring UX — discoverability + keyboard-first append

- **Status**: 🟡 CORE SHIPPED (2026-07-21) — the discoverability bundle landed; the append-symmetry item is a deferred owner-fork (see below). Written from an adversarial UX debate (proponent vs. skeptic, both grounded in the code).
  - **SHIPPED:** visible **"Purpose"** label (matching Existing Scenario); a **"Value propositions"** `<h3>` heading; an orienting **empty-state** line (mirrors Architecture's); **`showKeyHints`** on the Foundation grid (the quiet ⏎ phantom hint). Verified: tsc/eslint/stylelint clean; FoundationSurface unit 21 (+5); foundation + architecture e2e green; a11y checked (valid h2→h3 order, no new landmark, hints aria-hidden). Screenshot confirms the three cards now read as two titled prose fields + one titled table.
  - **DEFERRED (owner-fork):** "Enter at the end of a row appends a new row." Deliberately NOT done. The value props are already one grid, and the phantom row already provides keyboard append (type → **Enter** creates, **Tab** creates-and-continues). Making Foundation's phantom **Enter** uniquely "continue into the new row" would diverge it from Architecture/ContextRegister, whose shared `PhantomCell` grammar is Enter=create-and-stay (Architecture e2e asserts this) — the *opposite* of the consistency this issue wants. "Enter at end of the last DATA row appends" is a broad shared-grammar change with its own forks. Both left for an explicit owner decision.
- **Milestone**: M7. **Depends on / touches**: 013 (Foundation), 081 (Existing Scenario), 084 (Architecture table grammar precedent), 089 D1 P5 (rich-text description cells).

## The report

> "The control to add a new Value proposition is not intuitive. The value propositions need to all club together in a single table and be editable on a tab-rotate basis from keyboard shortcuts. Adding a new value proposition should be just a new row in the table when Enter or Tab is pressed at the end of the current row. Having separate value proposition tables like this is not great."

## What the code actually does (both debaters agree on this)

The Foundation lane (`src/components/FoundationSurface.tsx`) stacks **three** things:

1. **Purpose** — a standalone Lexical `RichTextEditor` (`:174-183`). **No visible label** — only an `ariaLabel="System purpose"` and the ghost "What is this system for?".
2. **Existing Scenario** — another standalone Lexical editor (`:190-199`), and it **does** have a visible label (`:191`).
3. **Value propositions** — already a **single `EditableGrid`** (`:201-220`), columns rank / name / description[richtext], with a phantom "Name a value proposition" row and drag-to-rerank. **No section heading.**

So the value props are **already one table**, and keyboard add **already exists** (the phantom row: Enter creates, Tab creates-and-continues into the new row — `EditableGrid` `PhantomCell`). The "separate tables" the user perceives are the two unlabeled/under-framed **prose editors** above the grid, plus the grid's own heading-less, near-empty state (when there are 0 props, only the bare "+Name a value proposition" link shows under two prose cards).

**The complaint is real, but largely a labeling / empty-state / discoverability problem, not a "the VPs are fragmented" architecture problem.**

## The debate

### Proponent (ship the keyboard-first polish)
- The user is really asking GeDe to be **consistent with itself**: Architecture (tier 2) already got the full 084 treatment — an orienting empty-state line (`ArchitectureSurface.tsx:90-94`), quiet keyboard hints (`showKeyHints`), and create-and-continue keyboard flow. **Foundation passes no `showKeyHints`** (`FoundationSurface.tsx:207-216`), so its VP table teaches the user nothing about Enter/Tab.
- Two concrete gaps make "add is unintuitive" literally true: (a) **Enter in the phantom only self-refocuses** the phantom instead of flowing into the created row (Tab does flow — an inconsistency); (b) **Enter at the end of the last real row does nothing** (`nextEditableCell(...,'down')` is null on the last row) — exactly the user's "Enter at end of row should add a row."
- All of the good stuff is cheaply preservable (rank/degree, drag-rerank, rich descriptions, viewer read-only) — the append change targets the **Name (text) cell + phantom**, zero store/schema change.

### Skeptic (fix the labels, leave the grammar alone)
- The premise "unify into ONE table" is a **misread** — there already is one. The only way to "unify further" is to dissolve the Purpose/Existing-Scenario prose into rows, which **destroys the deliberately document-like Tier 1** (013 §19, 081) and the ranked/degree model.
- **"Enter/Tab at end of row appends" collides head-on with the rich-text description cell.** That column is Lexical (`:149`): **Enter = paragraph**, **Tab = list-indent / not a traversal key while focused**, and commit is **Cmd/Ctrl+Enter** — a seam 089 D1 P3 *deliberately* engineered to reconcile the Numbers grammar with rich text. Rebinding Enter/Tab to "append a row" *inside* a description either breaks multi-paragraph/​formatted descriptions or reverts that seam. So "pure tab-rotate through every cell" is **not deliverable** as stated while description stays rich-text.
- Cheapest fix that resolves the actual confusion: **label Purpose**, **add a "Value propositions" heading** above the grid, and **turn on `showKeyHints`**. Single-digit lines.

### Where they converge (the synthesizable answer)
- Do the **cheap discoverability fixes** regardless — they address the stated pain ("scattered / unintuitive"): visible **Purpose label**, a **VP section heading**, an **orienting empty-state line**, and **`showKeyHints` on the Foundation grid** so the existing Enter/Tab grammar becomes self-teaching.
- **Close the append-symmetry gaps** in the **Name/text cell + phantom only** (NOT inside the rich-text description): Enter-in-phantom should continue into the new row like Tab; Enter at the end of the last row's Name cell should append. Reuse the existing `createFromPhantom` → materialize-and-open path.
- **Do NOT** dissolve the prose editors into rows, flatten Tier 1 into Tier 2, or rebind Enter/Tab inside the rich-text description cell.

## Recommended scope (if built)

1. **Label + frame (cheap, high-payoff):** visible "Purpose" label to match Existing Scenario; a "Value propositions" heading above the grid; an orienting empty-state line mirroring Architecture's. Optionally group the two prose panels visually distinct from the table so three cards stop reading as peer "tables."
2. **`showKeyHints` on the Foundation VP grid** (one-word change; reuses 084's a11y-audited primitive).
3. **Append symmetry (Name cell + phantom):** Enter-in-phantom continues into the new row; Enter-at-end-of-last-row appends. No change to the rich-text description's Enter/Tab/Cmd+Enter grammar.
4. **Preserve:** rank/degree ordering + drag-to-rerank, rich-text descriptions, viewer read-only. Zero store/schema change.

## Open questions the owner should resolve before building

1. **Is the real fix just labels + heading + `showKeyHints`?** If the user is shown a labeled version, does the "separate tables" complaint survive? If not, everything past step 1/2 may be unnecessary.
2. **Inside a description, what should Enter/Tab do?** The recommendation keeps them as paragraph/indent with Cmd+Enter to commit (unchanged). Confirm the user does not actually want to type-append from inside a description (which would force description back to single-line plain text — a regression of 089 D1 P5).
3. **Rank in the Tab order?** The rank/degree cell is never-typed (derived from position). Keyboard-first "rotate through every cell" has no place for it; drag-to-rerank stays the reorder gesture. Confirm that's acceptable.
4. **Does the user want the two prose editors (Purpose, Existing Scenario) restructured at all**, or just clearly labeled? They are deliberately prose, not rows.

## Gate (once scoped)
- Keyboard-only: type a VP name → Enter → land in the new row; repeat unbroken. Enter at end of last row appends. Tab parity retained.
- Empty Foundation reads as a titled table (heading + first-row phantom), not a bare link; Purpose is labeled.
- `showKeyHints` hints present + `aria-hidden` (no new SR noise). Drag-rerank, rich descriptions, degree notation, viewer read-only all unchanged (existing tests green).
