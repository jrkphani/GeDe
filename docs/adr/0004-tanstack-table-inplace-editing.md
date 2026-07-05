# ADR-0004: TanStack Table with custom in-place cells

- **Status**: Accepted
- **Date**: 2026-07-04

## Context

All three tiers present as table-based views mirroring the Numbers document; rows are edited **in place** — no input forms. Needs: nested rows (tier-2 hierarchy, context tree), dynamic columns (one per dimension), drag re-rank, full styling control. Alternatives: AG Grid Community (tree data is Enterprise-only), Glide Data Grid (canvas-rendered; custom editors/nesting/a11y harder), Handsontable (non-commercial license), hand-rolled `<table>` (re-implements row-model plumbing).

## Decision

**TanStack Table v8** (headless) powers every table, wrapped in one shared internal `EditableGrid` component implementing the spreadsheet grammar: click/Enter swaps a borderless input in place, Enter commits + moves down, Tab traverses, Esc reverts, new row = start typing. Parameter cells are in-place type-ahead comboboxes. **dnd-kit** provides row drag for re-ranking.

## Consequences

- 100% markup control → Numbers aesthetic achievable; editing behavior written once, used by tiers 1–3.
- We own the editing grammar code (the part AG Grid would have given us) — covered by Playwright flows.
- Virtualize with @tanstack/react-virtual before reconsidering the engine if tables ever exceed ~10k rows.
