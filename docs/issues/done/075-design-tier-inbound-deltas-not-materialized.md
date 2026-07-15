# 075: Design-tier content never renders after sign-in — no store refresh on inbound deltas (B) + unguarded cross-table FK race on apply (A)

- **Status**: IMPLEMENTED (code-complete + verify:fast green; pending live deploy + smoke)
- **Milestone**: M8/M11 — sync read-path materialization (Design tier)
- **Severity**: **Critical** — after 068/071/072/073 + the Electric cache restart, all shapes stream real rows and Foundation/Architecture/project-list render, but the **Design tier** (`dimensions`, `parameters`, `contexts`, `bindings`) never renders after sign-out/in, even though the rows arrive on the wire (verified: dimensions 2, parameters 6, contexts 1, bindings 2). Last gap before content fully round-trips; blocks a meaningful sharing test.
- **Found via**: live e2e after the Electric restart (2026-07-12) + read-only code investigation.

## Root cause — two compounding gaps, both generalizations of 072

**Gap B (universal, proven) — no store re-query on inbound deltas.**
`onApplied` (`src/store/sync.ts:236-253`) bumps only `invitationsAppliedAt`/`membersAppliedAt`/`projectsAppliedAt`. There is **no** signal for `dimensions`/`parameters`/`contexts`/`bindings` (nor `tier1_*`/`tier2_*`). Every store except `projects`/`PendingInvitations`/`WorkspaceMembers` loads **once on mount** with no delta subscription: `dimensions.ts:59-62`, `contexts.ts:193-213`, `parameters.ts:45-51` (called once from `DesignSurface.tsx:80-115`), also `tier1.ts:49-58`, `tier2.ts:162-176`. So a row that streams in after the initial `load()` never renders until a remount. (tier1/tier2 have the same gap but happen to render because their rows usually land before their surface mounts — see A.)

