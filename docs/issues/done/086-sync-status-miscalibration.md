# 086: Sync status over-sensitivity — "Sync error" flips on any transient read blip

- **Status**: ✅ SHIPPED — verified live (`index-CM_ZSx3K.js`, 2026-07-16): the boot-race 401 storm no longer flips the banner, and the debounce holds. The residual genuine "Sync error" on fresh-project load (a real sustained shape-delivery failure this fix correctly surfaces after the grace) is split to **088**.
- **Milestone**: M8 (sync-state UI; extends 036). Client-only; no schema, no CDK.
- **Blocked by**: none.
- **Related**: **087** (deferred here by owner decision) — genuine WRITE-outbox failures currently retry silently and never surface in the status; that half of the miscalibration is its own follow-up. This issue fixes only the over-sensitive READ-error banner (the reported symptom).

## User story

As a user editing on the deployed app, I keep seeing a **"Sync error"** banner that clears itself a second later, even though my edits are actually saving. It makes the app feel broken when it isn't — so I distrust it, and I can't tell a real problem from noise. I want the status to stay calm through the normal transient hiccups of a streaming connection, and only say "Sync error" when something is **actually** wrong for more than a moment.

## Root cause (confirmed against code — `src/domain/syncStatus.ts` + `src/store/sync.ts`)

`deriveSyncStatus` (`syncStatus.ts:40-47`) returns `'error'` whenever a single global boolean `hasError` is true (priority just below offline). `hasError` is:
- **Set true ONLY** in the read-path `onError` callback (`sync.ts:303-306`) — which fires for *any* Electric shape-stream error on *any* of the ~10 per-table streams, including (a) the **pre-signin boot-race**: shape requests fire before the Cognito token is attached → `401 {"error":"missing_token"}`; and (b) **normal long-poll churn**: a live stream's connection aborts/reconnects (`net::ERR_ABORTED` / socket closed), which Electric retries on its own.
- **Cleared** (false) by *any* success — every `onApplied` (`sync.ts:270`), every `onControl` `up-to-date` (`sync.ts:299`), and on `start()` (`sync.ts:255`).

So a momentary blip on **one** stream flips the **whole** footer to "Sync error", and the very next success on **any** stream clears it — a self-triggering flicker (live-captured: the banner flipped twice in a 35s session; writes returned 200 throughout and data persisted on reload). The write path (`flush`) never touches `hasError`, confirming this is purely read-path noise, not a write failure (see 087 for the opposite gap).

## Settled approach (owner, 2026-07-16): ignore transient + debounce

1. **Ignore expected/transient read errors** in `onError` — do not treat them as `hasError`:
   - The **boot-race** `missing_token` / 401 that fires before the auth token is available (it self-heals on sign-in).
   - **Transient transport errors** Electric will retry on its own (aborted long-poll / socket-closed on a live stream). Distinguish these from a *genuine* apply/parse failure (`toRowDeltas()` parse throw, or `applyInboundDeltas()` throwing a real local FK/constraint error) — only the latter is a real problem.
2. **Debounce the genuine error.** Even a real error should not flash "Sync error" instantly. Only surface `'error'` after a short **grace window (~5s)** during which no success arrived to clear it. Transient issues self-heal within 1–3s, so they never reach the banner; a sustained failure does.

## Design

Keep `deriveSyncStatus` a **pure** function (it is unit-tested in isolation, `syncStatus.ts` header). Introduce time as data, not a side effect:
- Replace `hasError: boolean` in `SyncStatusInput` with `errorSince: number | null` (the timestamp the current genuine, unresolved error began; `null` when there is none) plus `now: number`. Add a `SYNC_ERROR_GRACE_MS` constant (≈5000).
- `deriveSyncStatus`: replace `if (input.hasError) return 'error'` with `if (input.errorSince !== null && input.now - input.errorSince >= SYNC_ERROR_GRACE_MS) return 'error'`. During the grace window the status falls through to `reconnecting`/`syncing` (calm activity), never to `synced` (still honest — something is in flight).
- **Store wiring** (`sync.ts`):
  - In `onError(table, error)`: **classify** the error. If it's a boot-race/transient transport error → ignore (do not set `errorSince`). If genuine → set `errorSince = Date.now()` only if not already set (don't keep resetting the clock), then `recompute()` and schedule a single `recompute()` after `SYNC_ERROR_GRACE_MS` (so the banner appears when the grace elapses if still unresolved). The classifier lives where the error shape is known — investigate `src/sync/syncEngine.ts`'s `onError` to see exactly what `error` carries (message / status / cause) and whether to classify there (preferred: pass a typed/tagged error) or in the store.
  - In `onApplied` / `onControl up-to-date`: set `errorSince: null` (clear) — already the `hasError:false` sites, now clearing the timestamp; also clear any pending grace timer.
  - `start()`: `errorSince: null`.
