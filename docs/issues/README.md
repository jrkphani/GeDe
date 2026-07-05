# Issues

One markdown file per issue: `NNN-short-slug.md`. Each issue is a **vertical slice** — schema → store → UI — sized for TDD: the *Test-first plan* section lists the red tests to write before any implementation, and the acceptance criteria are those tests passing plus the standing gates (`npx tsc --noEmit`, `npx eslint . --quiet`).

## Working agreement (TDD)

1. Pick the lowest-numbered OPEN issue whose blockers are SHIPPED.
2. Write the issue's *Test-first plan* tests; watch them fail.
3. Implement until green; refactor; run `npm run verify`.
4. Update the issue status; commit with the issue number in the message.

## Index

| # | Slice | Milestone | Blocked by |
| --- | --- | --- | --- |
| [000](done/000-walking-skeleton.md) ✅ | Walking skeleton & TDD harness | M1 | — |
| [001](done/001-projects-crud-persistence.md) ✅ | Projects CRUD + reload durability | M1 | 000 |
| [016](done/016-app-shell-navigation.md) ✅ | App shell — routes, header, tabs, status bar | M1 | 001 |
| [002](done/002-dimension-management.md) ✅ | Dimension management (n ≥ 2) | M1 | 001 |
| [003](done/003-parameters-on-dimensions.md) ✅ | Parameters on dimensions | M1 | 002 |
| [004](done/004-context-register-editable-grid.md) ✅ | Context register + EditableGrid core | M1 | 003, 016 |
| [005](done/005-justification-documented-duplicates.md) ✅ | Justification, documented, duplicates | M1 | 004 |
| [006](done/006-undo-redo-command-log.md) ✅ | Undo/redo command log | M1 | 004 |
| [007](007-dimension-mutability-demotion.md) | Dimension mutability + demotion | M1 | 005, 006 |
| [008](008-canvas-readonly-deterministic-layout.md) | Canvas read-only + deterministic layout | M2 | 004 |
| [009](009-canvas-selection-composer-sync.md) | Selection, spokes, composer, sync | M2 | 008 |
| [010](010-compose-bind-from-canvas.md) | Compose & bind from canvas | M2 | 009 |
| [011](011-recursion-drilldown-breadcrumbs.md) | Recursion, drill-down, breadcrumbs | M3 | 010 |
| [012](012-coverage-matrix.md) | Coverage matrix | M4 | 010 |
| [013](013-tier1-foundation.md) | Tier 1 Foundation | M5 | 004, 016 |
| [014](014-tier2-architecture-promote.md) | Tier 2 Architecture + promote | M5 | 013 |
| [015](015-export-import-json.md) | Export/import JSON | M6 | 011, 014 |
| [017](017-command-palette.md) | Command palette (⌘K) | M2 | 016, 004 |
| [018](done/018-shadcn-tailwind-foundation.md) ✅ | shadcn/ui + Tailwind v4 foundation | M1 (pre-work) | — |
| [019](done/019-shared-primitive-migration.md) ✅ | Shared UI primitives + migration | M1 (pre-work) | 018 |
| [020](done/020-enforcement-guardrails.md) ✅ | Enforcement guardrails (types/tokens/components) | M1 (pre-work) | 019 |

Issue numbers are identity, not order — pick by the dependency graph (016 comes right after 001). Parallelizable tracks after 004: canvas (008→010), tiers (013→014), palette (017), and 005/006 can proceed independently.

Every issue carries a **Design brief** (grounded in STYLE_GUIDE/SITEMAP tokens and patterns) and a **References** line pinning the SPEC/STYLE_GUIDE/SITEMAP/TECH_STACK/ADR sections it implements — deviation from a referenced section is a spec change to discuss, not an implementation choice.

Statuses: `OPEN | IN PROGRESS | SHIPPED | ARCHIVED`. **SHIPPED issues move to `done/`** (index links follow them; the row stays as the permanent record). Issues graduate to GitHub Issues if/when collaboration warrants it.
