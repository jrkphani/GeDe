# HANDOFF — 2026-07-17 (090 SHIPPED — canvas is a first-class entity, migration 0017 live on prod · 084 redo SHIPPED · switcher UI deploy in flight · pending owner live-smoke)

For the next agent. Read this → `docs/issues/README.md` → the relevant issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public, `main`). Live at **https://d1nzod71m3rz6x.cloudfront.net** (AWS `975049998516`, `us-east-1`). **Deploy = push to `main`** → CI `verify.yml` (typecheck + lint + stylelint + vitest + **Playwright e2e**) → `deploy.yml` runs `cdk deploy --all -c debugApi=true`.

**Current live build**: the **084 redo** shipped in the first push (bundle **`index-_QzYXMT1.js`**); the **090 switcher UI** deploy was **in flight** as of this writing (bundle was flipping off `_QzYXMT1`). **Confirm the latest hash** at `https://d1nzod71m3rz6x.cloudfront.net` before assuming what's live — do not infer.

## What shipped this cycle

**090 — SHIPPED. Canvas is now a first-class entity.** A design canvas is a real `canvases` row (was an implicit `(project_id, context_id/parent_id)` composite key), so a project holds **N root canvases** with independent dimensions/contexts/bindings, switchable in the Design context bar. Phases 1-4 merged to `main` and pushed.
- **Migration `0017_canvases.sql` applied cleanly to prod RDS** — verified via CloudWatch: the migration-runner logged `applied 1 (0017_canvases.sql); skipped 17`, the `Gede-Test-Migrations` custom-resource stack went `UPDATE_COMPLETE`, and the API stayed healthy with **no `42501`** (the GRANT correction landed — see below).
- **`verify:fast` green (1379 tests)** + **full e2e green (51)**.
- Four corrections the original plan missed, now documented in `docs/issues/090-multiple-design-canvases.md` → `## What shipped`: (1) the **missing `GRANT … ON canvases TO app_user`** (without it the server role is `42501`-denied and cloud project creation breaks); (2) **`FORMAT_VERSION` 4→5 + `upgradeV4ToV5`** (a legacy v4 export was unparseable once `canvasId` joined the row schemas — the shim synthesizes the canvas layer at import); (3) the **phase-4a read-path repoint** of `canvasScope`/`contextCanvasScope` from `context_id IS NULL` to explicit `canvas_id` (the load-bearing correctness change — without it two root canvases leak into each other); (4) a **`canvasId` arg on dimension reorder/remove/restore** (phase 4c step 0) so those ops are canvas-correct on a non-default root canvas.
- SPEC updated: canvas is a first-class entity, the "one root canvas per project" invariant is dropped, `context_id`/`parent_id` marked transitional (dropped in 0018+).

**084 — redo SHIPPED** (the flawed row-actions layout is gone). Deployed in the same first push (bundle `_QzYXMT1`); its full e2e is **green** — this **closes the old HANDOFF item ①** (the badge/accessible-name e2e regression is resolved and live). Architecture route now shows **Name + Description only**; Add child is a hover-revealed trailing gutter, Remove lives in the selection bar.
- **084 stays PARTIAL for its OWN later scope** (unchanged): Phase 2 cross-table keyboard Tab-chain, grid unification (D3), and finding 8 (listbox selection a11y) remain open with unchecked acceptance criteria. Do **not** archive 084.

**089-D1 — SHIPPED + deploying (global rich-text toolbar).** The vision's second half landed independently of the canvas merge. Commits `feat(089-D1)` phases 1-5 + `fix(089-D1)` P6 (latest `ded2ff4`), pushed to `main`; **deploying now** (bundle was flipping off `BDPZ_8NE` as this was written — **confirm the latest hash** before assuming what's live). **Frontend-only + a value-gated heal-on-load — NO schema migration.** **`verify:fast` 1424 tests + full e2e 51/0.**
- **What landed** (terse): a global `FormatStrip` (`src/components/FormatStrip.tsx`) in the context bar, bound to the focused rich editor via a focused-editor registry (`src/store/focusedEditor.ts`), focus-reveal (no always-on chrome). **Every prose field is now rich** — `tier1_purpose.body` (Purpose now a standalone `RichTextEditor`), `tier1_props.description`, `tier2_entries.description`, and `contexts.justification` (new `richtext` `EditableGrid` cell kind with a Cmd+Enter=commit-down / Esc=revert / Tab-stays-out escape grammar). Plain↔Lexical bridge in `src/domain/richText.ts`; repaired search/status consumers of justification. The heal (`src/store/richTextConvert.ts`, wired in `DesignSurface`) converts legacy plain strings to Lexical JSON on project open, bypasses the command log, is idempotent, and **re-heals cells an un-upgraded peer clobbers back** (LWW is value-blind).
- **Remaining 089 work**: **rich identifier columns** (`*.name` / `contexts.symbol`) — deferred, **owner decision pending** (they feed the duplicate-detection tuple hash and `InlineEdit` callers lack `readOnly` threading; keep plain OR a single-line-rich variant); **D2** lane page; **D3** zoom canvas — **gated behind a spike** that must also **reconcile the canvas-substrate contradiction** in the issue doc (the owner Decision picks React Flow, but the appended library research §5 recommends rejecting it for a CSS-transform plane + `@panzoom/panzoom`).

