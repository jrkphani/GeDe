# 000: Walking skeleton & TDD harness

- **Status**: OPEN
- **Milestone**: M1
- **Blocked by**: —

## Slice

The thinnest end-to-end path: app boots, PGlite opens, migration 0000 applies, one row is written and read back. Establishes the entire test infrastructure so every later slice can be test-first.

## Scope

- Vite + React 19 + TypeScript strict scaffold; ESLint 9 flat config; Prettier.
- PGlite + Drizzle wired behind a `db` module; drizzle-kit migration pipeline (migration 0000: `projects` table only).
- Test harness: Vitest + Testing Library (unit/component), Playwright (e2e), each with npm scripts. Unit tests get a fresh **in-memory PGlite** with migrations applied per suite.
- vite-plugin-pwa installed but minimal (manifest only).

## Design brief

- **Tokens are code from day one**: all STYLE_GUIDE §2–4 values ship as CSS variables (`--paper`, `--grid-*`, `--ink*`, `--accent*`, spacing scale) under `:root` and `[data-theme="dark"]`. No component ever hard-codes a color.
- **Ground**: the shell renders the graph-paper background (CSS gradients, 24/96px pitch) with the wordmark — the drafting-table identity is visible in the very first build.
- **Fonts**: Inter + JetBrains Mono self-hosted woff2, Latin+Greek subset, `font-display: swap`; no CDN requests (offline PWA).
- **Global behaviors**: `prefers-reduced-motion` kill-switch for all transitions; `:focus-visible` outline token; theme switch stub (`data-theme`) even though the toggle UI comes later.
- **Microcopy**: none yet — the shell is silent except the wordmark.

**References**: TECH_STACK §2 (PGlite/Drizzle), §5, §7 (pins) · STYLE_GUIDE §2 (tokens), §3 (fonts), §8 (reduced motion) · SPEC §5

## Test-first plan

1. `db.test.ts` — migration 0000 applies on a fresh PGlite; inserting and selecting a project row round-trips. *(red until schema exists)*
2. `app.spec.ts` (Playwright) — app serves, renders shell heading, no console errors.
3. CI-shaped script `npm run verify` = tsc + eslint + vitest + playwright.

## Acceptance criteria

- [ ] `npm run verify` green from a clean clone.
- [ ] Migration files are the only way the schema exists (no `CREATE TABLE` outside migrations).
- [ ] A second `npm run verify` run is idempotent (migrations don't re-apply).
