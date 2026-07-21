# HANDOFF — 2026-07-21 (089 graduated; 099/101/102/103/104 shipped; 100 planned)

**089 D3-canvas graduation is COMPLETE + LIVE. The React Flow canvas is the capability-gated DEFAULT workspace in production.** Since graduation, shipped a stream of user-reported polish: `099` (canvas a11y/coverage — 2b/2c), `101` (click-no-longer-pans), `102` (add-child worked while editing a description), `103` (Foundation value-prop discoverability), `104` (add-child row height + continuous non-blocking keyboard). `100` (live child core) is now **SCOPED + PLANNED** (build deferred, owner decisions recorded). No phase is mid-flight.

Launch prompt for the next session: `docs/NEXT-ORCHESTRATOR.md`. Authoritative 089 record: `docs/issues/done/089-unified-canvas-workspace.md`.

---

## Current state

HEAD: **`6d5aa3e`** (100 build-plan docs). **CI `verify` CONFIRMED GREEN through `e9511f4` (104)**; a `deploy` of `6d5aa3e` (which includes 102/103/104 code) was in-flight at handoff — locally full-verified (vitest 1665, full e2e 90/90), expected green → live. Canvas is the prod default for capable clients (≥ 1024px + not data-saver); `WorkspaceSurface` (D2 stacked lanes) is the `< 1024px` / reduced-data fallback. Live URL: https://d1nzod71m3rz6x.cloudfront.net.

Commits this session (newest last): `bd6a913` (099-2b) · `8fe656c` (099-2c) · `763b691`+`4ee4da3` (099 docs) · `46d17b1` (**102**) · `585f872` (**103**) · `1b5d665` (103 archive) · `b02b2d6` (104 decision) · `e9511f4` (**104**) · `6d5aa3e` (100 plan). A couple of docs commits (`e33993d`, `3054c1c`, `dcd14cc`) interleave. If a future `verify` is red at pickup, first check the cross-node-Tab flake (CI `retries:2` should absorb it) vs a real failure.

### What shipped this session (the user-reported stream)

- **099-2b (`bd6a913`)** — `CoverageMatrix` is a valid ARIA grid on BOTH surfaces: each row's cells wrapped in a `display:contents` `role="row"` + `aria-rowindex`. RED-first axe scans on both hosts + a `CoverageMatrix.test.tsx` structural lock.
- **099-2c (`8fe656c`)** — dot hit target sized in SCREEN space (`Canvas` `scale` prop, default 1; `DesignRingBody` feeds a QUANTIZED RF zoom via `quantizeHitScale`), **and `maxDotHitRadius` made a TRUE all-pairs minimum** (its `if (m >= 2)` scan missed cross-dimension pairs → a ring with all-single-dot dimensions was uncapped → a screen-space radius would overlap → wrong-parameter bind in compose). Two adversarial rounds; round 2 BLOCKED the first cut.
- **101 (`d3c5d84`)** — clicking a canvas element no longer pans; focus-pan is keyboard-only (persistent input-modality ref).
- **102 (`46d17b1`, archived)** — "Add child" did nothing while a rich-text DESCRIPTION cell was mid-edit. Mechanism = **appear-then-vanish**: the description's Lexical editor (which `RichTextCell` deliberately keeps mounted on blur so the out-of-editor FormatStrip works) re-grabbed focus the instant the add-child phantom's autoFocus input mounted, and the phantom's blur-cancel killed it in the same frame. Fix (`EditableGrid`): while the inline add-child row is armed, suppress `editing` SYNCHRONOUSLY during that render (`effectiveEditing = armed ? null : editing`, fed into `nav.editing` + the `onEditingChange` seam) so the editor unmounts before it can refocus; an effect clears `editing`/`pendingFocus`/`pendingPhantomEdit`.
- **103 (`585f872`, archived)** — Foundation value-props read as "separate/unintuitive tables." They were ALREADY one `EditableGrid`; the real problem was discoverability. Added a visible "Purpose" label, a "Value propositions" `<h3>`, an orienting empty-state line, and `showKeyHints`. Enter-append parity DEFERRED (Enter=create-and-stay is the shared `PhantomCell` grammar; diverging Foundation would break consistency — a recorded fork).
- **104 (`e9511f4`)** — the add-child child row (surfaced by 102). (1) Compact description editor: `RichTextCellKind.roomy` default off → descriptions no longer balloon (~40→~88px); only ContextRegister's justification opts into `roomy:true` (keeps the 085 Decision-4 floor). (2) **Continuous, non-blocking** add-child (owner-decided): a `beginEditing` seam makes a NEW edit dismiss the armed phantom (`InlineRowConfig.onDismiss`) instead of being blocked by 102's suppression — "whichever the user did LAST wins" — while 102's arm-while-editing path stays suppressed. (3) Grid-aware Tab from the add-child field (`PhantomInput.onTab`). **LOW remainder (issue 104, still open):** clicking EMPTY space leaves the phantom lingering until Esc/cell-click; + a few edge tests.

