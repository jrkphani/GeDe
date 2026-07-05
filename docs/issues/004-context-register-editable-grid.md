# 004: Context register with in-place editing (EditableGrid core)

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: 003

## Slice

As a designer I can create contexts in the register table and bind one parameter per dimension entirely in place — no forms. This slice builds the shared `EditableGrid` (TanStack Table wrapper), the highest-risk UI component in the plan (TECH_STACK T2).

## Scope

- Schema/store: `contexts` (symbol auto-assigned from the Greek cycle, manual override), `bindings` with `UNIQUE(context_id, dimension_id)` (re-binding a dimension is an upsert), `tuple_hash` computed on completion.
- Draft vs complete: a context missing any dimension's binding is a draft (SPEC invariant 1) and visibly flagged.
- UI: register with dynamic columns (Symbol · one per dimension · Justification · Children), phantom row, text cells (in-place input) and **parameter combobox cells** (type-ahead constrained to the column's dimension).
- Keyboard grammar: click/Enter edits; Enter commits + moves down; Tab/Shift-Tab traverse; Esc reverts; arrows navigate cells.
- Out of scope: justification semantics (005), canvas (008+), children column populated (011).

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
