# 088: a genuine "Sync error" still surfaces for ~5s on fresh-project load

- **Status**: OPEN
- **Milestone**: M8 (sync read-path / shape delivery). Likely infra/timing, not pure client.
- **Related**: **086** (which correctly *ignores* the boot-race and *debounces* — this is the residual genuine error 086 honestly surfaces, NOT a 086 regression) · the LIVE-VERIFY sync anomaly triaged earlier (0 dims + "Sync error" on reload) is very likely the same root cause.

## Symptom (live smoke on `index-CM_ZSx3K.js`, 2026-07-16)

On a fresh sign-in + fresh project, the footer sequence was: `Syncing…` (t+3s → t+13s, through the expected boot-race 401s — 086 correctly kept it calm), then **`Sync error` (t+13.7s → ~t+16s)**, then recovered to `Synced` (stable through the editing phase). So 086's debounce means the error that showed was **genuinely sustained > the 5s grace** (`errorSince` ~t+8.7s) — i.e. a real read-path/shape failure lasting ~5–7s during initial shape establishment for a fresh project, not a transient blip. It self-heals; data + editing work.

Evidence: `scratchpad/live-verify-085-086/stdout.log` (the footer sample sequence + the boot-race 401s), screenshots `01`/`09`/`16`.

## Hypothesis

Same class as issue 076/078 + the earlier LIVE-VERIFY anomaly: Electric **shape establishment/churn** on a fresh session — the 0016 `ALTER TABLE tier1_purpose` DDL makes Electric terminate+rebuild that shape, and a client hitting the rebuild window (or an empty-shape 409 / "shape handle" gap) gets a sustained error for a few seconds before the shape settles. Needs the network capture at t+8–16s (the `/sync/v1/shape` responses in that window — 409? 5xx? shape-handle churn?) to confirm which stream and why.

## Next steps (investigation-first)
- Reproduce with full network instrumentation (like `scratchpad/live-sync-error/run.mjs`), capturing every `/sync/v1/shape` response + body during t+3–20s of a fresh-project load; identify the failing stream + status/body.
- Correlate with Electric SyncContainer + ShapeProxy CloudWatch logs at that timestamp (use `AWS_PROFILE=phani-quadnomics`).
- Decide the fix: shape-recovery hardening (076-class), a longer/adaptive grace for fresh-project first-sync, or an Electric/CDN config change. Do NOT just widen 086's grace to paper over a real delivery failure.

## References
`docs/issues/086-sync-status-miscalibration.md`, `done/076-shapeproxy-lambda-timeout-severs-electric-longpoll.md`, `done/078-electric-serves-stale-empty-shapes.md` · `scratchpad/live-verify-085-086/` + `scratchpad/live-sync-error/` (instrumented harness).