## Backlog — `099` (remainder) · `100` (planned) · `104` (LOW polish)

- **`099` — coverage remainder only** (both FOUND bugs shipped). Left: canvas-side e2e for **hover-mute** + **empty-state suppression** (fallback-only today); **touch/tablet** verification of pan/zoom + node-drag (more meaningful now that 2c made the hit target zoom-correct). Small, independent, red-first each.
- **`100` — live child core: SCOPED + PLANNED (`6d5aa3e`), build deferred.** Reframed by investigation: 090 already made the backend fully canvas-parametric, so this is a **CLIENT store-lifetime refactor** (~13 src files), NOT a data-model one. Seam = a `createCanvasStores(canvasId)` **factory + registry** (NOT React Context — 210 `getState()` calls happen outside React) + a **default-instance shim** so migration is phaseable with zero behavior change. `parameters` stays global (dimension-keyed, already collision-free); `canvasCompose` is tiny (2 consumers). **Owner decisions (baked into the plan): active core = FOCUS-FOLLOWS; undo = ONE GLOBAL history.** 5 phases A→E in the issue. One hazard: per-store `syncUnsubscribe` must become per-instance. **To start: "start 100 phase A".**
- **`104` LOW polish** — the empty-space-dismiss wart + the 4 edge tests the review suggested (Escape-dismiss-with-`dismissOnBlur=false`, plain-text-cell-while-armed, Shift+Tab lands first cell, empty-space-leaves-armed).

## Patterns (established this build — reuse)

