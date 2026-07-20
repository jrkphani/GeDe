# NEXT ORCHESTRATOR — launch prompt: post-089 backlog (099 + 100), fresh session

> **089 D3-canvas graduation is COMPLETE + LIVE** (the canvas is the prod default; P0–P7 + 093 shipped, live-verified on CloudFront). Nothing is mid-flight. Two non-blocking follow-ups remain. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). 089 has graduated — the React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, the established PATTERNS, non-negotiables) and `docs/issues/README.md` (the backlog index). The authoritative 089 record is `docs/issues/done/089-unified-canvas-workspace.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`), and run live-smokes with the throwaway creds passed at launch (`GEDE_PASSWORD=<from owner>`, `GEDE_EMAIL='jrkphani@gmail.com'`; rotate after; never commit — the account-free local app is verifiable without creds).

## The backlog (both filed, both NON-blocking)

- **`099` (`docs/issues/099-canvas-default-coverage-and-a11y-followups.md`)** — small, independent canvas-default coverage + a11y follow-ups from the P7 review: canvas-side e2e for hover-mute / label-tier / empty-state (currently only on the WorkspaceSurface fallback); investigate the label-tier-vs-RF-transform hypothesis (likely a non-issue); a11y beyond the P7 axe smoke; touch/tablet verification; harden the cross-node-Tab spec (flakes under full-suite load, CI-retry-mitigated). Do these as small red-first increments; each ships independently.
- **`100` (`docs/issues/100-canvas-live-child-core.md`)** — the tracked P3 follow-up: promote the recursion satellite STUB → a live child {register+ring} core editable in place. **BIG** — needs a per-canvas store factory (singleton `contexts`/`dimensions`/`parameters`/`canvasCompose` → `canvasId`-keyed instances), a Rule-12 sweep of every consumer, its own budget + MANDATORY adversarial review. Its own multi-file phase; relates to 090. **Worth confirming scope/sequencing with the owner (`AskUserQuestion`) before starting** — it's a central refactor, not a quick fix.

## Workflow (per issue)
**INVESTIGATE** (read-only `Explore` → verbatim file:line map) → **RED-FIRST** (a failing unit/e2e for the gate) → **IMPLEMENT** (`fork` for a big multi-file build; else inline) → **ADVERSARIALLY REVIEW** (`code-reviewer`; MANDATORY for 100's store refactor + any hot-path/store/write-path touch) → **VERIFY yourself** (`npm run verify:fast` + full `npm run e2e` + test every route on the canvas + screenshot) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push (`--no-verify` if a local e2e loop runs) → confirm CI `verify` green + `deploy`.

## Non-negotiables (full list in the HANDOFF)
- **Deploy = push to `main`;** watch CI with `gh run list --json` poll loops. **Rollback if a canvas spec flakes: re-add `--grep-invert @dev-flag` to `package.json` `e2e`.**
- **STALE-VITE:** `pkill -f "@playwright/test/cli.js test-server"; pkill -f vite; lsof -ti:5173 | xargs -r kill -9` before every e2e re-run.
- **Bundle budget:** prod-build + grep `xyflow` stays OUT of the main `index-*.js` (it lives in `WorkspaceCanvas-*.js`) after any chunk/lazy-import change.
- **e2e:** `d3-canvas.spec.ts` (`@dev-flag`, `?d3rf`) = canvas suite; everything else pins `WorkspaceSurface` via `forceWorkspaceSurface`. Keep `routes.ts` grammar intact.
- **≤3 concurrent subagents;** worktree-isolate overlapping ones; never two editing the same file on `main`.
- **Adversarially review** MANDATORY for 100. **Screenshot** user-facing changes. **Schema only via migrations.** CloudWatch (`…WriteApiFunction…`, profile `phani-quadnomics`, read-only) is the authoritative write-path live check.

## Definition of done
Ship `099` (as small increments) and `100` (as its own reviewed phase) — or surface a genuinely NEW owner-fork via `AskUserQuestion`. Re-triage `docs/issues/README.md` toward open-issue count 0. Leave a compressed HANDOFF update.
