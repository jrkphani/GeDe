# HANDOFF — 2026-07-20 (089 GRADUATED + polish)

**089 D3-canvas graduation is COMPLETE + LIVE. P0·P1·P2·093·P3·P4·P5·P6·P7 all SHIPPED. The React Flow canvas is the capability-gated DEFAULT workspace in production.** Since graduation, shipped a canvas-polish increment (`099` partial) + a user-reported fix (`101`, click-no-longer-pans). Remaining backlog: `099` (remainder) + `100`. No phase is mid-flight.

Launch prompt for the next session: `docs/NEXT-ORCHESTRATOR.md`. Authoritative 089 record: `docs/issues/done/089-unified-canvas-workspace.md` (all phases SHIPPED with lessons).

---

## Current state

Latest code: **`d3c5d84`** (issue 101 fix; this HANDOFF update commits on top of it) — pushed; CI `verify` for `d3c5d84` was in-flight at handoff time (verified locally, expected green → auto-deploys). Last CONFIRMED deploy: **`7c4996f`** (099 increment; `verify` + `deploy` green). **Live-verified on https://d1nzod71m3rz6x.cloudfront.net** (at P7): `/design` renders the canvas with NO `?d3rf`, `role="main"` landmark, 4 lane nodes. Canvas is the prod default for capable clients (≥ 1024px + not data-saver); `WorkspaceSurface` (D2 stacked lanes) is the `< 1024px` / reduced-data fallback.

Post-P7 commits on `main`: `76ebf08` (099a/b) · `7c4996f` (099 HANDOFF checkpoint) · `d3c5d84` (101 fix). If `verify` for `d3c5d84` is red at pickup, check whether it's the cross-node-Tab flake (CI `retries:2` should absorb it) vs a real failure.

What P7 shipped (`337157d` + `31b20a9`):
- **Gate is capability-based** (`src/store/canvasMode.ts`): `canvasEnabled = canvasCapable() || d3rfInUrl()` (matchMedia `min-width:1024px` && !`prefers-reduced-data`; jsdom/SSR-safe → false → WorkspaceSurface). `?d3rf` retained as a force-on override. Seed once-at-boot, deliberately not re-seeded on resize. `App.tsx` ternary unchanged.
- **RF ships → PROD-FOLD inverted**: `vite.config.ts` dropped the `WorkspaceCanvas-*` globIgnores; `d3CanvasNav.guard.test.ts` reframed to "RF budgeted to its lazy chunk" (assertions unchanged; RF ~88 KB gz stays OUT of the main bundle).
- **e2e canvas/fallback SPLIT**: the ~57 non-`@dev-flag` specs re-pin to the shipping `WorkspaceSurface` fallback via `e2e/workspaceSurface.ts::forceWorkspaceSurface` (a `prefers-reduced-data` matchMedia shim); `d3-canvas.spec.ts` (`@dev-flag`) is the canvas suite — canvas axe smokes (empty + populated register + the 2b coverage-matrix twin scan), the 101 click/touch-no-pan pair, cross-node Tab, etc. `playwright.config.ts` has `retries: CI ? 2 : 0`.
- **a11y**: canvas `main` landmark + axe smokes → canvas is WCAG2 A/AA serious/critical clean (empty + populated register).
- **SITEMAP §1-4 + 085** reframed in lockstep (route grammar RETAINED as spatial deep-links; 085 spirit reversed, no-on-ring-authoring rule holds).

P6 (deploy-gate transition) put the canvas specs INTO the gating `verify` — they gate deploys now; `@dev-flag` tags retained as a one-line rollback lever (re-add `--grep-invert @dev-flag` to `package.json` `e2e` if a canvas flake ever threatens deploys).

**101 (SHIPPED `d3c5d84`)** — clicking a canvas element no longer pans/centers the viewport. The focus-pan (`WorkspaceCanvas.onFocusCapture`) is now **keyboard-only**, gated by a persistent input-modality ref (`onPointerDownCapture`→pointer, `onKeyDownCapture`→keyboard; early-return unless keyboard). Keyboard nav (cross-node Tab, ⌘-jumps, create-focus) still pans off-screen targets into view.

## Backlog — `099` (remainder) + `100` (both NON-blocking)