## The only thing left: owner live-smoke (closes 090 + the still-open 088 live-verify)

Everything above is code-complete, tested, and (for 0017) live-verified at the migration level. What remains is an **owner-run signed-in smoke** on the heavy account — the classifier blocks the agent from the secret-plaintext read and the owner's plaintext password, so these are owner-run or owner-authorized.

**(a) Debug-API DB checks** (049 SELECT-only API over the ALB). Get the token, then query:
```
TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id arn:aws:secretsmanager:us-east-1:975049998516:secret:DebugTokenSecret0E11C939-uC7geGa8eYXb-uCCrkF \
  --query SecretString --output text --region us-east-1 --profile phani-quadnomics)
ALB=Gede-T-Alb16-7PG12HghU4Wa-1482490479.us-east-1.elb.amazonaws.com
curl -H "x-debug-token: $TOKEN" http://$ALB/debug/db/counts
```
Confirm via `POST /debug/db/query {"sql":"…"}`:
- `SELECT count(*) FROM canvases` is non-zero and matches (one root canvas per project + one child per distinct child context).
- **Backfill is lossless**: `SELECT count(*) FROM dimensions WHERE canvas_id IS NULL` **= 0** and same for `contexts` (no stranded rows).
- The **`app_user` GRANT on `canvases` exists** (`SELECT * FROM information_schema.role_table_grants WHERE table_name='canvases' AND grantee='app_user'`) — this is the correction #1 that would have `42501`'d cloud writes.
- (Token is in Secrets Manager; the read is classifier-gated → owner-run.)

