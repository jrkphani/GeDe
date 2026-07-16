# 088: a genuine "Sync error" still surfaces for ~5s on fresh-project load

- **Status**: OPEN — **partial fix deployed (`69562d6`), live-verify FAILED.** The drain-first in-flight-aware orphan-surfacing (below) shipped (build `index-BCxScN9e.js`) and *helped* (fresh sign-in now self-heals to `Synced` at ~t+28s instead of never), but the "Sync error" banner **still shows for ~14s** on the heavy test account, and a reload did not recover in-window. **Keep the fix deployed** (correct improvement, `SCENARIO E` green, no regression) but 088 is NOT closed. See "Live-verify result" below.

## Live-verify result (2026-07-16, build `index-BCxScN9e.js`) — FAILED
- **Fresh sign-in**: `Syncing…` → **`Sync error` t+13.9s–28.2s (~14s)** → `Synced` t+28.6s. **No non-401 shape failures** during the error window → purely client-side.
- **Reload**: `Sync error` from t+7.3s, **not recovered** in the 15s window; preceded by **4 genuine `502`s** on `/sync/v1/shape` (dimensions/contexts/parameters) ~t+4–6s — a *separate* 076-class backend hiccup worth its own look.
- **Server data is CLEAN** (debug API, whole DB): `parameters→dimensions`, `bindings→dimensions/parameters/contexts` dangling-FK counts are all **0**. So this is a genuine **false orphan** (the parent exists on the server and eventually resolves), NOT dirty data.
- **Conclusion**: `maybeSurfaceOrphaned` still fires a false orphan at scale — "all shapes up-to-date + one no-progress drain" is not a reliable orphan signal on a large/slow account where the resolving parent apply lands in a later round (recovery at t+28s proves the parent WAS coming). The `SCENARIO E` unit repro doesn't capture the live timing/volume.
- **Next (needs instrumentation, not another blind fix)**: a temporary client-side hook to capture, at the moment of surfacing, WHICH table/rows are in the retry buffer and WHY the drain didn't converge (is a resolvable child being dropped by a whole-batch rollback — 077-class — when the buffer also holds an unrelated blocked row? or is the parent genuinely un-applied at that instant?). Reproduce on the heavy account with that hook. Then decide: keep buffered forward-FK rows retrying across more up-to-date rounds before ever declaring orphan, and/or drain resolvable rows independently of blocked ones. Also correlate the reload `502`s (ShapeProxy/Electric, 076-class).
- **Milestone**: M8 (sync read-path / shape delivery). Likely infra/timing, not pure client.
- **Related**: **086** (which correctly *ignores* the boot-race and *debounces* — this is the residual genuine error 086 honestly surfaces, NOT a 086 regression) · the LIVE-VERIFY sync anomaly triaged earlier (0 dims + "Sync error" on reload) is very likely the same root cause.

## Symptom (live smoke on `index-CM_ZSx3K.js`, 2026-07-16)

On a fresh sign-in + fresh project, the footer sequence was: `Syncing…` (t+3s → t+13s, through the expected boot-race 401s — 086 correctly kept it calm), then **`Sync error` (t+13.7s → ~t+16s)**, then recovered to `Synced` (stable through the editing phase). So 086's debounce means the error that showed was **genuinely sustained > the 5s grace** (`errorSince` ~t+8.7s) — i.e. a real read-path/shape failure lasting ~5–7s during initial shape establishment for a fresh project, not a transient blip. It self-heals; data + editing work.

Evidence: `scratchpad/live-verify-085-086/stdout.log` (the footer sample sequence + the boot-race 401s), screenshots `01`/`09`/`16`.

## Root cause — VERIFIED (network capture 2026-07-16 + code, `scratchpad/live-088-capture/`)

**NOT a server/shape/CDN issue — a client-side cross-table FK apply-order race (075A/077 class).** The instrumented capture showed **every `/sync/v1/shape` request was a healthy 200 or the expected boot-race 401 `missing_token`** — no 409, no 5xx, no shape-handle churn, no CDN header strip; `tier1_purpose` behaved identically to all 10 other tables (this **refutes** the 0016-DDL/shape-churn hypothesis). The only client paths that set `hasError` are a `toRowDeltas`/`applyInboundDeltas` throw or the synthetic **`maybeSurfaceOrphaned`** error (`src/sync/syncEngine.ts:201-211`): when all 11 streams report `up-to-date` with the retry buffer still non-empty, buffered rows are declared orphaned and surfaced — **with no further retry** (matches the observed non-recovery).

Why the buffer is still non-empty: **`DEFERRED_FK_COLUMN` (`src/db/sync.ts:46-51`) covers `contexts.parentId`, `tier2_entries.parentId`, `parameters.parentParamId`, `dimensions.sourceParamId/contextId` — but NOT `parameters.dimensionId`, and `bindings` is absent entirely** (its `dimensionId`/`parameterId`/`contextId` FKs undeferred). Those forward-FK child rows rely solely on the retry-drain (`RETRY_APPLY_ORDER`, parent-before-child) to converge. **077 closed only the `dimensions.contextId` case; this one is still open.** Under data volume the concurrent 11-stream apply loses the ordering race often enough that the drain doesn't converge before every table hits `up-to-date` → orphaned → banner.

**Data-volume amplifier:** the test account (`jrkphani@gmail.com`) has ~12+ accumulated junk projects (`LIVE-085-086`, `LIVE-SYNC-ERROR-REPRO`, `SmokeTest-*`×6, `E2E078-*`×2, …) from repeated smoke runs. The large dataset makes the PGlite apply/retry cycle slow enough that the race is lost and does **not** self-heal (this run stayed in `Sync error` past 24s + a reload — worse than the 085/086 baseline's ~5-7s recovery). A cleaner/smaller account may recover within 086's 5s grace and never show the banner.

## The fix (a real 075A/077-class cycle — do NOT just widen 086's grace)
- **Defer the missing forward FKs**: add `parameters: [...'dimensionId']` and a `bindings: ['dimensionId','parameterId','contextId']` entry to `DEFERRED_FK_COLUMN` so those rows insert with NULL FKs and reconcile, instead of relying on the drain to win the race — the same pattern 072/079 used. Confirm the columns are nullable / reconciled and that `bindings`' composite identity survives.
- AND/OR harden the drain/orphan logic so a genuinely-buffered forward-FK row keeps retrying rather than being declared orphaned at first all-`up-to-date`.
- **Repro harness already exists**: `src/sync/materialization.integration.test.ts` (real PGlite) — add a red test where a `parameters`/`bindings` row streams before its parent and the buffer is non-empty at up-to-date; watch it surface-orphaned, then go green with the fix.
- Secondary: the ~12+ junk test projects on the account amplify this — but they can't be cheaply cleaned (soft-delete still syncs; hard-delete needs RDS write access the debug API lacks). Not the fix, just an amplifier to note.

CloudWatch correlation is now LOW value — the capture already proved the server responses were healthy; the failure is entirely client-side.

## References
`docs/issues/086-sync-status-miscalibration.md`, `done/076-shapeproxy-lambda-timeout-severs-electric-longpoll.md`, `done/078-electric-serves-stale-empty-shapes.md` · `scratchpad/live-verify-085-086/` + `scratchpad/live-sync-error/` (instrumented harness).
