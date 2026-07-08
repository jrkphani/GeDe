# 051: Enabling sync crashed the signed-in app (read-path Electric on an empty URL)

- **Status**: SHIPPED — fixed in commit `6ffd92f` (`fix(050): don't start the Electric read-path without a configured sync URL`), verified live 2026-07-08 as part of 050's end-to-end write-loop test.
- **Milestone**: M11 (Close the cloud write loop)
- **Found via**: 050's live end-to-end smoke (sign-in → create project → verify in RDS via 049)

## Symptom

After deploying `VITE_SYNC_ENABLED=true` (050), the signed-in app threw repeated `Failed to construct 'URL': Invalid URL` errors and sign-in never completed — no `/write` flush occurred.

## Root cause

`VITE_SYNC_ENABLED` gated **both** the write flush (048, wanted) and the 032 Electric **read-path** engine. With no `VITE_SYNC_URL` configured, the default shape-stream factory built a shape URL from an empty base and threw. The sync Fargate slot is still an nginx stub, so there was nothing to read from anyway — the read-path had no business starting.

## Fix

Shipped in commit `6ffd92f`. `src/store/sync.ts` `start()` now skips the read-path unless a sync URL (`syncBaseUrl()`) or a test `streamFactory` is present:

```ts
if (syncBaseUrl() === '' && !options.streamFactory) return
```

The write flush remains independent, gated only by `isSyncEnabled()` — unaffected by this guard.

## Follow-up

None required. (Possible future refinement: split the read-path vs. write-flush enable flags if they ever need to diverge — not needed today since the read-path naturally no-ops without a configured URL.)

**References**: 050 (workspace provisioning + sync enablement — the change that exposed this), 032 (Electric read-path engine), 048 (client write-queue flush, the independent path this preserves).
