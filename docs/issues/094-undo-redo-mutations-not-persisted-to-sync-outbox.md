# 094: undo/redo of a mutation is never persisted to the sync outbox (cloud-mode data-loss)

- **Status**: PARTIAL / **PARKED — blocked on an OWNER DESIGN FORK** (2026-07-18 night shift). The client-side enqueue work (approach A) is **built and green in-memory** across all 7 stores (preserved in git stash `wip-094-undo-redo-enqueue`), BUT a real-Postgres probe during review found the systematic fix is **incomplete against the real server**: the write protocol has **no way to revive a soft-deleted row** (see "## The revival gap" below), so the *revive* subset of reversals (redo-of-add, undo-of-remove, restore) would enqueue mutations the live server **rejects/no-ops** — a silent InMemory↔Postgres divergence (the 053/054/095 "passes-tests-fails-live" class). The non-revive reversals (field-edit, reorder, forward-delete) are correct and shippable, but the owner explicitly rejected a half-fix. **Needs the revival-protocol design decision before it can ship correctly. Surfaced for the morning.**
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

## The revival gap (found 2026-07-18 by real-Postgres probe — the crux blocker)

The issue's own non-negotiable (below) assumed "undo of a soft-delete must enqueue an `update` clearing `deleted_at`." **That does not work against the real write API.** Empirically verified against a real Postgres 18 (`gede_probe`, migrations applied, direct SQL replicating the server ops):

1. **`update` cannot clear a tombstone.** `PgWriteStore.applyIfNew`'s update SQL builds its `SET` from the payload columns minus `SERVER_STAMPED = {id, updated_at, deleted_at, workspace_id}` (`store.ts:702`). `deleted_at` is **dropped**, so a revive `update` never sets `deleted_at = NULL`. Probe result: after delete→update, `deleted_at IS NULL` = **false** (row stays tombstoned).
2. **A revive `update` is rejected before it even applies.** `checkTenancy` resolves the target row via `getRow`, which filters `deleted_at IS NULL` (`store.ts:510`) → a tombstoned row resolves to `null` → **`unknown_entity`** rejection. So the reversal never reaches `applyIfNew`, and it logs `[writeApi][091]` noise.
3. **`upsert` cannot revive either.** The generic insert path is `ON CONFLICT (id) DO NOTHING` — against the existing tombstoned id it is a **no-op** (066-class), so it also leaves the row deleted. (This is exactly why the client work chose `update` over `upsert` for revive — but neither works.)

**⇒ No existing write op can un-tombstone a row.** This is a genuine, pre-existing protocol gap, not a client bug — and it means the **forward `restoreArchivedProject` path (issue 070) is itself likely broken in cloud mode** (it enqueues `update` for the revive), a latent bug worth its own live verification. The InMemory store hides all of this because its `applyIfNew` unconditionally sets `deletedAt: null` on any non-delete op (`store.ts` in-memory branch) — so 094's client work is green in-memory yet wrong live.

### The design fork (OWNER — surfaced for the morning)
How should the write protocol model **revival of a soft-deleted row**? The hard part is that the server cannot distinguish an *intentional* revive from a *stale delete-echo* (a late `update` for a row that was legitimately deleted meanwhile) — both are `op:update` targeting a tombstoned/absent row. Options:
- **(1) A dedicated `revive`/`undelete` op** in the mutation protocol — explicit intent, no ambiguity; server clears `deleted_at` + re-runs tenancy against the tombstoned row. Cleanest but a protocol + client + server change.
- **(2) Let `update` carry & apply `deleted_at`** (drop it from `SERVER_STAMPED`, and resolve tombstoned rows for tenancy) — smaller, but re-opens the stale-delete-echo → accidental-resurrection hazard and needs a rule to disambiguate.
- **(3) A revive-on-conflict upsert variant** (`ON CONFLICT (id) DO UPDATE SET deleted_at = NULL, …` gated on an explicit revive flag) — avoids a new op but complicates the insert path's no-clobber (066) semantics.
Recommendation: **(1)** — explicit intent is the only unambiguous model, and it also fixes the forward `restore` (070) gap. Until this is decided, ship nothing (a half-fix that silently drops revives in cloud is worse than the current all-or-nothing gap).

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