**Gap A (real race) — unguarded cross-table forward-FK on apply.**
`syncEngine.startSync` (`src/sync/syncEngine.ts:83-103`) opens **one independent `ShapeStream` per table**, each applying its own batch in its own `db.transaction` (`src/db/sync.ts:50`) whenever *that table's* response resolves — **no cross-table ordering**. `DEFERRED_FK_COLUMN` (`src/db/sync.ts:34-39`) defers only each table's **self/parent-of-same-table** column, NOT forward FKs to *sibling* synced tables, which are `NOT NULL`:
- `parameters.dimension_id → dimensions.id` (`schema.ts:211-213`, apply `sync.ts:158-170`)
- `bindings.context_id/dimension_id/parameter_id → contexts/dimensions/parameters` (`schema.ts:264-272`, apply `sync.ts:184-196`)
- `dimensions.context_id → contexts.id` (nullable, real for child-canvas dims; `schema.ts:196`)
If e.g. the `parameters` shape resolves before `dimensions` has committed, `tx.insert(parameters)` throws a local FK violation → the **whole batch rolls back** → swallowed by `syncEngine.ts:101` `.catch(onError)` → `store/sync.ts` `set({ hasError: true })` (then masked by other tables' applies). Electric never re-delivers an acked batch → rows permanently missing that session. Design tables are created in a tight burst so they hit this race where tier1/tier2 usually win it.

Runtime disambiguation in progress (does local PGlite have the rows or not); regardless, **both are real gaps** — fix B first (necessary + low-risk), add A if the race is manifesting.

## Fix — Part 1 (B): refresh-on-delta for every synced table

1. **`src/store/sync.ts`** — replace the three ad-hoc `*AppliedAt` fields with a generic `appliedAt: Partial<Record<TableName, number>>` (or add the four missing fields), bumped per-table in `onApplied` (`~249`) for EVERY table, not just the three. Keep the existing three working (062/067/072 subscribers). Reset in `resetSyncStore`.
2. **`src/store/dimensions.ts`, `contexts.ts`, `parameters.ts`** (and for completeness+parity, `tier1.ts`, `tier2.ts`) — after `load()`, subscribe to `useSyncStore` and re-run `load()` when this store's table signal changes, mirroring **072's projects wiring** (`src/store/projects.ts` module-level `syncUnsubscribe` in `init()`) and `PendingInvitations.tsx:70-84`. Unsubscribe on the store's reset/teardown. A parameters store keyed per-dimension must re-load the affected dimension(s) on a `parameters` (or `dimensions`) delta.
3. **`src/components/DesignSurface.tsx:80-115`** — ensure the mount-keyed `load()` effects re-run (or rely on the stores self-refreshing) when the applied signal changes, so a delta arriving after mount renders.

## Fix — Part 2 (A, only if the race is confirmed manifesting): retry FK-failed batches

Add a **bounded reconcile-retry in the sync orchestration** (NOT by weakening `applyInboundDeltas`'s per-batch atomicity): when a table's `applyInboundDeltas` throws (FK violation), buffer those deltas (in `store/sync.ts` or `syncEngine.ts`) instead of only setting `hasError`; after each subsequent successful apply of ANY table, drain-retry the buffer (re-run `applyInboundDeltas` on buffered deltas). Converges once the parent lands. Cap/backoff so a genuinely-orphaned row (never satisfiable) surfaces a real error after all shapes are up-to-date rather than looping. Keeps `db/sync.ts`'s transaction semantics intact.

## Test-first plan (red first)

**Part 1 (B):**
- `src/store/dimensions.test.ts` / `contexts.test.ts` / `parameters.test.ts`: after `load()` resolves, a simulated `onApplied('dimensions'|'contexts'|'parameters', …)` signal (bump the store field) causes the store to re-read PGlite and reflect newly-inserted rows — **red today** (no wiring). Include tier1/tier2 equivalents if wired.
- `src/store/sync.test.ts`: `onApplied('dimensions', …)` bumps the dimensions applied signal (mirror the invitations test) — red today.

**Part 2 (A):**
- `src/db/sync.test.ts` (or a sync-engine test): applying a `parameters` batch whose referenced `dimensions` row is not yet present currently throws/rolls back (red, proves the race); after the retry fix, the parameters deltas buffer and apply successfully once a subsequent `dimensions` apply lands the parent.

Standing gate: `npm run verify:fast` green.

## Dependencies / ordering / notes

No schema change, no migration. Part 1 (B) is the clean, necessary fix (072 pattern generalized) — do first, deploy, re-smoke. If Design still empty (rows dropped on apply), Part 2 (A) is required. Interaction: 072 solved this exact class (FK-drop + missing refresh) for `projects` only; this generalizes both halves. Unblocks the two-user sharing test (an invitee's Design content streams through the same path).

(Also still open, lower priority: the `409`/`electric-handle`-header-stripping console warning — a CDN/header item, does not correlate with these render failures; the RLS-no-op + tenant-context-key follow-up is issue 076 now.)

## Implementation notes (Part B, shipped)

`src/store/sync.ts` got six new per-field applied signals (`dimensionsAppliedAt`, `parametersAppliedAt`, `contextsAppliedAt`, `bindingsAppliedAt`, `tier1AppliedAt`, `tier2AppliedAt`) alongside the existing three — `tier1AppliedAt` bumps for either `tier1_purpose` or `tier1_props`, `tier2AppliedAt` for either `tier2_tables` or `tier2_entries` (both pairs are always reloaded together by their own store's `load()`, so one combined signal per pair is enough; the field's own doc comment explains why). `dimensions.ts`/`contexts.ts`/`parameters.ts`/`tier1.ts`/`tier2.ts` each subscribe inside their own `load()` (re-subscribing rather than stacking listeners on re-load, unsubscribing on their own `reset*Store()`), mirroring 072's `projects.ts` template exactly. `contexts.ts` reloads on either `contextsAppliedAt` or `bindingsAppliedAt` (one `readCanvas()` read covers both); `parameters.ts` re-reads every currently-tracked dimension, each still guarded by its own per-dimension generation counter. `DesignSurface.tsx` needed no changes — its existing `useEffect` that loads parameters per dimension already re-runs when the (self-refreshing) `dimensions` array reference changes. All re-reads reuse each store's existing generation guard (or, for `dimensions.ts`, only ever touch the `dimensions` field, never `editingId`), so an in-progress local edit or open name editor is never clobbered by a delta-triggered reload landing mid-gesture.

Standing risk (unchanged from before this fix, not introduced by it): `dimensions.ts` has no generation guard at all (unlike contexts/parameters/tier1/tier2), so a delta-triggered reload racing a slow in-flight mutation could in principle be overwritten by an even-later reload — the same pre-existing race class every `dimensions.ts` caller has always had, just with one more caller now. Not addressed here (would be a structural change out of Part B's scope); flagged for a follow-up if it ever manifests.

**References**: `src/store/sync.ts:236-253` (onApplied signals), `src/store/projects.ts` (072's `syncUnsubscribe` refresh template), `src/components/PendingInvitations.tsx:70-84` (062 refresh template), `src/store/{dimensions,contexts,parameters,tier1,tier2}.ts` (load-once, unwired), `src/components/DesignSurface.tsx:80-115` (mount-keyed loads), `src/db/sync.ts:34-196` (apply + `DEFERRED_FK_COLUMN`), `src/sync/syncEngine.ts:83-103` (per-table independent streams, no cross-table ordering), `src/db/schema.ts:196,211-213,264-272` (the forward FKs).