### Canvas / geometry
- **Derived positions only.** Node `{x,y}` = `computeLaneLayout(tier, sort, measured-height)`; width never feeds the x-stride. Constrained drag pins x + calls the store reorder, never persists `{x,y}`.
- **Zoom inside a node body:** RF `useStore((s) => s.transform[2] < THRESHOLD)` — a BOOLEAN (or QUANTIZED, 099-2c's `quantizeHitScale`) selector: re-renders only on threshold/bucket crossings, never the reconcile hot path.
- **Focus-driven behavior on the canvas is KEYBOARD-ONLY (101).** `scrollIntoView` no-ops on a transformed plane, so keyboard focus onto an off-screen cell needs an explicit pan — but a click focuses something already visible, so it must NOT pan. Gate via a persistent input-modality ref (`onPointerDownCapture`/`onKeyDownCapture`), NOT a rAF timer (misclassifies touch) and NOT `:focus-visible` (text inputs are focus-visible on click).
- **LAYOUT vs SCREEN space is the canvas's sharpest edge (099-2/2c).** `ResizeObserver` `contentRect` is LAYOUT width — invariant under RF `transform: scale()`. The label tier WANTS that (zoom-invariant); a 44px hit target WANTS screen space (`layoutWidth * zoom`). **Ask which space each consumer needs.**
- **An invisible hit target is still a PAINTED one.** `fill: transparent` is hit-tested (SVG `visiblePainted`), so a hit circle also swallows background clicks + drives hover. **Growing a hit target is never free.**
- **A cap only bounds the pairs it ranges over (2c).** `maxDotHitRadius` claimed "global minimum over ALL dots" but its scan skipped `m < 2` dimensions. **When a value is load-bearing for correctness, assert the contract its comment claims** — and prefer a bound that doesn't vary with the thing it bounds.

### Editing grammar / EditableGrid (102/103/104)
- **`RichTextCell` deliberately keeps `nav.editing` on BLUR** (unlike `TextOrMonoCell`) — so clicking the out-of-editor FormatStrip doesn't collapse the cell. **Do NOT "fix" this**; it means a Lexical editor stays mounted + fights for focus. That focus fight is the root of the 102 bug.
- **Mutual exclusion of "a cell is editing" vs "an inline phantom is armed" (102/104).** 102: arming while a cell is mid-edit → suppress the editor synchronously (`effectiveEditing`) so the phantom isn't focus-killed. 104: a NEW edit while armed → DISMISS the phantom (`beginEditing` → `InlineRowConfig.onDismiss`). Rule: **whichever the user did LAST wins.** Route every editor-open through one `beginEditing` seam; keep the arm path OUT of it.
- **An ephemeral phantom's blur-cancel races a click into another cell.** `PhantomInput`'s `onBlur→onCancel` fired on the mousedown of the click-into-a-cell, detaching the target before its `click` landed (dead click). Fix: `dismissOnBlur={false}` + drive dismissal deterministically (via `beginEditing`/`onTab`/Escape). **Tradeoff:** clicking EMPTY space no longer dismisses (104 LOW remainder).
- **Compact vs roomy rich-text cells.** The 72px editor floor (`.grid-cell--richtext .rich-text-editor-root` + a 3-line content floor) is for the register's JUSTIFICATION prose (085 Decision 4). Short descriptions want a one-line auto-grow floor → `RichTextCellKind.roomy` (default OFF = compact; only justification opts in).
- **Discoverability > mechanism (103).** When a user says a surface is "unintuitive / scattered," check for a labeling/empty-state gap before rebuilding grammar. The value props were already one grid; labels + a heading + an empty-state line + `showKeyHints` fixed the complaint. **`showKeyHints` is aria-hidden** — no SR noise.
- **Section-scoped focus helpers, never global DOM reach.** Cross-cell/table focus handoff uses `gridBoundaryFocus`'s `firstEditableCell`/`lastEditablePosition(section)` scoped to `#t2-table-<id>` (finding 7), deferred a frame (rAF) so the leaving row unmounts first.

### Stores
- **Cross-tree shared state → a Zustand store** (RF nodes can't share React state): `canvasCompose`, `canvasSatellites`, `canvasCoverage`, `canvasMode`. **`contexts`/`dimensions`/`canvasCompose` are canvas-scoped SINGLETONS today — 100 makes them per-canvas via a factory.** `parameters` is dimension-keyed (collision-free, stays global).
- **The seam for per-instance stores is a keyed registry, not React Context** (100 scoping) — because `getState()` (undo closures, cross-store wiring, the palette) happens outside React. A default-instance shim keeps migration phaseable.

### Process
- **Pure decision logic → a unit-tested helper, not a flaky e2e** (`focusPanTarget`, `canvasCapable`, `hitRadiusUnits`, `quantizeHitScale`).
- **Adversarially review the DESIGN, then the DIFF.** Both rounds paid off on 2c (a bad design killed pre-impl; a bad deviation blocked post-impl) and 102/104 (the implemented diff review found the `pendingFocus` text-cell path + confirmed 102 preserved). Ask the reviewer to REFUTE and QUANTIFY.
- **Reproduce before fixing; don't ship an unverified hot-path fix.** 102 took two wrong guesses (both documented in the issue so they weren't repeated) before instrumentation found the real appear-then-vanish mechanism. When you've corrected the same thing twice, STOP and get data.

## Non-negotiables & tooling

- **Deploy = push to `main`** → CI `verify` (typecheck + lint + stylelint + vitest + full Playwright e2e incl. canvas specs, `retries:2` in CI) → `deploy.yml` via `workflow_run`. Watch with `gh run list --json` (`gh run watch` is flaky). **Rollback if canvas specs flake: re-add `--grep-invert @dev-flag` to `package.json` `e2e`.**
- **`git push` conflicts with the husky pre-push hook if a local e2e loop runs** → push `--no-verify` after verifying yourself.
- **STALE-VITE:** `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before every e2e re-run. **Never run two e2e suites at once** (port 5173 collision) — sequence, or worktree-isolate.
- **eslint gotchas:** repo forbids non-null assertions (`@typescript-eslint/no-non-null-assertion`) and requires `interface` over `type`. Run `npx eslint <files>` fully. There is ONE tolerated pre-existing warning in `EditableGrid.tsx` (the issue-022 `pendingPhantomEdit` effect deps) — 0 errors is the bar.
- **Bundle budget:** after any lazy-import/chunk change, prod-build + grep `xyflow` stays OUT of the main `index-*.js` (it lives in `WorkspaceCanvas-*.js`).
- **TEST EVERY route on the canvas** (`/foundation`, `/architecture`, `/design` + navigate) — watch for "Maximum update depth". `routes.ts` grammar is intact.
- **≤3 concurrent subagents.** **Subagents must NOT `git commit`/`push`/`add`** — they edit + verify + report; the orchestrator reviews the diff, re-verifies, and commits (`--no-verify` after verifying + explicit `git add`). Worktree-isolate overlapping subagents; sequence anything sharing `EditableGrid.tsx`/`base.css` (a subagent DID push to main unauthorized earlier in the 099 stream — docs-only, benign, but the gate must hold; consider restricting `code-reviewer` to read-only tools).
- **Adversarially review** every hot-path/store/write-path change — MANDATORY for 100's store-factory refactor. **Screenshot** user-facing changes. **Schema only via migrations** (all of 099–104 were frontend-only).
- **Live creds** (owner provides at launch — never commit): `GEDE_EMAIL='jrkphani@gmail.com'`, `GEDE_PASSWORD='<from owner>'`; rotate after. ⚠️ prior password is in public git history — compromised. The account-free local app is verifiable without creds (a throwaway `@playwright/test` script hitting the CloudFront URL, run FROM the repo dir so `node_modules` resolves — a bare `/design` with no project shows "Nothing at this address"; create a project first). A server WRITE-path smoke needs the password → **CloudWatch** (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) is the authoritative write check.

## Definition of done / next

089 is DONE. This session cleared the user-reported polish stream (099-2b/2c, 101, 102, 103, 104). Open backlog = `099` (coverage remainder) · `100` (planned — start with "start 100 phase A") · `104` (LOW polish). Per the standing directive: build the backlog autonomously, OR surface a genuinely NEW owner-fork via `AskUserQuestion`. Re-triage `docs/issues/README.md` toward open-issue count 0. Leave a compressed HANDOFF update.

---

*History (shipped + archived to `docs/issues/done/`): 084 grid unification; 087/088/090/091/092/094/095/096/097/098; 089 (D1/D2/D3-graduation) + 093; 101 (click-no-pan); 102 (add-child while editing); 103 (Foundation VP discoverability). SHIPPED but not yet archived: 099 (partial — 099a/b + 2b + 2c; coverage/touch remainder keeps it OPEN); 104 (core shipped; LOW polish remainder keeps it OPEN). PLANNED not built: 100. Updated 2026-07-21.*
