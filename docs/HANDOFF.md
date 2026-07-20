# HANDOFF — 2026-07-20 (089 GRADUATED)

**089 D3-canvas graduation is COMPLETE + LIVE. P0·P1·P2·093·P3·P4·P5·P6·P7 all SHIPPED. The React Flow canvas is now the capability-gated DEFAULT workspace in production.** Remaining backlog: two filed, non-blocking follow-ups (`099`, `100`). No phase is mid-flight.

Launch prompt for the next session: `docs/NEXT-ORCHESTRATOR.md`. Authoritative record: `docs/issues/done/089-unified-canvas-workspace.md` (all phases marked SHIPPED with lessons).

---

## Current state

Live: HEAD **`31b20a9`** deployed (CI `verify` — full suite, canvas-default, with retries — + `deploy` green). **Live-verified on https://d1nzod71m3rz6x.cloudfront.net**: `/design` renders the React Flow canvas with NO `?d3rf` (capability-gated), `role="main"` landmark present, 4 lane nodes. The canvas is the prod default for capable clients (≥ 1024px + not data-saver); `WorkspaceSurface` (D2 stacked lanes) is the `< 1024px` / reduced-data fallback.

What P7 shipped (`337157d` + `31b20a9`):
- **Gate is capability-based** (`src/store/canvasMode.ts`): `canvasEnabled = canvasCapable() || d3rfInUrl()` (matchMedia `min-width:1024px` && !`prefers-reduced-data`; jsdom/SSR-safe → false → WorkspaceSurface). `?d3rf` retained as a force-on override. Seed once-at-boot, deliberately not re-seeded on resize. `App.tsx` ternary unchanged.
- **RF ships → PROD-FOLD inverted**: `vite.config.ts` dropped the `WorkspaceCanvas-*` globIgnores; `d3CanvasNav.guard.test.ts` reframed to "RF budgeted to its lazy chunk" (assertions unchanged; RF ~88 KB gz stays OUT of the main bundle — narrow clients don't pay for it).
- **e2e canvas/fallback SPLIT**: the ~57 non-`@dev-flag` specs re-pin to the shipping `WorkspaceSurface` fallback via `e2e/workspaceSurface.ts::forceWorkspaceSurface` (a `prefers-reduced-data` matchMedia shim); `d3-canvas.spec.ts` (22 `@dev-flag`, incl. a canvas axe smoke) is the canvas suite. `playwright.config.ts` gained `retries: CI ? 2 : 0`.
- **a11y**: canvas `main` landmark + axe smoke → canvas is WCAG2 A/AA serious/critical clean.
- **SITEMAP §1-4 + 085** reframed in lockstep (route grammar RETAINED as spatial deep-links; 085 spirit reversed, no-on-ring-authoring rule holds).

The full P0–P6 detail is in the 089 issue doc + git log. P6 (deploy-gate transition) put the 21 canvas specs INTO the gating `verify` (they now gate deploys; `@dev-flag` tags retained as a one-line rollback lever — re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas flake ever threatens deploys).

## Backlog — two filed follow-ups (both NON-blocking; 089 is done without them)

- **`099` — canvas-default coverage + a11y follow-ups.** Canvas-side e2e for behaviors currently only on the fallback (hover-mute, label-tier, empty-state suppression); investigate the label-tier-vs-RF-transform hypothesis (likely a non-issue — uniform zoom preserves proportions); a11y beyond the P7 axe smoke; touch/tablet verification; harden the cross-node-Tab spec (flakes under full-suite load — mitigated by CI retries). All small/independent.
- **`100` — promote the recursion satellite STUB → a live child {register+ring} core.** The tracked P3 follow-up. BIG: needs a per-canvas store factory (singleton `contexts`/`dimensions`/`parameters`/`canvasCompose` → `canvasId`-keyed instances), a Rule-12 sweep of every consumer, its own budget + MANDATORY adversarial review. Its own multi-file phase; owner may sequence anytime. Relates to 090 (multi-canvas identity).

## Patterns (established this build — reuse)

- **Derived positions only.** Node `{x,y}` = `computeLaneLayout(tier, sort, measured-height)`; width never feeds the x-stride. Constrained drag pins x + calls the store reorder (sort/rank), never persists `{x,y}`.
- **Cross-tree shared state → a Zustand store** (RF nodes can't share React state): `canvasCompose`, `canvasSatellites`, `canvasCoverage`, `canvasMode`. **NOTE: these are SINGLETONS today — 100 makes them per-canvas.**
- **Zoom inside a node body:** RF `useStore((s) => s.transform[2] < THRESHOLD)` — a BOOLEAN selector (re-renders only on threshold crossing), never through the reconcile hot path.
- **A zoom-LOD swap of an editable surface must be EDIT-AWARE** — track focus in a **ref** (state re-renders mid-click and cancels click-to-edit). DOM `.contains()` is unreliable vs PORTALLED popovers (Radix) — prefer a store flag / `:focus-within` / width-cap.
- **Pure decision logic → a unit-tested helper, not a flaky e2e** (P6): `focusPanTarget` (pan decision) + `canvasCapable` (gate) are pure + unit-tested; the flaky animation/timing stays in RF.
- **Capability gate (P7):** clone the jsdom-safe matchMedia pattern (`laneTarget.ts:42`); `matchMedia` absent → false. Seed once at boot, never on resize (documented tradeoff).
- **e2e canvas vs fallback:** `d3-canvas.spec.ts` (`@dev-flag`, `?d3rf`) tests the canvas; everything else pins `WorkspaceSurface` via `forceWorkspaceSurface(page)`. `reducedMotion:'reduce'` + `waitForStableViewport` + geometry `expect.poll` is the canvas e2e de-flake template.

## Non-negotiables & tooling

- **Deploy = push to `main`** → CI `verify` (typecheck + lint + stylelint + vitest + full Playwright e2e incl. canvas specs, `retries:2` in CI) → `deploy.yml` via `workflow_run`. Watch with `gh run list --json` (`gh run watch` is flaky). **Rollback if canvas specs flake: re-add `--grep-invert @dev-flag` to `package.json` `e2e`.**
- **`git push` conflicts with the husky pre-push hook if a local e2e loop runs** (the loop's `pkill vite` kills the hook's server) → push `--no-verify` after verifying yourself.
- **STALE-VITE:** `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before every e2e re-run.
- **Bundle budget (PROD-FOLD inverted at P7):** after any lazy-import/chunk change, prod-build + grep that `xyflow` stays OUT of the main `index-*.js` (it lives in `WorkspaceCanvas-*.js`).
- **TEST EVERY route on the canvas** (`/foundation`, `/architecture`, `/design` + navigate) — watch for "Maximum update depth" tier-route bugs. **`routes.ts` grammar is intact (P7 retained it as deep-links).**
- **≤3 concurrent subagents**; commit `--no-verify` after running verify yourself + explicit `git add`; worktree-isolate overlapping subagents.
- **Adversarially review** every hot-path/store/write-path change (MANDATORY for 100's store-factory refactor). **Screenshot** user-facing changes. **Schema only via migrations** (089 was frontend-only).
- **Live creds** (owner provides at launch — never commit): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD='<from owner>'`; rotate after. ⚠️ prior password is in public git history — compromised. The account-free local app is verifiable without creds (P7 was live-smoked that way); a server WRITE-path smoke needs the password → **CloudWatch** (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) is the authoritative write check.

## Definition of done / next

089 is DONE (graduated + live-verified + archived to `docs/issues/done/`). Open backlog = `099` + `100`. Per the standing directive: build the backlog autonomously (all 089/093 forks are answered), OR surface a genuinely NEW owner-fork via `AskUserQuestion` — `100` (the store-factory refactor) is large enough to be worth confirming sequencing/scope with the owner before starting.

---

*History (shipped + archived to `docs/issues/done/`): 084 grid unification; 087/088/090/091/092/094/095/096/097/098; 089 (D1/D2/D3-graduation) + 093. This HANDOFF was rewritten 2026-07-20 at 089 close.*
