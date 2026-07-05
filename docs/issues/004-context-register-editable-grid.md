# 004: Context register with in-place editing (EditableGrid core)

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 003, 016

## Slice

As a designer I can create contexts in the register table and bind one parameter per dimension entirely in place — no forms. This slice builds the shared `EditableGrid` (TanStack Table wrapper), the highest-risk UI component in the plan (TECH_STACK T2).

## Scope

- Schema/store: `contexts` (symbol auto-assigned from the Greek cycle, manual override), `bindings` with `UNIQUE(context_id, dimension_id)` (re-binding a dimension is an upsert), `tuple_hash` computed on completion.
- Draft vs complete: a context missing any dimension's binding is a draft (SPEC invariant 1) and visibly flagged.
- UI: register with dynamic columns (Symbol · one per dimension · Justification · Children), phantom row, text cells (in-place input) and **parameter combobox cells** (type-ahead constrained to the column's dimension).
- Keyboard grammar: click/Enter edits; Enter commits + moves down; Tab/Shift-Tab traverse; Esc reverts; arrows navigate cells.
- Out of scope: justification semantics (005), canvas (008+), children column populated (011).

## Design brief

- **Surface**: the register is a paper panel on the graph paper; 40px rows, hairline separators, frozen symbol column (the only vertical rule). Column heads 11px uppercase muted.
- **Hierarchy**: symbol chips (JetBrains Mono, square, ink-on-paper inverted) anchor each row; parameter cells carry a 8px square swatch in the dimension's color before the value — color enters the table only as data.
- **Draft signifier**: incomplete contexts get a dashed-border symbol chip and their empty parameter cells show a hollow placeholder (`—`), muted. No red — a draft is a valid state, not an error (SPEC invariant 1).
- **Combobox cell**: opens on click/Enter/typing; popover (0 radius, shadow token) lists the column's dimension parameters with swatches; type-ahead filters; no free text — invalid input is impossible rather than validated (error prevention by construction).
- **Empty state**: phantom row with ghost text "Type to create your first context — it becomes α".
- **Feedback**: commits are instant (≤100ms, no animation); the symbol chip is assigned the moment the row materializes so identity is visible immediately.
- **Focus & keyboard**: full grammar per STYLE_GUIDE §6 — arrows navigate, Enter edits/commits-down, Tab traverses, Esc reverts; combobox traps focus and returns it to the cell. The e2e test runs mouse-free.
- **Content adaptability**: on narrow containers the grid scrolls horizontally *inside* the panel (frozen symbol column stays); the page never scrolls sideways.
- **Component contract**: EditableGrid exposes cell renderers (text, combobox, mono) and emits commands — zero register-specific logic inside (reuse proven in 013/014).

**References**: SPEC §3 (bindings), §4.3, invariants 1–2 · SITEMAP §2 (Design surface), §4 (grid must not shadow global keys) · STYLE_GUIDE §3, §6, §10 · TECH_STACK §3 · ADR-0004

## Test-first plan

1. Unit: symbol auto-assignment cycles α β γ… and skips taken symbols; manual override collision rejected per canvas.
2. Unit: binding upsert — second bind on same (context, dimension) replaces, never duplicates; completeness selector flips draft→complete exactly when all n dimensions bound.
3. Unit: `tuple_hash` deterministic over ordered parameter ids; recomputed on re-bind.
4. Component (the big one): EditableGrid keyboard grammar — every rule above as its own test; combobox cell filters to its dimension's parameters only.
5. e2e: recreate the example register row — new context α, bind Comfort/Users/Engagement via type-ahead, keyboard only, no pointer required.

## Acceptance criteria

- [ ] A context row can be created and fully bound without a mouse.
- [ ] Register columns are generated from dimensions at render time — adding a dimension adds a column (assert in a component test).
- [ ] Draft flag appears iff bindings are incomplete.
- [ ] EditableGrid is one shared component with zero register-specific logic baked in (tier 1/2 tables reuse it unchanged in slices 013–014).
