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
| [007](done/007-dimension-mutability-demotion.md) ✅ | Dimension mutability + demotion | M1 | 005, 006 |
| [008](done/008-canvas-readonly-deterministic-layout.md) ✅ | Canvas read-only + deterministic layout | M2 | 004 |
| [009](done/009-canvas-selection-composer-sync.md) ✅ | Selection, spokes, composer, sync | M2 | 008 |
| [010](done/010-compose-bind-from-canvas.md) ✅ | Compose & bind from canvas | M2 | 009 |
| [011](done/011-recursion-drilldown-breadcrumbs.md) ✅ | Recursion, drill-down, breadcrumbs | M3 | 010 |
| [012](done/012-coverage-matrix.md) ✅ | Coverage matrix | M4 | 010 |
| [013](done/013-tier1-foundation.md) ✅ | Tier 1 Foundation | M5 | 004, 016 |
| [014](done/014-tier2-architecture-promote.md) ✅ | Tier 2 Architecture + promote | M5 | 013 |
| [015](done/015-export-import-json.md) ✅ | Export/import JSON | M6 | 011, 014 |
| [017](done/017-command-palette.md) ✅ | Command palette (⌘K) | M2 | 016, 004 |
| [018](done/018-shadcn-tailwind-foundation.md) ✅ | shadcn/ui + Tailwind v4 foundation | M1 (pre-work) | — |
| [019](done/019-shared-primitive-migration.md) ✅ | Shared UI primitives + migration | M1 (pre-work) | 018 |
| [020](done/020-enforcement-guardrails.md) ✅ | Enforcement guardrails (types/tokens/components) | M1 (pre-work) | 019 |
| [021](done/021-editable-grid-accessible-names.md) ✅ | Accessible names & grid semantics (EditableGrid) | M6 | 004 |
| [022](done/022-grid-keyboard-editing-grammar.md) ✅ | Grid keyboard editing grammar (Tab/Enter) | M6 | 004 |
| [023](done/023-canvas-parameter-dots-labels.md) ✅ | Canvas parameter dots + labels (invisible params) | M2/M6 | 008 |
| [024](done/024-grid-column-separators.md) ✅ | Table legibility — zebra rows + column hairlines | M6 | 004 |
| [025](done/025-architecture-selection-bar-placement.md) ✅ | Architecture selection/promote bar placement | M6 | 014 |
| [026](done/026-standalone-button-affordance.md) ✅ | Standalone button affordance (no-fill buttons) | M6 | 019 |
| [027](done/027-design-tier-layout-navigation.md) ✅ | Design tier layout cleanup + navigation clarity | M6 | 009, 011 |
| [028](done/028-canvas-focus-adjacency.md) ✅ | Canvas focus + adjacency (phase a; splines deferred) | M6 | 008, 009 |
| [039](done/039-canvas-spline-bundling.md) ✅ | Canvas spline bundling (028 phase b) | M6 | 028 |
| [029](029-deploy-oidc-static-pwa.md) | Deploy pipeline — OIDC static PWA → S3 + CloudFront | M7 | — |
| [030](030-v2-server-postgres-compose.md) | v2 server — Lightsail Postgres + Compose + backups | M8 | 029 |
| [031](031-sync-engine-decision.md) | Sync-engine decision — Electric vs Supabase (T6) | M8 | — |
| [032](032-sync-integration-row-delta.md) | Sync integration — Postgres ⇄ PGlite (row-delta, LWW) | M8 | 030, 031 |
| [033](033-auth-account.md) | Authentication + account | M9 | 030 |
| [034](034-workspaces-rls-tenancy.md) | Workspaces + Postgres RLS multi-tenancy | M9 | 032, 033 |
| [035](035-sharing-roles-invitations.md) | Sharing — roles & invitations | M9 | 034, 033 |
| [036](036-sync-state-offline-ui.md) | Sync state + offline reconciliation UI | M8 | 032 |
| [037](037-local-to-cloud-migration.md) | Local → cloud project migration (on-ramp) | M10 | 033, 034, 032 |
| [038](038-presence-live-collaboration.md) | Presence + live collaboration (speculative) | M10 | 032, 034, 035 |

Issue numbers are identity, not order — pick by the dependency graph (016 comes right after 001). Parallelizable tracks after 004: canvas (008→010), tiers (013→014), palette (017), and 005/006 can proceed independently.

**v1 milestones** M1–M6 are shipped (000–028; 028 is phase (a) — hover/focus adjacency emphasis — with spline bundling deferred). **v2 (collaboration)** is milestones **M7–M10**, all OPEN and grounded in TECH_STACK §6.3 + SPEC §1/§3:

- **M7 · Deploy** — 029 (OIDC static deploy; the deferred v1 half, and the foundation everything else ships onto).
- **M8 · Server & sync** — 030 (server Postgres) · 031 (T6 engine decision → ADR) · 032 (row-delta LWW sync) · 036 (sync-state UI). The critical path: **029 → 030/031 → 032**.
- **M9 · Identity & tenancy** — 033 (auth) · 034 (workspaces + RLS) · 035 (sharing/roles).
- **M10 · Collaboration polish** — 037 (local→cloud on-ramp) · 038 (presence, speculative — validate demand first).

The whole v2 bet rests on invariants v1 already satisfies: one Postgres dialect + one migration history (PGlite→server verbatim), UUIDv7 + `created_at/updated_at/deleted_at` on every row, and the single mutation layer that emits row-granular changes (the sync seam). Open decisions are flagged *inside* the issues (T6 sync engine, better-auth vs Supabase), not pre-decided.

Every issue carries a **Design brief** (grounded in STYLE_GUIDE/SITEMAP tokens and patterns) and a **References** line pinning the SPEC/STYLE_GUIDE/SITEMAP/TECH_STACK/ADR sections it implements — deviation from a referenced section is a spec change to discuss, not an implementation choice.

Statuses: `OPEN | IN PROGRESS | SHIPPED | ARCHIVED`. **SHIPPED issues move to `done/`** (index links follow them; the row stays as the permanent record). Issues graduate to GitHub Issues if/when collaboration warrants it.
