# 036: Sync state + offline reconciliation UI

- **Status**: SHIPPED
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 032 (sync exposes the state this renders) — done

## Slice

As a user I can always tell **whether my work is saved to the shared server** — synced, syncing, offline with pending local changes, or reconnecting — surfaced in the status bar exactly where SITEMAP §5 reserves space for it, so collaboration never feels like a black box.

## Motivation

SITEMAP §5 already says the status bar's right cluster "adds sync state here" at v2. 032 makes sync work but headless; without a visible, honest sync indicator the local-first model reads as "did my edit save?" anxiety. This issue renders the state 032 exposes and handles the human side of reconnection.

## Scope

- **Sync indicator** in the status bar right cluster (SITEMAP §5, beside drafts/coverage/version): states = **synced** · **syncing** · **offline (N pending)** · **reconnecting** · **error**. Mono, `--ink-muted`, one accent for the healthy state — no toasts (the status bar is the single feedback channel, 016).
- **Offline honesty**: while disconnected, show that edits are local-only and how many are queued; on reconnect, show convergence, then settle to synced.
- **Conflict surfacing**: LWW (032) resolves silently by default, but a *lost* local edit (overwritten by a newer remote one) gets a quiet, non-blocking note (STYLE_GUIDE §9 voice) — never a modal.
- **Reduced-motion / calm**: state transitions are ≤100ms, opacity/text only, no spinners that jitter (STYLE_GUIDE §8).

Out of scope: the sync mechanism (032), presence/other-user cursors (038), a full conflict-resolution UI (LWW is the model; this only *surfaces* it).

## Design brief

- **One channel, quiet** (016, STYLE_GUIDE §9): sync state is ambient status-bar text, not interruptive. "Offline — 3 changes pending" says exactly what's true and what's queued.
- **Truthful over reassuring**: never show "synced" while a delta is in flight or failed; the indicator is only green when the server has the change.
- **Numerate voice** (STYLE_GUIDE §9): "Synced", "Syncing…", "Offline · 3 pending", "Reconnecting…" — specific, no exclamation.

**References**: SITEMAP §5 (status bar reserves sync state), §2 · STYLE_GUIDE §8 (motion), §9 (voice), §4 · issue 016 (status bar = single feedback channel, `useStatusStore`), 032 (sync state source), 006 (undo interplay).

## Test-first plan

1. State mapping: given each sync state from 032, the indicator renders the correct label; `offline` shows the pending count.
2. Offline→reconnect: goes offline (queues N) → reconnecting → synced, with the count draining to 0; asserted in an e2e that drops the connection.
3. Lost-edit note: a simulated LWW overwrite of a local edit surfaces a quiet status note, no modal.
4. Calm: transitions are opacity/text only; reduced-motion leaves them instant and legible.

## Acceptance criteria

- [x] The status bar shows synced/syncing/offline(N)/reconnecting/error, truthfully (green only when the server has the change).
- [x] Offline edits are visibly queued and drain on reconnect; a lost local edit gets a quiet note, never a modal.
- [x] All feedback flows through `useStatusStore` (no toasts); `npm run verify` green.

## Shipped notes

