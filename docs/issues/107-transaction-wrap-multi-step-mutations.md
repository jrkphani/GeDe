# 107 — Transaction-wrap the remaining multi-step DB mutations

**Status:** OPEN — non-blocking robustness. **From:** 105 residual MEDIUM. **Milestone:** M8/M11 (write path).

## Problem

Multi-step DB mutations in `src/db/mutations.ts` run their 2+ writes as separate **auto-committing** statements. A mid-sequence failure (constraint, engine error) leaves partial state (e.g. a changed `parent_id` with a half-densified sibling `sort`) that then becomes authoritative on the next reload/sync. No user-facing bug is known today, but it's a latent local-DB integrity gap.

## Pattern (already proven — Phase 1 shipped)

`moveTier2Entry` was wrapped in `db.transaction(async (tx) => { … })` (commit `dc51894`, issue 105 Phase 1). The established, reviewed pattern:

- Export `Tx`/`Querier` from `src/db/client.ts` (done).
- Wrap **all** of a mutation's writes in one `db.transaction`; every intra-callback read/write uses `tx` (sees uncommitted state); the not-found pre-read + the authoritative final read run on `db` (the latter after COMMIT).
- Widen only the helpers a mutation touches from `db: Database` → `db: Querier` (`Database` is assignable to `Querier`, so existing callers are untouched).
- **The store layer does NOT change:** the sync outbox (`enqueueIfSyncing`) is in-memory and enqueued *after* the mutation resolves, so a rolled-back (rejected) mutation already skips enqueue + `commandLog`. Enqueue-inside-txn is INVALID (a PGlite rollback can't revert an in-memory queue).
- RED-first: a `dbFailingOnNthUpdate` Proxy (throws on the Nth `.update()`) proves full rollback; a store guard asserts a rejected mutation leaves the outbox queue + commandLog empty. Success path stays byte-identical (existing enqueue-payload tests are the oracle).
- **No nested-transaction hazard:** confirm each target is only ever called with the top-level `db` from a user-gesture store action, never from inside `applyInboundDeltas`/`importProject`.

## Remaining mutations (phased, ≤5 files/phase — mechanical repeats of Phase 1)

- **Phase 2 — tier2 subtree/promote:** `removeTier2EntrySubtree`, `restoreTier2EntrySubtree`, `promoteEntries`.
- **Phase 3 — reorder family (all `rewrite*Sort` loops, identical shape):** `reorderCanvas`, `reorderDimension`, `reorderParameter`, `reorderTier1Prop`, `reorderTier2Table`.
- **Phase 4 — cascades:** `archiveCanvasCascade`, `restoreCanvasCascade`, `removeDimension`, `restoreDimension`.
- **Phase 5 — binding/param cross-table:** `bindParameter`, `unbindParameter`, `openChildCanvas`, `revertStaleRebind`, `relinkParameters`, `deleteParametersUnbinding`, `restoreParametersWithBindings`, `createProject`.

## Acceptance

Each phase: RED-first rollback test per mutation (+ existing happy-path oracles green), `code-reviewer`/`database-reviewer` pass (write-path), CI green, and a post-deploy CloudWatch read-only check (`…WriteApiFunction…`, profile `phani-quadnomics`) confirming no new error signatures (success-path deltas are unchanged, so the write API sees no behavioral difference).

## Test-first plan

Mutation-layer rollback tests in `src/db/mutations.test.ts` (+ the mutation's existing test file); store-ordering guards in the relevant `src/store/*.test.ts` where the mutation is user-triggered. Reuse the `dbFailingOnNthUpdate` Proxy helper from `src/db/tier2.test.ts`.

## Optional polish (from the Phase-1 DB review, LOW)

- `src/db/projectIO.ts:34` re-derives a local `Tx`; import the shared `Tx` from `./client` instead.