- The `SyncIndicator` shell component still only reads the derived status — no change beyond the input rename ripple.

## Files / layers touched (file:line)
1. `src/domain/syncStatus.ts:12-35,40-47` — `SyncStatusInput` (`hasError` → `errorSince` + `now`), `SYNC_ERROR_GRACE_MS`, the `deriveSyncStatus` error branch.
2. `src/store/sync.ts:255,270,299,303-307` — track `errorSince` instead of `hasError`; classify+ignore transient/boot-race in `onError`; grace-timer + `now` plumbing into the `recompute()` that builds `SyncStatusInput`; clear on success/start.
3. `src/sync/syncEngine.ts` (investigate) — where read errors originate; tag transient/transport vs genuine so the store can classify (or expose enough on the error to classify in the store).
4. Tests: `src/domain/syncStatus.test.ts`, `src/store/sync.test.ts` (+ any syncEngine error-tagging test).

## Test-first plan (red first)
1. **`deriveSyncStatus` grace window** — pure unit: `errorSince` set but `now - errorSince < GRACE` → status is NOT `'error'` (falls to `syncing`/`reconnecting`); `now - errorSince >= GRACE` → `'error'`; `errorSince === null` → never `'error'`. Red today (instant `hasError` → error).
2. **Boot-race ignored** — store: an `onError` carrying a `missing_token`/pre-auth 401 leaves `errorSince` null → status never shows `'error'` from it. Red today (any onError sets hasError).
3. **Transient transport ignored** — store: an aborted-long-poll/socket-closed `onError` (the kind Electric retries) leaves `errorSince` null. Red today.
4. **Genuine error debounced then shown** — store: a genuine apply/parse `onError` sets `errorSince`; within grace the status is not `'error'`; after grace (advance the clock) it is; a success before grace clears `errorSince` and the banner never appears. Red today.
5. **Success clears** — store: after a genuine error within grace, an `onApplied`/`onControl up-to-date` sets `errorSince: null` and cancels the pending banner. Red today (clears hasError but no debounce concept).

Standing gate: `npm run verify:fast` green. (Timer-based store tests use fake timers for determinism — no wall-clock waits.)

## Acceptance criteria
- [ ] The pre-signin `missing_token` boot-race never shows "Sync error". Test 2.
- [ ] Normal long-poll churn/aborts never show "Sync error". Test 3.
- [ ] A genuine, sustained read-path failure DOES show "Sync error" — but only after the ~5s grace, not instantly, and it clears the moment a stream recovers. Tests 1, 4, 5.
- [ ] `deriveSyncStatus` stays pure (time passed as `now`, tested with no wall-clock). 
- [ ] No write-path behavior change (that's 087); `verify:fast` green; STYLE_GUIDE §9 numerate copy unchanged ("Sync error" wording kept).

## Open tension
- **Classification boundary.** "Transient transport error Electric will retry" vs "genuine failure" must be drawn from what `syncEngine`'s `onError` actually receives — if the error shape doesn't cleanly distinguish them, the safer default is to **debounce everything** (grace window alone already kills the observed flicker, since all observed triggers self-heal within 1–3s) and treat the explicit boot-race `missing_token` as the one hard-ignored case. Decide during red tests based on the real error shapes.
- Grace at 5s is a starting point; tune if a real sustained error should surface faster/slower.

## References
`docs/issues/done/036-sync-state-offline-ui.md` (the state machine this extends; "truthful over reassuring") · `src/domain/syncStatus.ts`, `src/store/sync.ts:240-320`, `src/sync/syncEngine.ts` · `docs/STYLE_GUIDE.md` §9 (numerate status copy) · live evidence: `scratchpad/live-sync-error/results.json` (the two flips + all-200 writes) · related: **087** (surface genuine write-outbox failures — deferred).
