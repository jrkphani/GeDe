# HANDOFF — 2026-07-05

For the next agent (or a fresh session). Read this, then `docs/issues/README.md`, then the next issue file. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe · branch `main` · clean at `7c9fc8f`. The repo is **public** — the private source documents (`GeDe Tavalo.numbers`, the Macro/Micro economy PDF/Pages) and `graphify-out/` are gitignored on purpose; do not commit them.

**Shipped** (in `docs/issues/done/`, index rows marked ✅):

| Issue | What exists now |
| --- | --- |
| 000 | Vite + React 19 + TS strict scaffold; PGlite + Drizzle with migrations 0000/0001; Vitest + Playwright; `npm run verify` gate; design tokens (both themes) + graph-paper ground; self-hosted Inter/JetBrains Mono |
| 001 | Projects CRUD: mutation layer (`src/db/mutations.ts`), Zustand store, ProjectsList with phantom row + in-place rename, archive with status-line Undo, reload durability e2e |
| 016 | App shell: pure route module + tiny history hook (no router lib — deliberate, documented), app bar (tabs, ⌘1/2/3, theme toggle, rename), portal-based ContextBar slot, status bar (single feedback channel, aria-live), last-tier redirect, not-found |
| 002 | Dimensions: migration 0001, palette auto-assign (`src/theme/palette.ts`), typed `DimensionFloorError` (n ≥ 2 in the store, not just UI), manager popover (dnd-kit drag + Alt+arrow reorder, 8-slot swatch picker + hex, in-place rename), guided start below the floor |

**Next up: issue 003 — parameters on dimensions** (`docs/issues/003-parameters-on-dimensions.md`). All blockers shipped. After that, 004 (EditableGrid register — the biggest M1 slice; both its blockers 003+016 will then be done). Parallel tracks open after 004: canvas (008→010), tiers (013→014), palette (017), plus 005/006.

## How to work (non-negotiables)

1. **TDD, red first.** Each issue has a *Test-first plan* — write those tests, watch them fail, then implement. This has caught a real bug in every slice so far.
2. **`npm run verify`** (typecheck → lint → vitest → playwright) must be green before an issue is SHIPPED. Currently: 36 unit/component tests, 9 e2e, all green.
3. **Schema changes only via `npm run db:generate`** (drizzle-kit) — never hand-write DDL. Migrations apply via the browser-safe runner in `src/db/migrate.ts` (`import.meta.glob` + `__migrations` ledger).
4. **Layer boundaries are lint-enforced**: components must not import `src/db/*` (typescript-eslint no-restricted-imports). Writes: component → store action → `src/db/mutations.ts`. Keep it that way; extend the rule if you add layers.
5. **Ship ritual**: set issue Status → SHIPPED, `git mv` it to `docs/issues/done/`, update the README index row (`done/` link + ✅), commit with the issue number, push. One commit per issue.
6. **References lines in issues are binding** — deviating from a cited SPEC/STYLE_GUIDE/SITEMAP section is a spec discussion, not an implementation choice.

## Architecture facts you'll need

- **DB**: PGlite (Postgres-in-WASM), `idb://gede` in browser, `memory://` in tests. `getDatabase()` in `src/db/client.ts` is a **singleton — never instantiate two PGlites on the same idb dir** (StrictMode double-mount deadlocked + crashed WASM; that's why the singleton exists).
- **Stores** (Zustand): `projects`, `dimensions`, `status` share one db handle via `src/store/database.ts` (set by `projects.init()`, or `setDatabase(db)` directly in tests). Reset helpers exist per store for tests.
- **Shell slots**: tiers put content in the context bar by rendering `<ContextBar>…</ContextBar>` (portal; band collapses when empty). All user feedback goes through `useStatusStore.announce(message, {label, run})` — no toasts, ever.
- **Routing**: `src/shell/routes.ts` (pure parse/serialize) + `src/shell/router.ts` (`useRoute`/`navigate`). Add route shapes to the type + both functions + the round-trip test.
- **Undo**: currently single-step inverse per gesture (archive only). Issue 006 replaces this with a command log; every store action is already "one gesture = one call" to be that seam. Don't add per-feature undo buttons — reuse the status-bar action.

## Gotchas already paid for (don't rediscover)

- **RTL auto-cleanup doesn't run** without vitest globals — `src/test/setup.ts` registers it manually. Component tests need `// @vitest-environment jsdom` as line 1.
- **Radix popovers close on Escape at document level** — in-place editors inside popovers need the `onEscapeKeyDown` guard (see DimensionManager) to honor the SITEMAP §4 Esc order.
- **Never publish related store updates in two `set()` calls** if a surface derives visibility from the first — the guided-start swap unmounted an open editor mid-gesture until `add()` set `dimensions` + `editingId` atomically. Pattern: one gesture = one atomic `set()`.
- **e2e**: two "Undo"-named buttons exist (app bar disabled + status bar) — scope selectors (`page.locator('.status-bar')…`). After clicking "Add dimension", wait for the row editor before sending keys.
- **PGlite must stay in `optimizeDeps.exclude`** (vite.config.ts) or its WASM breaks in dev.

## Docs map

`docs/SPEC.md` (domain model + invariants — the law) · `docs/TECH_STACK.md` (stack + §6 deployment architecture + decision log T1–T8) · `docs/STYLE_GUIDE.md` (tokens; already implemented as CSS vars in `src/styles/tokens.css`) · `docs/SITEMAP.md` (routes, shell anatomy, keyboard map) · `docs/adr/` (why-records) · `docs/issues/` (the backlog; README = index + working agreement).

A knowledge graph of the whole project lives in `graphify-out/` (local only): `graph.html` to browse, `/graphify query "…"` to ask. Rebuilt through issue 002 docs; run `/graphify --update` after large doc changes if you want it current.

## Deferred / open threads

- CI (GitHub Actions + OIDC deploy per TECH_STACK §6.4) is specced but not set up — `npm run verify` is local-only right now. Reasonable to add any time; blocked on an AWS account decision, not on code.
- Issue 011 contains one deliberately open design rule (stale parent re-bind) that must be decided + tested inside that slice.
- `docs/issues/README.md` "Parallelizable tracks" note tells you what can run concurrently if multiple sessions are working.
