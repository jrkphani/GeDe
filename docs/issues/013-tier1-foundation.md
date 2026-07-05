# 013: Tier 1 — Foundation (purpose + ranked value propositions)

- **Status**: OPEN
- **Milestone**: M5
- **Blocked by**: 004

## Slice

As a designer I record the system's purpose and its ranked value propositions in a Numbers-style table: rank (1°, 2°…), name, description — edited in place, dragged to re-rank.

## Scope

- Schema/store: `tier1_purpose` (single body per project), `tier1_props` (rank, name, description, sort).
- UI: Foundation tab — purpose text block (in-place, multiline) + propositions table reusing `EditableGrid` unchanged; dnd-kit row drag re-ranks; ranks render with degree notation per STYLE_GUIDE §3.
- No linkage to tiers 2–3 in this slice (that arrives with 014's promote flow patterns).

## Test-first plan

1. Unit: re-rank via drag rewrites ranks 1..k contiguously; delete closes the gap.
2. Component: EditableGrid reuse — zero new grid logic; only column defs and a rank cell renderer are tier-1 specific (assert by module boundary).
3. Component: degree notation renders `1°` `2°` from integer ranks.
4. e2e: enter the example's five value propositions (Seating-status comfort … Age-spectrum compatibility), drag #4 to #1, reload → order and ranks persist.

## Acceptance criteria

- [ ] EditableGrid required no modification (proves slice 004's reuse claim).
- [ ] Re-rank is one undo step.
- [ ] Purpose block autosaves through the mutation layer like any cell.
