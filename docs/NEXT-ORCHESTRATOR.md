# NEXT ORCHESTRATOR — launch prompt: post-polish backlog (099 remainder · 100 planned · 104 polish)

> **089 D3-canvas graduation is COMPLETE + LIVE** (canvas is the prod default). This session cleared a user-reported polish stream: `099-2b/2c`, `101`, `102`, `103`, `104` all shipped; `100` (live child core) is SCOPED + PLANNED (build deferred, owner decisions recorded). Nothing is mid-flight. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `6d5aa3e`, the established PATTERNS incl. the new EDITING-GRAMMAR ones, non-negotiables) and `docs/issues/README.md` (the backlog index).

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`), and run live-smokes with the throwaway creds passed at launch (`GEDE_PASSWORD=<from owner>`, `GEDE_EMAIL='jrkphani@gmail.com'`; rotate after; never commit — the account-free local app is verifiable without creds).

## The backlog

- **`100` (`docs/issues/100-canvas-live-child-core.md`) — SCOPED + PLANNED; owner may say "start 100 phase A".** Promote the recursion satellite STUB → a live child {register+ring} core editable in place. **Reframed by investigation: this is a CLIENT store-lifetime refactor (~13 src files), NOT a data-model one — 090 already made the backend fully canvas-parametric.** Seam = a `createCanvasStores(canvasId)` **factory + registry** (NOT React Context — 210 `getState()` calls happen outside React) + a **default-instance shim** so migration is phaseable with zero behavior change. `parameters` stays global (dimension-keyed, collision-free); `canvasCompose` is tiny. **Owner-decided: active core = FOCUS-FOLLOWS; undo = ONE GLOBAL history.** 5-phase plan (A factory → B thread `canvasId` → C active-canvas gating → D satellite-goes-live → E incidentals) is IN THE ISSUE — follow it. One hazard: per-store `syncUnsubscribe` must become per-instance. **MANDATORY adversarial review on Phase A + any store touch.** Phase A is self-contained (zero behavior change) — a good first increment; stop for owner review before Phase B.
- **`099` (`docs/issues/099-...md`) — coverage remainder only** (both FOUND bugs 2b/2c shipped). Left: canvas-side e2e for **hover-mute** + **empty-state suppression** (fallback-only today); **touch/tablet** verification of pan/zoom + node-drag (more meaningful now 2c made the hit target zoom-correct). Small, independent, red-first each.
- **`104` (`docs/issues/104-...md`) — LOW polish remainder** (core shipped). Clicking EMPTY space leaves the add-child phantom lingering until Esc/cell-click — consider an outside-pointerdown dismiss. Plus 4 edge tests: Escape-dismiss-with-`dismissOnBlur=false`, plain-text-cell-while-armed dismisses+edits, Shift+Tab lands the first cell, empty-space-leaves-armed.

*(101/102/103 are SHIPPED + archived — do NOT re-open. 102's fix and 104's `beginEditing` seam are load-bearing: `RichTextCell` KEEPS `editing` on blur on purpose for the FormatStrip — do not "fix" that.)*

## Workflow (per issue / phase)
**INVESTIGATE** (read-only `Explore`/subagent → verbatim file:line map) → **RED-FIRST** (a failing unit/e2e for the gate) → **IMPLEMENT** (a `general-purpose` subagent for a big multi-file phase; else inline) → **ADVERSARIALLY REVIEW** — validate the DESIGN before implementing AND the DIFF after; `code-reviewer` on the diff is MANDATORY for 100's store refactor + any hot-path/store/write-path touch → **VERIFY yourself** (`npm run verify:fast` + full `npm run e2e` + test every route on the canvas + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI `verify` green + `deploy`.

**Subagents must NOT commit/push/add** — they edit + verify + report; YOU review the diff, re-verify, and commit. (One subagent pushed to main unauthorized this session — docs-only, benign, but keep the gate.) Sequence anything sharing `EditableGrid.tsx`/`base.css`; never run two e2e suites at once (port 5173).

## Non-negotiables (full list in the HANDOFF)
- **Deploy = push to `main`;** watch CI with `gh run list --json` poll loops (`until … completed`). **Rollback if a canvas spec flakes: re-add `--grep-invert @dev-flag` to `package.json` `e2e`.**
- **STALE-VITE:** `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before every e2e re-run.
- **eslint:** repo forbids non-null assertions (`!`) and requires `interface` over `type`. Run `npx eslint <files>` fully (one tolerated pre-existing warning in `EditableGrid.tsx`; 0 errors is the bar).
- **Bundle budget:** prod-build + grep `xyflow` stays OUT of the main `index-*.js` after any chunk/lazy-import change.
- **e2e:** `d3-canvas.spec.ts` (`@dev-flag`, `?d3rf`) = canvas suite; everything else pins `WorkspaceSurface` via `forceWorkspaceSurface`. Keep `routes.ts` grammar intact.
- **≤3 concurrent subagents;** worktree-isolate overlapping ones; never two editing the same file on `main`.
- **Adversarially review** MANDATORY for 100. **Screenshot** user-facing changes. **Schema only via migrations.** CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) is the authoritative write-path live check.

## Definition of done
Sequence `100` (its own reviewed phases, on owner go) and/or ship the `099` remainder + `104` polish (small increments) — or surface a genuinely NEW owner-fork via `AskUserQuestion`. Re-triage `docs/issues/README.md` toward open-issue count 0. Leave a compressed HANDOFF update.
