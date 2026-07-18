# 087: Genuine write-outbox failures retry silently — surface them in the status

- **Status**: ✅ SHIPPED (`e7470c5`) + **LIVE-VERIFIED 2026-07-18** (`index-l2xFhny9.js`), 8/8. Archived to `done/`.
- **Live verification** (`scratchpad/live-verify-087/run.mjs`, agent-run on prod): the normal signed-in flow shows NO false write-stall; a sustained write failure surfaces the calm **"Changes not saving"** footer (`data-sync-status="write-stalled"`) after the 5s grace; once writes succeed again the write-stall **clears**. Verified with a controlled write-abort (Playwright URL-predicate route → `route.abort`) triggering a throwaway-dimension create. **Doubly validated**: an *earlier* run surfaced a GENUINE server 500 (a real `tier1_purpose` 23505 — see **095**) as "Changes not saving" — i.e. 087 correctly revealed a real silent write failure in the wild, which is exactly its purpose.
- **Verification gotchas** (recorded for the next live-smoke — each cost a round-trip): (1) GeDe is a PWA but the SW does not gate `/write`; (2) Playwright's `'**/write*'` **glob does not match** `https://…/write` — use a **URL-predicate matcher**; (3) `page.on('request')` does **not** observe a route-aborted request — count the abort inside the handler; (4) the Foundation-purpose editor commits on `focusout` (bubbles) — blur the contentEditable directly, a non-focusable heading click does not move focus; (5) verifying recovery needs a write that can SUCCEED — the purpose write can't on a client whose local mirror lacks the row (095), so use a fresh-uuid dimension create.
- ~~**Status**: OPEN~~
- **Milestone**: M8 (sync-state UI). Client-only.
- **Blocked by**: none. Complements **086** (which fixed the opposite miscalibration — the over-sensitive read-error banner). Split out of 086 by owner decision to keep that change tight.

## User story

As a user, if my edits genuinely stop reaching the server (an expired token, a server 5xx, the write API down), I currently get **no signal at all** — the optimistic UI shows my edits applied, the footer stays "Synced" or "Syncing", and I only discover the loss when a reload re-materializes from RDS without them. I want a calm but honest indication that my changes are **not saving**, so I can stop and retry rather than lose work.

## Root cause (confirmed — see 086 investigation)

The write path (`flush()` → `POST /write`, issue 048) **never touches the sync error state**. Verified live (086's smoke): across 24 mutations with the footer flipping "Sync error" purely from read-path blips, the write responses were all 200 — but the mirror case is untested and unhandled: `flush()` on a non-2xx / network failure only **retries with backoff and posts a quiet status-bar announce** (`src/store/sync.ts` flush branch). Nothing raises the sync status. So a *sustained* write failure is invisible in the footer, while (pre-086) a *transient read* blip screamed. 086 fixed the read side; this fixes the write side.

## Approach (to design during the issue)

Surface a **sustained** write-outbox failure in the status — calm, debounced like 086, not a modal:
- Track consecutive `flush()` failures / time-since-last-successful-flush with a pending backlog.
- After a grace/threshold (mirror 086's `SYNC_ERROR_GRACE_MS` philosophy), reflect it in `deriveSyncStatus` — likely a distinct signal from read `errorSince` (e.g. `writeStalledSince`) so the label can be specific ("Changes not saving" vs read "Sync error"), or a shared error with clearer copy. Decide the copy against STYLE_GUIDE §9.
- Clear the moment a flush succeeds. Must not fire for the ordinary offline case (already handled — `offline · N pending`) or a single transient retry.

## Notes
- Keep `deriveSyncStatus` pure (time-as-data, like 086).
- Coordinate with 048 (write-queue flush) and 036 (the status state machine).
- Test with fake timers; a genuine deterministic e2e for token-expiry write failure is likely out of reach — unit/store coverage is the bar.

## References
`docs/issues/086-sync-status-miscalibration.md` (the read-side fix + the shared debounce philosophy), `done/048-client-write-queue-flush.md`, `done/036-sync-state-offline-ui.md` · `src/store/sync.ts` (flush), `src/domain/syncStatus.ts` · live evidence: `scratchpad/live-sync-error/results.json`.
