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

## Test-first plan

1. Property test: apply a random sequence of N mutations (create/rename/bind/reorder/delete across all entities), undo N times → state deep-equals initial; redo N times → state deep-equals final. Run across seeds.
2. Unit: batch boundaries — drag-reorder emits one command; phantom-row create+first-edit is one step.
3. Unit: undo of a soft delete restores visibility and sort position.
4. e2e: edit a cell → ⌘Z reverts it → reload → the reverted state is what persisted.

## Acceptance criteria

- [ ] The property test is part of `npm run verify` (not a separate manual suite).
- [ ] Undo/redo works identically when triggered from register and (later) canvas — command layer is UI-agnostic.
- [ ] Persistence after undo proven by the e2e reload test.