- **`099` — canvas-default coverage + a11y follow-ups.** DONE: cross-node-Tab flake hardened (099a) + canvas axe smoke extended to a populated register (099b) (`76ebf08`); label-tier-vs-zoom → **NON-ISSUE, closed**; **2b SHIPPED (`bd6a913`)** — the CoverageMatrix ARIA grid is now valid on BOTH surfaces (each row's cells wrapped in a `display:contents` `role="row"` + `aria-rowindex`; RED-first axe scans on both hosts + a `CoverageMatrix.test.tsx` structural lock). **Still-open items:** (2c) `Canvas.tsx:130` hit-radius is transform-blind → the ~44px dot target shrinks under zoom (WCAG 2.5.5); feed screen-space width — *in progress (uncommitted working-tree changes to `Canvas.tsx`/`canvasResponsive.ts`/`DesignCoreAdapter.tsx` at handoff time; confirm its state via `git log`/`git status` before touching those files*). Canvas-side e2e for hover-mute + empty-state suppression (currently fallback-only); touch/tablet verification. All small/independent — see issue 099.
- **`100` — promote the recursion satellite STUB → a live child {register+ring} core.** The tracked P3 follow-up. BIG: needs a per-canvas store factory (singleton `contexts`/`dimensions`/`parameters`/`canvasCompose` → `canvasId`-keyed instances), a Rule-12 sweep of every consumer, its own budget + MANDATORY adversarial review. Its own multi-file phase; owner may sequence anytime. Relates to 090.

## Patterns (established this build — reuse)

- **Derived positions only.** Node `{x,y}` = `computeLaneLayout(tier, sort, measured-height)`; width never feeds the x-stride. Constrained drag pins x + calls the store reorder (sort/rank), never persists `{x,y}`.
- **Cross-tree shared state → a Zustand store** (RF nodes can't share React state): `canvasCompose`, `canvasSatellites`, `canvasCoverage`, `canvasMode`. **These are SINGLETONS today — 100 makes them per-canvas.**
- **Zoom inside a node body:** RF `useStore((s) => s.transform[2] < THRESHOLD)` — a BOOLEAN selector (re-renders only on threshold crossing), never through the reconcile hot path.
- **A zoom-LOD swap of an editable surface must be EDIT-AWARE** — track focus in a **ref** (state re-renders mid-click and cancels click-to-edit). DOM `.contains()` is unreliable vs PORTALLED popovers (Radix) — prefer a store flag / `:focus-within` / width-cap.
- **Focus-driven behavior on the canvas is KEYBOARD-ONLY (101).** Native `scrollIntoView` no-ops on a transformed plane, so a keyboard focus onto an off-screen cell needs an explicit pan — but a click focuses something already visible, so it must NOT pan. Gate via a **persistent input-modality ref** (`onPointerDownCapture`→pointer / `onKeyDownCapture`→keyboard), NOT a rAF timer (which misclassifies touch, whose tap→focus can span >1 frame, and races rAF-deferred `.focus()` calls) and NOT `:focus-visible` (text inputs are focus-visible on click).
- **Pure decision logic → a unit-tested helper, not a flaky e2e** (P6): `focusPanTarget` (pan decision) + `canvasCapable` (gate) are pure + unit-tested; the flaky animation/timing stays in RF.
- **Capability gate (P7):** clone the jsdom-safe matchMedia pattern (`laneTarget.ts:42`); `matchMedia` absent → false. Seed once at boot, never on resize (documented tradeoff).
- **e2e canvas vs fallback:** `d3-canvas.spec.ts` (`@dev-flag`, `?d3rf`) tests the canvas; everything else pins `WorkspaceSurface` via `forceWorkspaceSurface(page)`. `reducedMotion:'reduce'` + `waitForStableViewport` + geometry `expect.poll` is the canvas e2e de-flake template. To force an element into the pan-margin band deterministically (e.g. the 101 tests), pan the empty pane by a MEASURED delta with relative offsets — never zoom (overshoots off-screen; native scroll can't reach a transformed plane) and never magic px (use `boxOf` + margin-relative landings).

## Non-negotiables & tooling

- **Deploy = push to `main`** → CI `verify` (typecheck + lint + stylelint + vitest + full Playwright e2e incl. canvas specs, `retries:2` in CI) → `deploy.yml` via `workflow_run`. Watch with `gh run list --json` (`gh run watch` is flaky). **Rollback if canvas specs flake: re-add `--grep-invert @dev-flag` to `package.json` `e2e`.**
- **`git push` conflicts with the husky pre-push hook if a local e2e loop runs** (the loop's `pkill vite` kills the hook's server) → push `--no-verify` after verifying yourself.
- **STALE-VITE:** `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before every e2e re-run.
- **eslint gotchas** (both bit this build): the repo forbids non-null assertions (`@typescript-eslint/no-non-null-assertion` — use a null-checking helper like `boxOf`) and requires `interface` over `type` for object shapes. Run `npx eslint <files>` (not just `tail`) — a green tail can hide errors.
- **Bundle budget (PROD-FOLD inverted at P7):** after any lazy-import/chunk change, prod-build + grep that `xyflow` stays OUT of the main `index-*.js` (it lives in `WorkspaceCanvas-*.js`).
- **TEST EVERY route on the canvas** (`/foundation`, `/architecture`, `/design` + navigate) — watch for "Maximum update depth" tier-route bugs. **`routes.ts` grammar is intact (P7 retained it as deep-links).**
- **≤3 concurrent subagents**; commit `--no-verify` after running verify yourself + explicit `git add`; worktree-isolate overlapping subagents.
- **Adversarially review** every hot-path/store/write-path change — MANDATORY for 100's store-factory refactor. **The owner values adversarial validation of the DESIGN before implementing** (the 101 fix's rAF-timer first-cut was caught + rejected pre-implementation this way). **Screenshot** user-facing changes. **Schema only via migrations** (089 was frontend-only).
- **Live creds** (owner provides at launch — never commit): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD='<from owner>'`; rotate after. ⚠️ prior password is in public git history — compromised. The account-free local app is verifiable without creds (P7 + 101 were smoked that way — a throwaway `@playwright/test` script hitting the CloudFront URL, run from the repo dir so `node_modules` resolves); a server WRITE-path smoke needs the password → **CloudWatch** (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) is the authoritative write check.

## Definition of done / next

089 is DONE (graduated + live-verified + archived to `docs/issues/done/`). Open backlog = `099` (remainder: 2b/2c fixes + hover-mute/empty-state coverage + touch/tablet) + `100`. Per the standing directive: build the backlog autonomously (all 089/093 forks are answered), OR surface a genuinely NEW owner-fork via `AskUserQuestion` — `100` (the store-factory refactor) is large enough to be worth confirming sequencing/scope with the owner before starting. Re-triage `docs/issues/README.md` toward open-issue count 0.

---

*History (shipped + archived to `docs/issues/done/`): 084 grid unification; 087/088/090/091/092/094/095/096/097/098; 089 (D1/D2/D3-graduation) + 093. SHIPPED but not yet archived: 101 (click-no-pan), 099 (partial: 099a/b + 2b). This HANDOFF was updated 2026-07-20 after the 101 fix + the 099-2b coverage-matrix a11y fix.*
