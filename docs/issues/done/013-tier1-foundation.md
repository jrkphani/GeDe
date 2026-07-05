# 013: Tier 1 — Foundation (purpose + ranked value propositions)

- **Status**: SHIPPED
- **Milestone**: M5
- **Blocked by**: 004, 016

## Slice

As a designer I record the system's purpose and its ranked value propositions in a Numbers-style table: rank (1°, 2°…), name, description — edited in place, dragged to re-rank.

## Scope

- Schema/store: `tier1_purpose` (single body per project), `tier1_props` (rank, name, description, sort).
- UI: Foundation tab — purpose text block (in-place, multiline) + propositions table reusing `EditableGrid` unchanged; dnd-kit row drag re-ranks; ranks render with degree notation per STYLE_GUIDE §3.
- No linkage to tiers 2–3 in this slice (that arrives with 014's promote flow patterns).

## Design brief

- **Layout**: the Foundation tab is the most document-like screen — a single column, purpose block above the propositions table, generous 32px section spacing on the graph paper.
- **Purpose block**: a paper panel that looks like a paragraph, not a textarea — click anywhere in it to edit in place; ghost text "What is this system for?" when empty.
- **Rank cells**: mono degree notation (`1°`, `2°`) in a narrow leading column; drag handle on row hover; during drag, ranks renumber live so the consequence is visible before drop.
- **Empty state**: phantom row "Name a value proposition"; the rank cell auto-fills `1°`.
- **EditableGrid reuse is the point**: this slice must add *zero* grid logic — only column defs and the rank cell renderer. Any temptation to fork the grid is a design failure escalated in review.
- **Microcopy**: header reads "1st Tier · Foundation" mirroring the source document's tier naming.

**References**: SPEC §4.6 · SITEMAP §1 (`/foundation` route), §2 (context bar hidden on Foundation) · STYLE_GUIDE §3 (degree notation), §6 · issue 004 (EditableGrid contract)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Unit: re-rank via drag rewrites ranks 1..k contiguously; delete closes the gap.
2. Component: EditableGrid reuse — zero new grid logic; only column defs and a rank cell renderer are tier-1 specific (assert by module boundary).
3. Component: degree notation renders `1°` `2°` from integer ranks.
4. e2e: enter the example's five value propositions (Seating-status comfort … Age-spectrum compatibility), drag #4 to #1, reload → order and ranks persist.

## Acceptance criteria

- [x] EditableGrid required no modification (proves slice 004's reuse claim).
- [x] Re-rank is one undo step.
- [x] Purpose block autosaves through the mutation layer like any cell.

## Shipped notes

- **Schema/migration**: `tier1_purpose` (single body per project, enforced by a unique `project_id` index) + `tier1_props` (rank, name, description, sort). Migration `0004_tier1.sql`, journal tag `0004_tier1` (generated name renamed to convention). `rank` and `sort` move in lockstep (`rank = sort + 1`), rewritten contiguous `1..k` on every add/reorder/remove.
- **Store** (`src/store/tier1.ts`): command-log-backed (one undo step per action, re-rank included); generation-guarded `load` with synchronous `projectId` set (the CI-race pattern from HANDOFF).
- **UI** (`src/components/FoundationSurface.tsx`): purpose block via `MultilineEdit` (ghost "What is this system for?", autosaves) + propositions table reusing **`EditableGrid` unchanged** — only tier-1 additions are the column defs and the `RankCell` renderer. dnd-kit wraps the grid; the sortable node is the rank cell (grid still owns the `<tr>`), with live rank renumber during drag. `src/domain/degree.ts`'s `formatDegree(n) → "n°"`.
- **Empty-state rank ghost** (`1°` in the phantom row) is CSS-only (`::before`), not grid logic — CSS can't count rows, so once props exist the phantom's leading cell stays quiet. This is deliberate: EditableGrid was left completely unmodified, which was the acceptance criterion.
- **routes.ts/router.ts untouched** — the `foundation` route shape already existed and round-trips were already tested; clean merge surface for issue 017.
- **Verified**: full `npm run verify` green on main (typecheck/eslint/stylelint clean, unit/component + e2e including `e2e/foundation.spec.ts`).
