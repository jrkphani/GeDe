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

## Test-first plan

1. `db.test.ts` — migration 0000 applies on a fresh PGlite; inserting and selecting a project row round-trips. *(red until schema exists)*
2. `app.spec.ts` (Playwright) — app serves, renders shell heading, no console errors.
3. CI-shaped script `npm run verify` = tsc + eslint + vitest + playwright.

## Acceptance criteria

- [ ] `npm run verify` green from a clean clone.
- [ ] Migration files are the only way the schema exists (no `CREATE TABLE` outside migrations).
- [ ] A second `npm run verify` run is idempotent (migrations don't re-apply).
