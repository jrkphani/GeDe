# HANDOFF — 2026-07-07 (v2 collaboration wave)

For the next agent/session. Read this, then `docs/issues/README.md`, then the next issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public; `main`). The **v1 app** (issues 000–028, 039) and the **M7 deploy layer** (040/029/041) are shipped and **live at https://d1nzod71m3rz6x.cloudfront.net** (CDK: `Gede-Test-Network/-Hosting/-Dns`; OIDC CI deploys `main` after `verify` goes green; AWS acct `975049998516`).

**v2 (collaboration) — on PR #7, green + unmerged.** The whole v2 wave (issues **032, 033, 034, 035, 036, 043**) is integrated on branch `feat/v2-collaboration-wave` → **PR #7**, all CI green (`verify` 722 unit + 49 e2e, `cdk-validate` 65 CDK, `migration-parity`). **Not merged: merging auto-deploys** and mutates live infra — real RDS RLS (migration 0008), invitations (0009), the write-path Lambda + idempotency ledger (0010), and the v2 NAT/RDS/Fargate stacks (030, cost gate already crossed). Merge only when you want that live.

- **032** Electric **read-path** sync → PGlite + client optimistic-write queue (migration `0007` bindings tombstone).
- **033** Auth — **Amazon Cognito** (User Pool CDK stack, hero + custom login, app-bar account chrome; auth Fargate stub removed). ADR-0009.
- **034** Workspaces + **Postgres RLS** (RLS keyed off Cognito `sub`; migration `0008`). `projectEnvelope` FORMAT_VERSION 1→2.
- **035** Sharing — roles & invitations (migration `0009`; fixed a real RLS bug in 034's `workspace_members` SELECT policy + tightened its INSERT).
- **036** Sync-state + offline reconciliation UI (over 032's engine).
- **043** **Write-path API** — serverless (Lambda behind the ALB): validates Cognito JWT, sets tenant/RLS context, enforces SPEC invariants, LWW, writes RDS (migration `0010`).

**Integration fix worth knowing** — 032 shipped a *half-converted* binding soft-delete model; the combined verify caught a latent `undoRedo.property` failure. Fixed in `mutations.ts` (`fix(032)`): cascade filters `isNull(deletedAt)`; `bindParameter` clears `deletedAt` on re-bind; `unbindParameter` tombstones (not hard-deletes); `restoreDimension` restores each binding's `parameterId`. Lesson: **a per-agent worktree verify can pass on fast-check seed luck — always run one combined verify after integrating.**

**Next up (all OPEN, after PR #7 merges):** **037** (local→cloud on-ramp), **038** (presence, demand-gate first), **042** (semantic command palette, standalone/M6, no v2 spend). See `docs/issues/README.md` (M8–M10) + ADR-0008/0009/0010.

**Follow-ups flagged on PR #7** (not blockers): the write-path Lambda is a deterministic *inline stub* (real handler is unit-tested at `src/server/writeApi/*` but bundling deferred until the client queue actually flushes to `/write`); its `COGNITO_ISSUER` is a placeholder pending cross-stack wiring of 033's User Pool; 034's `workspace_id` is denormalized onto top-level tables but `tier2_entries`/`parameters`/`bindings` scope via a join.

## How to work (non-negotiables)

1. **TDD, red first.** Each issue has a *Test-first plan* — write those tests, watch them fail, then implement.
2. **`npm run verify`** (typecheck → eslint → stylelint → vitest → playwright) green before SHIPPED. Husky pre-push runs `verify:fast`; CI runs full `verify`; pre-commit runs `lint-staged`.
3. **Schema only via `npm run db:generate`** — never hand-write DDL. Rename the file + update `meta/_journal.json`'s `tag` (the runner globs by filename). Migrations are `0000`–`0010`; **pre-assign the next slot before parallel work so two agents never collide.**
4. **Layer boundaries are lint-enforced**: components can't import `src/db/**`; writes flow component → store → `src/db/mutations.ts`. No raw `<button>`/`<input>`/`<select>` or `@radix-ui`/`cmdk` outside `src/components/ui/` (scope now includes `src/shell/**`); no hardcoded CSS colors.
5. **Ship ritual**: Status → SHIPPED, `git mv` to `docs/issues/done/`, README index row ✅, one commit per issue.
6. **References lines in issues are binding** — deviating from a cited SPEC/STYLE_GUIDE/SITEMAP/ADR section is a spec discussion, not an implementation choice.
7. **New UI composes `src/components/ui/`** primitives (ADR-0007); `EditableGrid` is the one exempt grid primitive.

## Architecture facts

- **DB**: PGlite, singleton `getDatabase()` (`src/db/client.ts`) — never two PGlites on one idb dir (StrictMode deadlock). `idb://gede` in browser, `memory://` in tests.
- **Stores** (Zustand): projects/dimensions/parameters/contexts/status + v2's `sync`/`auth`/`workspace`; share one db handle via `src/store/database.ts`.
- **Shell**: pure route module + tiny history hook (`src/shell/routes.ts`/`router.ts`); tiers fill the context bar via the `<ContextBar>` portal; **all feedback goes through `useStatusStore.announce()`** — no toasts.
- **Undo/redo**: `useCommandLogStore` — every store action pushes `{label, undo, redo}`; `batch()` groups a gesture; ⌘Z/⇧⌘Z in `AppShell` (**capture phase**). Session-scoped.
- **Design surface is canvas-scoped** (011): `DesignSurface({projectId, contextPath, view})`; stores canvas-scoped via `contextId`/`parentId`. `Canvas`/`Composer` are pure/presentational; `layout()` in `canvasLayout.ts` has zero React/store imports.
- **v2 sync** (032): `src/sync/*` (electricProtocol wire→`RowDelta`, syncEngine, config, authToken seam), `src/domain/{syncDelta,mutationQueue}.ts` (pure LWW + queue), `src/db/sync.ts` (transactional apply). `electricProtocol.ts`'s `SQL_TO_JS_COLUMNS` mirrors `schema.ts` column-for-column — **incoming deltas for workspace-scoped tables must carry `workspace_id`** (NOT NULL post-034).
- **v2 auth** (033): `src/auth/*` (Cognito SRP client, jwt decode, `wireIdentity.getAuthHeaders()`), `src/store/auth.ts` (non-blocking hydrate). Local account-free mode still boots instantly; JWT only scopes the shared path.
- **v2 tenancy** (034): `src/db/{workspaces,tenantContext}.ts`, `src/domain/workspaceRole.ts`; RLS in migration `0008` (SECURITY DEFINER helpers avoid self-reference recursion; `app_user` least-priv role — RLS is inert on PGlite since it connects as owner, enforced on server Postgres).
- **v2 write-path** (043): `src/server/writeApi/*` (jwt/tenancy/rejection/store/handler/albAdapter), `src/domain/{mutationProtocol,writeInvariants}.ts` (client+server share the invariant predicates). Deployed as a stub Lambda (see follow-ups).
- **Export/import** (015): pure `projectEnvelope.ts` (FORMAT_VERSION **2**, id-remap; identity/infra tables `workspaces`/`workspace_members`/`invitations`/`applied_mutations` excluded) + atomic `importProject` (one transaction, NULL-then-UPDATE two-pass for FK cycles).

## Gotchas already paid for (don't rediscover)

- **Combined-verify > per-agent verify.** Fast-check/property tests can pass on lucky seeds in an isolated worktree and fail once integrated (the `fix(032)` binding-model bug). Merge order = dependency order, then one full verify + real-bug triage.
- **Worktree base is not always current `main`.** Isolated agent worktrees sometimes branch from a stale commit (043 branched 16 behind → built against *documented* interfaces). On integration: check `git merge-base`, prefer cherry-pick for a stale single-commit branch, take `main`'s migration `_journal.json`/meta and graft only the new slot.
- **A fresh worktree's `node_modules` is empty** — run `npm ci` in it or e2e mass-fails on Vite's `fs.allow` boundary. Applies to every parallel agent.
- **CI is slower/contended** — heavy property + cold-start e2e tests hit timeouts that pass locally. Fix with headroom, not by weakening the test: `playwright.config.ts` bumps CI test/expect timeouts; the undoRedo property uses `numRuns: CI ? 25 : 40` + a 120s timeout. Distinguish a timeout flake from a real failure before "fixing".
- **CDK `NodejsFunction` bundling is environment-sensitive** (esbuild availability + machine-specific asset hash — the issue-041 hazard for Lambda). Stub not-yet-wired Lambdas with `Code.fromInline` (like 030's nginx Fargate stub) so `cdk synth` is deterministic and toolchain-free. Hosting's `BucketDeployment` uses the same discipline via `normalize-asset-hashes.ts`.
- **A `load()`-style store action must set its id/scope field synchronously (first line)** and use a per-key `generation` counter — a mutation firing right after mount can otherwise lose a race (100% on CI, 0% locally).
- **Never two `set()` calls** where a surface derives visibility from the first (unmounts an open editor mid-gesture). Selector fallbacks must be stable module-level refs (`const EMPTY = []`), not `?? []`.
- **`flexRender(cell)` treats `cell` as a component type** — one stable module-level `renderGridCell`; pass config + live `nav` via TanStack `meta`, never a per-render closure.
- **Global keyboard shortcuts on the capture phase** (a descendant's `stopPropagation()` swallows bubble-phase); deferring to native text-field undo must check the field has content.
- **jsdom polyfills** (`hasPointerCapture`, `scrollIntoView`, `ResizeObserver`, `localStorage`) live in `src/test/setup.ts`; component tests need `// @vitest-environment jsdom` line 1. RTL auto-cleanup is registered manually there.
- **`d3.arc()()` centers at `(0,0)`** — wrap the arc `<path>` in `translate(...)`. d3-force falls back to `Math.random()` only on exact-coincident nodes — seed positions by id hash (ADR-0005 forbids randomness). Canvas radial labels anchor by side to read outward.
- **Manual browser verification is not optional for visual/layout work** — component tests assert data, not geometry/CSS. Drive `chromium` from `playwright-core` at ≥640px and look at real screenshots.
- **Reduced-motion**: `base.css` blanket-disables animation, so a mount-fade's resting opacity must be the *final* state (1), dipped to 0 only at mount. `@container` queries can't target the element that sets `container-type`.
- **e2e scoping**: two "Undo" buttons (app bar + status bar) → scope to `.status-bar`; wait for a phantom row's visible effect before the next keystroke; `{ exact: true }` for `Select Entry 1` (substring-matches 10–19).

## Docs map

`docs/SPEC.md` (domain + invariants) · `docs/TECH_STACK.md` (stack/deploy/decisions) · `docs/STYLE_GUIDE.md` (tokens → `src/styles/tokens.css`) · `docs/SITEMAP.md` (routes, shell, keyboard) · `docs/adr/` (why-records; ADR-0008 v2 backend, 0009 Cognito, 0010 tiers) · `docs/DEPLOYMENT.md` (§9 v2 topology) · `docs/issues/` (backlog; README = index + working agreement).

A local knowledge graph lives in `graphify-out/` (gitignored): `graph.html` to browse, `/graphify query "…"` to ask, `/graphify --update` after large changes.
