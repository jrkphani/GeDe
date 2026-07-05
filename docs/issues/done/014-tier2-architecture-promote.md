# 014: Tier 2 — Architecture tables + promote to design

- **Status**: SHIPPED
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

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: nesting — arbitrary depth entries round-trip; move keeps subtree intact.
2. Unit: promote — creates dimension + parameters with `source_entry_id`; re-promote extends without duplicating already-linked entries.
3. Unit: rename propagation; delete-with-linked-parameter surfaces the resolution choice as a typed result (no silent behavior).
4. Component: nested rows indent correctly; promote selection spans nesting levels.
5. e2e: build the example's Stakeholders table (Buyers, Maintainer, Users with nested circles) → promote to Stake dimension → register combobox now offers those parameters → rename "Users" in tier 2 → register shows the new name.

## Acceptance criteria

- [x] Full GeDe Tavalo example enterable end-to-end (SPEC §6 M5 done-when).
- [x] No orphan `source_entry_id` references possible (integrity test).
- [x] Promote is one undo step per invocation.

## Shipped notes

- **Schema/migration** `0005_tier2` (journal idx 5): `tier2_tables` + `tier2_entries` (self-nesting via `parent_id`); `parameters.source_entry_id` FK → `tier2_entries` for the live link back (SPEC invariant 7). `src/domain/entryTree.ts` = pure build/flatten/subtree helpers.
- **Store** (`src/store/tier2.ts`): tables, nested entries, promote, delete-with-link resolution; generation-guarded `load`, command-log undo (promote = one step).
- **Promote flow** (`mutations.ts` `promoteEntries`): target new dimension (palette-colored from existing count) or extend an existing one; idempotently skips already-linked entries; inserts parameters carrying `source_entry_id`. Renaming a tier-2 entry propagates to its parameter; deleting a linked entry surfaces the typed resolution popover (keep-as-unlinked-copy / delete-if-unbound) — never a silent cascade.
- **UI** (`src/components/ArchitectureSurface.tsx`): one paper panel per table, `EditableGrid` reused unchanged (24px indent per level, chevrons on parents), ghost "Add table" panel. Multi-select via the leading tree-cell "Select X" button (plain toggle, Shift-click ranges) — chosen over row-modifier-click because `EditableGrid.onRowClick` carries no event, keeping the grid unmodified per ADR-0004. Checkboxes appear only once ≥1 selected (progressive disclosure). Source badges (`→ Stake`) on promoted entries; a link glyph on the parameter side (`ParameterList.tsx`) so both ends of the link are visible.
- **Rendering**: `App.tsx` `case 'tier'` now renders `ArchitectureSurface` for the `architecture` tier (route already existed). `DesignSurface` gained one effect — `useTier2Store.load(projectId)` — so `ParameterList` can name a parameter's source entry. `ui/popover.tsx` gained a `PopoverAnchor` export.
- **Merge note**: cherry-picked onto the 012+017 tip; only conflict was `base.css` (three issues appending CSS) — resolved by keeping all blocks. `DesignSurface.tsx`/`App.tsx`/`schema.ts`/`mutations.ts` auto-merged.
- **Verified**: full `npm run verify` green on main (unit/component incl. entry-tree + tier2 store/mutations + integrity tests, e2e incl. `e2e/architecture.spec.ts` — build Stakeholders → promote → register offers params → rename propagates). Manual chromium screenshots confirmed nested tables, multi-select bar, promote popover + preview, source badges, and the delete-resolution popover.
