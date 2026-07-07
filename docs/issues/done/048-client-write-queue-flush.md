# 048: Flush the client write-queue to `/write` — close the loop

- **Status**: SHIPPED — code complete (DI-testable `writeTransport`, gated flush, retry/backoff/reconnect, calm rejection); combined verify green (837 vitest incl. transport tests + 87 CDK jest); integrated on `m11-close-write-loop`. **Live AWS deploy pending** (CI on merge to `main`, after 044–047); the live end-to-end e2e runs at that point. Downstream seams noted below still open (workspace-id wiring, queue insert/update split, rejection row snapshot).
- **Milestone**: M11 (Close the cloud write loop)
- **Blocked by**: 044 (real JWT), 045 (RDS schema), 046 (real handler), 047 (HTTPS endpoint), 032 (the mutation queue this flushes — SHIPPED)

## Slice

As a signed-in collaborator, my local optimistic edits (already instant against PGlite) **actually replay to the server**: the client mutation queue (032) POSTs batches to the `/write` API (043/046) with my Cognito JWT (044), the server persists to shared Postgres, and rejections reconcile back into a calm client error + undo-coherent rollback. This is the capstone that turns the deployed pieces into a working end-to-end write loop.

## Motivation

Everything downstream of the browser was built to a *documented seam* and never connected. 032 built the optimistic-write queue (`src/domain/mutationQueue.ts`) and `src/store/sync.ts` tracks `pendingCount`, **but nothing ever sends the queue anywhere** — there is no `fetch()` to the API in the client, so `pendingCount` can only shrink when an inbound Electric delta happens to acknowledge it. 043 explicitly deferred this: *"wire 032's queue to POST batches at `/write*` and reconcile `WriteRejection`s into its rollback path."* This issue is that wiring — the last hop.

## Ground truth (verified 2026-07-07)

- **Client code**: grep of `src/` (non-test) for any `fetch(`/HTTP call to the ALB, `/write`, or an API base URL → **none**. The queue enqueues + prunes but never transmits.
- **The seam exists on both ends**: 032 owns `enqueue`/`pendingCount`/`QueuedMutation` (`src/store/sync.ts`, `src/domain/mutationQueue.ts`); 043 owns the wire contract (`src/domain/mutationProtocol.ts` — `MutationEnvelope`, UUIDv7 idempotency, `resolveLastWriteWins`) and the typed `rejection.ts`. Neither is joined by a transport.
- **Blockers are real and sequenced**: without 044 there's no JWT to attach; without 047 the browser mixed-content-blocks the HTTP ALB; without 046 the endpoint returns 503; without 045 a legal write 500s on a missing table. This issue lands **after** those.

## Scope

- **A write-transport in the sync layer** that drains `mutationQueue` to the API: batches queued mutations into the 043 `MutationEnvelope` wire shape, POSTs to the HTTPS `/write` endpoint (047), attaches the Cognito JWT via the existing `wireIdentity.getAuthHeaders()` seam (033/044).
- **Replay semantics** (043 owns the protocol; this consumes it): in-order flush, UUIDv7 idempotency (safe retry), exponential backoff on network failure, and **flush-on-reconnect** (drain the offline backlog when connectivity returns). Update `pendingCount`/sync-state (036) from real acks, not just inbound deltas.
- **Rejection → reconciliation**: a `WriteRejection` (043 `rejection.ts`) surfaces as a calm status-bar error (015 style, `useStatusStore.announce()`), rolls the optimistic local write back / reconciles to the authoritative server row (via the Electric read-path stream, 032), and keeps the undo stack (006) coherent.
- **DI-testable transport** (like 032's sync seam): the HTTP client is injected, so tests drive success/reject/offline without a live network — matching the repo's `BroadcastChannel`/authToken seam discipline.
- **Feature-gated**: gate the live flush on the sync/auth flags so the account-free local path is untouched when signed-out or when sync is `off` (Playwright/e2e stay network-free).

Out of scope: the server handler (046); TLS (047); auth config (044); schema (045); presence (038); Google federation.

## Design brief

- **Local-first is preserved** (ADR-0010): edits never wait on the server; the flush is asynchronous and the client stays authoritative offline. The server is authority only for what lands in shared Postgres.
- **One mutation path** (TECH_STACK §5): writes already flow component → store → `mutations.ts`; this extends the *same* path's queue to the network — no second write channel.
- **Calm failure** (015): a rejected/failed write is a quiet status-bar note with Undo intact, never a toast, never data loss (offline backlog persists and replays).
- **Consistent with 043's contract**: use `mutationProtocol.ts` verbatim as the wire vocabulary so client and server can't drift; idempotency + LWW live server-side, the client just replays and reconciles.

**References**: issue 032 (mutation queue, `pendingCount`, sync seam), 043 (`mutationProtocol.ts`, `rejection.ts`, replay/idempotency/LWW contract), 036 (sync-state UI to reflect real acks), 033/044 (`wireIdentity` JWT), 015 (calm rejection style), 006 (undo coherence) · ADR-0010 · SITEMAP §2 (status bar sync state) · TECH_STACK §5.

## Test-first plan

1. **Happy path (unit, injected transport)**: enqueue N mutations → transport receives them as `MutationEnvelope`s with the JWT header → on 200, `pendingCount` drops to 0 and sync-state reads "synced".
2. **Idempotent retry**: a transport that fails once then succeeds replays the *same* UUIDv7 envelopes; no duplication (server no-ops the replay — asserted via the contract, and the client doesn't double-count).
3. **Offline backlog + reconnect**: with the transport offline, edits queue and `pendingCount` grows; on reconnect the backlog flushes in order and drains.
4. **Rejection reconciliation**: a `WriteRejection` response rolls back the optimistic local write, surfaces a calm status-bar error (015), and leaves the undo stack (006) coherent (property/e2e).
5. **Signed-out / sync-off**: no flush occurs; the local app is byte-for-byte unchanged (e2e stays network-free).
6. **Live e2e (post-deploy, gated)**: signed in against the real pool, a local edit appears in RDS and streams back — the full loop, exercised once (the check 043 could never run).

## Acceptance criteria

- [ ] Signed-in local edits replay to `/write` over HTTPS with the Cognito JWT; `pendingCount`/sync-state reflect **real** server acks; offline edits replay in order on reconnect.
- [ ] Server rejections reconcile to authoritative state with a calm error and a coherent undo stack; no loss/duplication (idempotent replay).
- [ ] Signed-out and `sync=off` paths are unchanged (account-free local app still instant and network-free); the transport is DI-testable.
- [ ] `npm run verify` green; the end-to-end loop passes a live post-deploy e2e.

## Implementation notes

- This is the issue that finally exercises 043 live. Land the four blockers first (044 → 045 → 046 → 047), then this. Until then, build + unit-test against the injected transport exactly as 043/032 built against documented seams.
- Reuse `wireIdentity.getAuthHeaders()` (033) for the JWT; reuse `mutationProtocol.ts` (043) for the envelope; reuse 036's sync-state for the UI — do not invent parallel machinery.
- Deploy/live verification is CI + a post-merge smoke; "done" for the code is merge-ready + green `verify` with the injected-transport tests, plus the gated live e2e wired (skips cleanly without network, like 042's semantic gate).
