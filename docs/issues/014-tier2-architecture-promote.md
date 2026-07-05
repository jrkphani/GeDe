# 014: Tier 2 — Architecture tables + promote to design

- **Status**: OPEN
- **Milestone**: M5
- **Blocked by**: 013

## Slice

As a designer I build nested architecture tables (Value / Stakeholders / Process in the example; tables addable/renamable) and promote entries into the 3rd Tier: each table maps to a dimension, selected entries become its parameters — with a live link back (SPEC invariant 7).

## Scope

- Schema/store: `tier2_tables`, `tier2_entries` (nested via `parent_id`); `parameters.source_entry_id` wiring.
- UI: Architecture tab — one nested EditableGrid per table (indent per STYLE_GUIDE §4); add/rename tables.
- Promote flow: select entries → "use as dimension/parameters" seeds or extends the root canvas; promoted parameters show a source badge.
- Link semantics: renaming a tier-2 entry propagates to its parameter; deleting a linked entry requires resolution (keep parameter as unlinked copy, or delete if unbound).

## Test-first plan

1. Unit: nesting — arbitrary depth entries round-trip; move keeps subtree intact.
2. Unit: promote — creates dimension + parameters with `source_entry_id`; re-promote extends without duplicating already-linked entries.
3. Unit: rename propagation; delete-with-linked-parameter surfaces the resolution choice as a typed result (no silent behavior).
4. Component: nested rows indent correctly; promote selection spans nesting levels.
5. e2e: build the example's Stakeholders table (Buyers, Maintainer, Users with nested circles) → promote to Stake dimension → register combobox now offers those parameters → rename "Users" in tier 2 → register shows the new name.

## Acceptance criteria

- [ ] Full GeDe Tavalo example enterable end-to-end (SPEC §6 M5 done-when).
- [ ] No orphan `source_entry_id` references possible (integrity test).
- [ ] Promote is one undo step per invocation.
