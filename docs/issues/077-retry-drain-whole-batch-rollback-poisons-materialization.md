# 077: One FK-blocked row rolls back the entire retry drain → streamed content never materializes (Design 3/3, tier1/tier2 flaky)

- **Status**: OPEN
- **Milestone**: M8 — sync read-path materialization (convergence)
- **Severity**: **Critical** — the remaining, deterministically-reproduced cause of content not rendering after sign-in, once 076 removed the infra 502 noise. Design tier fails 3/3 (deterministic); Foundation/Architecture flaky (bycatch). Data reaches the client (0 502s, rows on the wire) but never lands in local PGlite for the affected tiers.
- **Found via**: a real-PGlite integration harness (`src/sync/materialization.integration.test.ts`) that reproduces it deterministically (6/6, 3×) — built specifically because the production build exposes no PGlite/sync-store introspection.

## Root cause (proven on real PGlite, file:line)

075A's reconcile-retry drains the buffered (previously-FK-failed) deltas via a single `applyInboundDeltas(db, sortedBuffer)` (`src/sync/syncEngine.ts:175`), which runs them in **one atomic `db.transaction`** (`src/db/sync.ts:50`). If **any** buffered row hits a real local FK violation partway through, the whole transaction rolls back — discarding every other, individually-resolvable row riding in the same drain.

The trigger the harness pins: `DEFERRED_FK_COLUMN` (`src/db/sync.ts:34-39`) nulls only **one** column per table and does **not** include `dimensions.contextId` (a real, non-deferred, nullable FK to `contexts`, set for any child-canvas / drill-down dimension). `RETRY_APPLY_ORDER` (`syncEngine.ts:33`) is a **static** list with `dimensions` (idx 5) before `contexts` (idx 7). So a child-canvas dimension buffered alongside its not-yet-committed context FK-fails mid-drain → whole-batch rollback → and because the order never changes, **every subsequent drain fails identically → permanent, silent** (the orphan-surfacing never fires because the affected tables never reach `up-to-date`). tier1/tier2/root-dimensions/parameters riding in the same drain are collateral → the observed flakiness (they render only when their delivery happens to beat `projects` and skip the buffer entirely).

Confirmed NOT the cause: 075A's retry works in isolation (harness Scenario A converges); 075B's store-refresh works (faithfully mirrors PGlite); 072's projects-only ensure-workspace is real but not the deterministic Design bug; 401-cold-start-then-retry is a non-issue (a later push always applies).

## Fix direction — make the drain robust, not just patch the one FK

The single-atomic-drain is the core flaw: **one blocked row must not roll back unrelated resolvable rows, and convergence must not depend on a static global order** (the code's own comment at `syncEngine.ts:39-42` admits a single order can't cover every nested-FK combo). Implement drain resilience:
- In `drainRetryBuffer` (`src/sync/syncEngine.ts`), apply buffered deltas so a row whose cross-table parent isn't present yet **stays buffered while every resolvable row commits** — e.g. apply per-row (or per-table-group), keeping only genuinely-blocked rows buffered; convergence then holds regardless of `RETRY_APPLY_ORDER`, because each drain lands more parents until the buffer empties. Preserve `applyInboundDeltas`'s existing intra-batch two-pass for same-batch deferred cycles.
- ALSO add `dimensions.contextId` to the deferred null-then-restore treatment (`DEFERRED_FK_COLUMN` needs multi-column-per-table support: `dimensions` now has both `sourceParamId` and `contextId`), so a child-canvas dimension can insert with a null context then restore once contexts land.
- Do NOT weaken `applyInboundDeltas`'s own per-call atomicity, nor 075A's buffer/orphan-surfacing safety net.

## Test-first / verification (harness is the ground truth)

1. **Confirm the SMOKE's exact shape reproduces it first.** Add a harness scenario matching `run.mjs`'s real data — root dimensions (Region/Segment, `contextId` null) + parameters + one context-register entry (a `contexts` row + `bindings`) — delivered raced/out-of-order like production. Assert whether it reproduces the whole-tier failure. **If it does NOT reproduce, STOP and report** — the fix may be targeting the wrong mechanism and we need to keep digging (do not "fix" a bug the live smoke doesn't hit).
2. Flip the failing harness scenarios (B + the new smoke scenario) to assert the DESIRED behavior (every table's rows materialize in PGlite AND the stores reflect them) → confirm RED before the fix, GREEN after.
3. `npm run verify:fast` green — the drain change must NOT regress 075A's `syncEngine.test.ts` (buffer/retry/orphan/drain-race tests) or any existing sync/apply test; update them only if the drain's contract legitimately changed.

## Dependencies / notes

No schema/migration change. Builds on 075A's buffer (`syncEngine.ts`) and `applyInboundDeltas` (`db/sync.ts`). This is the last known client-materialization gap; once green, one final deploy + a 3-session determinism smoke should show all tiers render reliably.

(RLS-no-op + tenant-context-key follow-up from 071 is now **issue 078**.)

**References**: `src/sync/materialization.integration.test.ts` (the repro harness), `src/sync/syncEngine.ts:33,44-45,175` (RETRY_APPLY_ORDER + drainRetryBuffer), `src/db/sync.ts:34-50` (`DEFERRED_FK_COLUMN`, `forceDeferredNull`, the atomic `applyInboundDeltas` transaction), `src/db/schema.ts:196` (`dimensions.contextId`).