**(b) Signed-in UI smoke** on the heavy account (`jrkphani@gmail.com`, ~12+ junk projects = built-in stress). Confirm:
- The **canvas switcher works**: create a second root canvas, switch between them, delete one and **Undo** it; the two canvases show **independent** dimension/context sets (no leakage — proves the phase-4a repoint).
- The **084 Architecture layout** is correct: **Name + Description only** (Add child in the hover gutter, Remove in the selection bar).
- The **088 "Sync error" banner is gone** (self-heals silently to `Synced`) — this is the still-open **088** live-verify. If gone → archive 088 to `done/`. If it persists → candidate (B), run the 078 instrumentation playbook.
- **How**: the scratchpad live-smoke pattern — a standalone Playwright `.mjs` in `scratchpad/*/run.mjs` driving the live URL, signing in via `#hero-email`/`#hero-password` (those scripts hardcode the owner's plaintext password → gitignored, owner-run). `window.__gede` introspection is removed — verify via UI/DOM only.

If both pass, **archive 090 and 088 to `done/`** (per the 088-style flow — the owner archives after live-smoke; don't pre-move).

## Still open / next steps (priority order)

- **① Owner live-smoke** (above) — closes 090 and 088.
- **② 089 — unified canvas workspace** (`docs/issues/089-unified-canvas-workspace.md`): **D1 (global rich-text toolbar) is SHIPPED** (see What shipped this cycle). Remaining: **(a) rich identifier columns** — deferred, **owner decision pending** (tuple-hash + `InlineEdit` `readOnly` hazards); **(b) D2** single scrollable lane page; **(c) D3** pan/zoom canvas — **gated behind a spike** that must first **reconcile the React-Flow-vs-CSS-transform substrate contradiction** (owner Decision picks React Flow; appended §5 research rejects it for a CSS-transform plane + `@panzoom/panzoom`). Canvas work is unblocked by 090 (canvas is a real entity; 089 renders N canvases as N clusters) but must not start until that substrate call is made.
- **③ 087 — surface silent write failures**: OPEN, not started (the write-side complement of 086).
- **④ 0018+ cleanup migration**: drop `dimensions.context_id` / `contexts.parent_id` and repoint the server dimension-floor query (`countLiveDimensions`, `src/server/writeApi/store.ts:442-449`) off `context_id` onto `canvas_id` (090 Open Question 5). The read path is already on `canvas_id`; these columns are transitional.
- **076-class backend 502s** on `/sync/v1/shape`: distinct ShapeProxy/Electric hiccup seen during prior verify reloads; own look (CloudWatch the ShapeProxy/SyncContainer).
- **RLS no-op in prod** (`gede_admin` owner; 080's `/accept` is the sole authz boundary), **CDK-synth `/tmp` leak**, and **test-data clutter** on the heavy account — all still standing.
- **Housekeeping — stale worktrees (~3.1 GB)** under `.claude/worktrees/agent-*` from prior crashes: **4 clean** (safe to `git worktree remove`), **2 with 1 unmerged commit each** (inspect before removing), **1 dirty** (has uncommitted changes — do not remove blind). Check each for unpushed work first.

## Non-negotiables (how to work)
1. **TDD, red first.** 2. **Deploy = push to `main`** — CI is the only path, and **CI `verify` includes Playwright e2e that local `verify:fast` does NOT run**, so a UI change can pass locally and fail CI (exactly what happened with the 084 badge). Run the affected e2e (or the full suite) locally before pushing a UI change. 3. **Schema only via migrations** (latest **`0017`**; next **`0018`**; adding one bumps `deploy/cdk/test/migration-stack.test.ts:85` count 18→19 + the `.snap`; Electric-synced tables need `REPLICA IDENTITY FULL` + a `GRANT … TO app_user` + a `syncScope`/`WORKSPACE_SCOPE_SQL` entry + the ~13-registry envelope fan-out — see 090's plan + its `## What shipped`; a new parent FK needs `DEFERRED_FK_COLUMN`/apply-order consideration à la 088/090). 4. **Verify subagent claims against the code** (adversarial review caught the 088 reentrancy gap; the 090 build caught real plan errors — the GRANT, the FORMAT_VERSION bump, the read-path repoint). 5. **Verify LIVE, don't infer** — the whole 088 saga is a fix passing tests + adversarial review yet failing at production scale; and the live build hash was mid-flip as this was written. 6. **Screenshot UI changes before shipping** — the FIRST 084 shipped a layout bug (verbs in a data column) that only a screenshot caught; the redo was screenshot-verified. 7. **Orchestration**: ≤3 subagents concurrent; system memory <75% (`memory_pressure` "free %"); reap stray playwright/chromium; e2e `--workers=1`.

## Tooling
- **AWS profile matters.** App account **`975049998516` = profile `phani-quadnomics`**; the owner's default shell profile is a different personal account, so raw `aws …` fails cross-account — use **`AWS_PROFILE=phani-quadnomics`**. The AWS MCP (`mcp__aws-api__call_aws`) is authenticated to the app account.
- **049 debug API** (SELECT-only over the ALB): token + recipe in the live-smoke section above. **ALB DNS**: `Gede-T-Alb16-7PG12HghU4Wa-1482490479.us-east-1.elb.amazonaws.com`. Secret ARN: `arn:aws:secretsmanager:us-east-1:975049998516:secret:DebugTokenSecret0E11C939-uC7geGa8eYXb-uCCrkF`.
- **CloudWatch** = fastest server debugger: Write Lambda `…WriteApiFunction…`, ShapeProxy `…ShapeProxyFunction…`, Electric `…SyncContainerLogGroup…-iC9rDOPocc3x` (logs `Received relation "public"."<table>"` when a change flows through WAL), migration-runner logs `applied N (…); skipped M` (how 0017 was confirmed live).
- **Live-smoke pattern**: standalone Playwright `.mjs` in `scratchpad/*/run.mjs` drive the live URL, signing in via `#hero-email`/`#hero-password`. **Security note**: those scratchpad scripts hardcode the owner's plaintext password — **gitignored** (`scratchpad/` excluded), plaintext on local disk only. Accounts: A=`jrkphani@gmail.com` (heavy/stress), B=`jrkphani@icloud.com`. `window.__gede` introspection is REMOVED — verify via UI/DOM only. **Local app screenshots**: `npx playwright test <spec>` auto-starts the vite dev server (`playwright.config.ts` webServer, port 5173); a scratch spec that builds data + `locator.screenshot()` is how the 084 redo was visually verified.
- **Classifier** blocks mutating AWS + `git push` + secret-plaintext reads from the agent — hand the user a `!` command for those. `gh run watch` is flaky on this network; a `gh run view --json status` poll loop is more resilient.

## Docs map
`docs/SPEC.md` (canvas now first-class — §2 glossary, §3 data model, §4.6) · `TECH_STACK.md` · `STYLE_GUIDE.md` · `SITEMAP.md` (carries a forward-pointer to 089/090's route changes) · `adr/` · `DEPLOYMENT.md §9` · `docs/issues/` (README = index; `done/` = shipped; **090 SHIPPED-pending-live-smoke**, **088 open (live-verify owed)**, **084/087 open**, **089 proposal — now unblocked**). Knowledge graph in `graphify-out/` (gitignored).
