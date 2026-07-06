# 036: Sync state + offline reconciliation UI

- **Status**: OPEN
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 032 (sync exposes the state this renders)

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

- [ ] The status bar shows synced/syncing/offline(N)/reconnecting/error, truthfully (green only when the server has the change).
- [ ] Offline edits are visibly queued and drain on reconnect; a lost local edit gets a quiet note, never a modal.
- [ ] All feedback flows through `useStatusStore` (no toasts); `npm run verify` green.
