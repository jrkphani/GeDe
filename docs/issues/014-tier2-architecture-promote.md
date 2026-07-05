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

## Design brief

- **Layout**: one paper panel per architecture table, stacked with 32px gaps; table name is an in-place-editable section header; "Add table" is a quiet ghost panel at the end.
- **Nesting**: 24px indent per level (one grid cell), no tree lines; expand/collapse chevrons (Lucide, 16px) only on rows with children.
- **Multi-select for promote**: rows select via ⌘/Ctrl-click and Shift-click (checkboxes appear only once ≥ 1 row is selected — progressive disclosure); a selection bar slides in at the panel foot: "3 selected · Use as dimension…".
- **Promote flow**: the action opens a popover — target: new dimension (named after the table, editable) or extend an existing one; preview line "Creates 3 parameters on *Stake*". One undo step.
- **Source badges**: promoted tier-2 entries get a muted mono `→ Stake` badge; the corresponding parameters show a link glyph whose tooltip names the source entry. Both sides of the link are visible.
- **Delete-with-link resolution**: deleting a linked entry surfaces an anchored popover with the two typed outcomes ("Keep parameter as unlinked copy" / "Delete parameter — unbinds 2 contexts"), never a silent cascade.
- **Rename propagation feedback**: the status line narrates "Renamed *Users* → 1 parameter updated".

**References**: SPEC §4.6, invariant 7 · SITEMAP §1 (`/architecture` route), §2 (context bar: table quick-jump, "Add table") · STYLE_GUIDE §5, §6, §9 · issues 004 (grid), 007 (impact-preview pattern)

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
