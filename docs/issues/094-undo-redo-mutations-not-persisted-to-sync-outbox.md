# 094: undo/redo of a mutation is never persisted to the sync outbox (cloud-mode data-loss)

- **Status**: OPEN — discovered 2026-07-18 while scoping the HANDOFF "reorderTable undo-enqueue" cleanup. Not started. **Owner decision pending on scope** (systematic fix vs. documented accept).
- **Milestone**: M8 (sync). Client-only.
- **Severity**: **High** — silent divergence between the optimistic UI and the server in cloud/synced mode. Same *class* as the Critical 073 (a whole category of mutations never reaching the write outbox), but narrower (only the undo/redo edge, not the forward path).
- **Related**: **073** (the forward-path enqueue choke point `enqueueIfSyncing`), **006** (command-log undo/redo), **092** (fixed the *refresh* half of the same undo/redo closures — this is the *persistence* half), **089-D3 P3.4** (the `reorderTable` follow-up note that surfaced this).

## Symptom

In **cloud/synced mode** (signed in, sync enabled), undoing or redoing any persisted mutation updates the local PGlite + the optimistic UI, but the reversal **never reaches the server**. So:

1. Reorder dimensions A,B,C → B,A,C (forward path enqueues → server now B,A,C).
2. Press Undo → local reverts to A,B,C, footer stays "Synced".
3. Reload (or a peer re-syncs) → the read-path streams **B,A,C** from RDS → the undo is silently lost.

The user sees undo "work", then watches it revert on the next load. Masked entirely in **local-only mode**, where PGlite *is* the source of truth and no outbox exists — which is why local-first testing never caught it.

## Root cause (confirmed against the code)

The forward path of every mutating store action manually calls `enqueueIfSyncing(table, id, op, row)` (the 073 choke point) *after* the local DB write — that is the ONLY thing that puts a row on the write outbox. The **command-log `push({ undo, redo })` closures call the same `db*` mutation helpers but never call `enqueueIfSyncing`** (nor `notifyLocalApply`'s persistence equivalent). So the reversal mutates local PGlite and returns, with nothing enqueued.

Confirmed instances (representative, not exhaustive):
- `src/store/dimensions.ts` — `reorder` undo/redo (`:210-215`) and `remove` undo/redo (`:245-254`): forward path enqueues (`:203-207`, `:235-241`), closures do not. **User-facing (Design rail dimension reorder/remove is shipped).**
- `src/store/tier2.ts` — `reorderTable` undo/redo (`:324-329`) and `promote` undo/redo (`:583-597`): forward path enqueues (`:317-321`, `:570-571`), closures do not. (`reorderTable` is `?d3rf`-only today; `promote` is user-facing.)
- **Breadth scan**: across `dimensions.ts` / `parameters.ts` / `contexts.ts` / `tier2.ts` / `canvases.ts` / `tier1.ts` / `projects.ts` (34 `push({…})` blocks total), **no** undo/redo closure calls `enqueueIfSyncing`. This is systemic, not a single miss.

092 already wired `notifyLocalApply`/`refreshDesignLane` into the cross-tier undo/redo closures — that fixed the co-mounted-lane **refresh** (a live-UI concern). This issue is the orthogonal **persistence** gap in the same closures.

## Approach (to design during the issue)

The fix is mechanical but broad and needs a red-first harness that proves an undo/redo enqueues the correct reversal rows. Options for the owner to choose scope:

- **(A) Systematic fix** — thread the same per-row `enqueueIfSyncing` accounting the forward path does into every undo/redo closure (undo of an `upsert`→`delete`, undo of a `delete`→`upsert`/`update`, reorder undo → re-enqueue every sort-changed row). Consider a shared helper so a closure declares its row-deltas once and both the live-apply and the enqueue fall out of it (removes the whole class of "forgot to enqueue on undo"). ≤5 files/phase, one store at a time, red-first (a real-PGlite outbox assertion like `src/sync/materialization.integration.test.ts`).
- **(B) Documented accept** — if undo/redo is intended to be a session-local convenience only, make that explicit (SPEC + a UI affordance note) rather than leaving a silent divergence. Not recommended: the forward path *does* persist, so the asymmetry reads as a bug to any user.

## Test-first plan (if A)

1. Red: a store/integration test that performs a forward mutation (reorder / remove / promote), asserts N rows on the outbox, then undo → asserts the outbox carries the reversal rows (correct `op` + only `sort`/tombstone fields, never `{x,y}`), then redo → asserts the re-application rows. Watch it fail on today's code.
2. Implement per store; keep 090 canvas-scoping and the derived-positioning invariant (reorder enqueues `sort` only, never a persisted position).
3. `npm run verify:fast` + the affected e2e.

## Notes / non-negotiables
- Enqueue is gated `IfSyncing`, so local-only behavior is unchanged (no regression there).
- Do NOT persist `{x,y}` — the 089-D3 derived-positioning invariant: a reorder enqueues `sort` only.
- Watch the `remove`/`restore` op direction carefully (tombstone vs. resurrect) — undo of a soft-delete must enqueue an `update` clearing `deleted_at`, not an `upsert` of a fresh row.

## References
`src/store/sync.ts` (`enqueueIfSyncing`), `src/store/commandLog.ts` (push/undo/redo), `src/store/dimensions.ts` (`reorder`/`remove`), `src/store/tier2.ts` (`reorderTable`/`promote`), `src/store/parameters.ts` / `contexts.ts` / `canvases.ts` / `tier1.ts` / `projects.ts` (all carry undoable ops) · `done/073-domain-content-mutations-never-reach-write-outbox.md` (the forward-path precedent) · `092-undo-redo-cross-lane-staleness.md` (the refresh half of these same closures).