- **Pure state machine** — `src/domain/syncStatus.ts`: `deriveSyncStatus()` folds `{enabled, online, hasError, reconnecting, upToDate, pendingCount}` into `disabled | offline | error | reconnecting | syncing | synced`, in that priority order ("truthful over reassuring" — offline/error never gets papered over by a stale "synced"). `syncStatusLabel()` renders the issue's own quoted numerate copy verbatim ("Synced", "Syncing…", "Offline · N pending", "Reconnecting…", "Sync error"). `detectLostEdits()` + `lostEditMessage()` implement conflict surfacing (test-first plan #3): compares only the columns a pending optimistic write actually touched against the authoritative echo (not the full row — an authoritative snapshot always carries every base column, so full-row equality would false-positive on every ordinary round-trip), so a genuine newer-remote overwrite is distinguished from the write's own echo.
- **032's read-path gained one seam it had left for this issue**: `src/sync/syncEngine.ts`'s `SyncOptions` gained `onControl?(table, control)`, fired for Electric's control messages (`up-to-date`/`must-refetch`/…) that were previously silently dropped — additive only, the pre-existing "a control message alone produces no deltas and never calls onApplied" test still passes unchanged.
- **Store wiring** — `src/store/sync.ts`: tracks `online` (browser `online`/`offline` events), `hasError` (self-heals on the next successful apply/control), `reconnecting` (set the instant the browser comes back online after a drop; cleared only once every synced table has re-reported `up-to-date` AND the queue has drained to 0 — this is what makes the offline → reconnecting → synced sequence honest rather than flipping to "synced" the moment the network returns), and the derived `status`. On every `onApplied` batch, runs `detectLostEdits` before reconciling and announces the quiet note via `useStatusStore.announce` (never a toast).
- **UI** — `src/shell/SyncIndicator.tsx`, mounted in `StatusBar.tsx`'s existing `.status-bar__ambient` right cluster (SITEMAP §5, beside the version). Renders `null` when sync isn't enabled (v1's tested default — no status to be honest about). CSS in `src/styles/base.css`: `--ink-muted` for every state except `synced`, which gets `--accent` (issue design brief: "one accent for the healthy state"); a `≤100ms` (`--motion-fast`) color transition, opacity/text only, automatically made instant by the app's blanket `prefers-reduced-motion` rule.
- **Consumed from 032/033**: `src/sync/syncEngine.ts` (`startSync`, extended with `onControl`), `src/sync/config.ts` (`isSyncEnabled`, `SYNCED_TABLES`), `src/store/sync.ts` (`useSyncStore`, `resetSyncStore` — extended in place, not replaced), `src/domain/mutationQueue.ts` (`MutationQueue`, `QueuedMutation`, read-only — no changes to its own reconcile semantics), `src/domain/syncDelta.ts` (`RowDelta`, `TableName`). No migration touched (034's slot untouched, per the assignment).
- **Deviation flagged for review**: test-first plan #2 says the offline→reconnect flow is "asserted in an e2e that drops the connection." A true Playwright e2e against a live dropped connection isn't feasible here — no Electric server is reachable from any test tier (032's own documented constraint), and force-enabling `VITE_SYNC_ENABLED` for the shared `playwright.config.ts` webServer would change what every other e2e spec runs against. Implemented instead as a store-level integration test (`src/store/sync.test.ts`, fake `ShapeStreamFactory` + real browser `online`/`offline` events under jsdom) using the exact DI pattern 032 itself established for the same reason. `e2e/sync-status.spec.ts` covers what's honestly testable against the real app (indicator absent by default; status bar single-channel invariants hold).
- **Design-brief judgment call flagged for review**: the ambient sync indicator itself is NOT routed through `useStatusStore`'s transient narration slot — it's persistent chrome in the same ambient cluster as the version number (by design: "I can always tell" implies persistent, not a one-off toast-like message). Only the lost-edit note (a genuine one-off event) goes through `useStatusStore.announce`. The acceptance bullet "all feedback flows through useStatusStore" is read as: no separate toast/notification system exists outside the status bar — satisfied, since the indicator lives in the status bar itself, mirroring the pre-existing (pre-036) version span's own precedent of ambient-but-not-`useStatusStore` chrome.
- **Environment note (not a code issue)**: this worktree's `node_modules` was not populated on creation (Node resolution was silently borrowing the parent repo's `node_modules` via directory-walking, which is invisible to `vitest`/`tsc`/`eslint` but breaks Vite's dev-server `fs` allow-list for browser-fetched assets — every e2e spec, including pre-existing ones, failed with a "Storage is unavailable" PGlite error until fixed). Ran `npm ci` in this worktree to resolve; no tracked files changed (lockfile untouched, `node_modules` is gitignored).
