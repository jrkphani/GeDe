# NEXT ORCHESTRATOR — launch prompt: deploy pipeline UNFROZEN · 7 PRs merged + deployed · OPEN: 099-touch (manual) + 3 infra follow-ups

> **The 2026-08-15/16 run was release engineering, not feature work.** Four agent-authored PRs (`#14`–`#17`) were open and all red; fixing them exposed that **`main` had been red since 2026-07-23 and the deploy pipeline had been silently FROZEN for three weeks** — every `deploy` run showed `skipped` because `verify` never went green on `main`. Three failures were stacked, each masking the next (esbuild bundling → `main`'s rotted CDK tests → the α1 e2e flake). Ended with **7 PRs (`#14`–`#20`) merged and deployed**, the pipeline verified end-to-end (including a migration application), and the live app functionally smoke-tested. Copy the block below as the next orchestrator's launch prompt.

---

You are the ORCHESTRATOR for the GeDe repo (`/Users/jrkphani/Projects/GeDe`). The React Flow canvas is the capability-gated DEFAULT workspace in production. **START by reading `docs/HANDOFF.md`** (current state, HEAD `56ece1b`, the CI/release + e2e + concurrent-PR-merge patterns, the disk + memory caps, non-negotiables) and `docs/issues/README.md`.

You may `git push`, merge, and deploy (push to `main` → CI `verify` → `deploy` via `workflow_run`).

## ⚠️ Two machine caps — BOTH bit this run

- **Disk.** The CDK suite leaks a ~62 MB `cdk.out*` staging dir into `$TMPDIR` per `synth()` and never cleans up; a full `npm test` in `deploy/cdk` leaks **>10 GB**. 276 stale dirs had accumulated and filled the disk mid-session, blocking ALL local verification. **Sweep `rm -rf "$TMPDIR"/cdk.out*` after any CDK run**, or run per-file with a sweep between. (Fixing this properly is an open follow-up.)
- **Memory.** >2 concurrent agents exhausts app memory, and after a long session even a SINGLE local Playwright e2e can OOM (exit 144). Keep to **≤2 subagents, ONE heavy (Playwright/vitest) at a time**; serialize e2e. If local e2e won't run, CI's full-e2e is the authoritative gate (deploy is verify-gated).

## The backlog — 1 product item (manual) + 3 infra follow-ups

- **`099` (`docs/issues/099-...md`) — MANUAL-ONLY, the only OPEN product issue.** Real-device multi-touch pinch-zoom + tactile fidelity. **Nothing an agent can do** — needs a physical tablet.
- **🆕 Consolidate the two asset-hash normalizers.** `deploy/cdk/test/normalize-asset-hashes.ts` already existed (`56055e4`) and is **broader/better** than the `#19` Jest serializer, but had only been wired into `hosting-stack` + `migration-stack`. `#19` added a parallel mechanism instead of applying the existing one to `api-stack`. Pick one — preferably the older helper — and delete the other.
- **🆕 Fix the `cdk.out` `$TMPDIR` leak** (see disk cap above): have `synth()` write to a temp dir it cleans, or add an `afterAll` sweep.
- **🆕 "Syncing…" shows while signed out**, when sync is 401-ing every shape request. Surface "Sign in to sync" or suppress the indicator when unauthenticated.
- **Un-bank the touch specs (now cheap):** `#18` added the `canvas-serial` e2e lane the prior handoff wanted. The 3 `test.fixme` emulated-touch specs could likely move into their own lane now.

*(088/100/101/102/103/104/105/106/107 are SHIPPED + archived — do NOT re-open. Minor tracked non-issues: `107` — `projectIO.ts:34` could import the shared `Tx`; `106` — grandchild breadcrumb depth + WorkspaceCanvas render-path unit harness.)*

## Workflow (per phase)
**INVESTIGATE** (read-only `Explore`/subagent → file:line map) → **RED-FIRST** → **IMPLEMENT** (one `general-purpose` subagent for a multi-file phase; else inline) → **ADVERSARIALLY REVIEW** design then diff (`code-reviewer` MANDATORY for any store/render/write-path touch) → **VERIFY yourself** (`verify:fast` + full `e2e` + screenshot user-facing changes) → **COMMIT** (`--no-verify` after verifying + explicit `git add`) → push → confirm CI green.

**Subagents must NOT commit/push/add.** Keep to the memory + disk caps; serialize e2e.

## If CI is red — read this FIRST
1. **Check whether `main` is red the same way before debugging the PR.** Three weeks of breakage hid here because every PR was already red for an unrelated reason.
2. **`deploy` showing `skipped` on `main` means FROZEN, not idle.** Look for `event=workflow_run` + `conclusion=success` in `gh run list --workflow=deploy.yml`.
3. **Don't trust the "flaky" label.** Reproduce locally at `--workers=1` first — two specs reported flaky this run were real races.
4. **Two e2e lanes now:** `npm run e2e` = `e2e:canvas` (serial, `d3-canvas` + `architecture`) then `e2e:app` (parallel, the other 23 files). Keep heavy new canvas specs in the serial lane.

## Non-negotiables (full list in HANDOFF)
- Deploy = push to `main`; watch `gh pr checks <n> --watch` / `gh run watch <id> --exit-status`.
- eslint 0 errors (tolerated pre-existing warnings in EditableGrid/Canvas/server albAdapters). `xyflow` OUT of main `index-*.js`. **Schema only via migrations.**
- **Never hardcode a count a routine change bumps** (migration counts broke unrelated PRs three times across two files — both are now derived from disk). **Never snapshot build output** (asset hashes make concurrent PRs mutually un-mergeable).
- **Store-factory circular-init invariant** (HANDOFF): hoisted `function` factories + type-only `CanvasStores` import — unlinted. **`storeCanvasId` ≠ `canvasId`; the primary core resolves DEFAULT.**
- **Shared EditableGrid: any new grammar MUST be Architecture-scoped opt-in** (Design/Foundation depend on Enter=commit+down + native richtext Tab). Note `richTextTabAdvances` now also drives which key the edit chips advertise.
- **Merging concurrent agent PRs: expect SEMANTIC conflicts** — take the restructure wholesale, then port the other branch's feature onto the new shape and re-verify. `git checkout --theirs <file>` discards ALL your side's changes to that file, not just the conflicted hunk.

## Definition of done
`#14`–`#20` are all merged + DEPLOYED; `main` = `56ece1b`, clean, 0 open PRs. The three-week deploy freeze is over and the pipeline is verified end-to-end (OIDC → build → `cdk deploy: success`, migration runner `UPDATE_COMPLETE` for `0018`, live app project-create round-trip). No feature work is mid-flight. Actionable backlog is infra-only (3 items above); `099`'s real-device pinch pass is the only open product item and is not automatable. Await direction / new work.
