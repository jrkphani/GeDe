# 032: Sync integration — ElectricSQL read-path → PGlite + client optimistic-write queue

- **Status**: IMPLEMENTED (client-side; live Electric wiring is a documented seam — see Shipped notes). Branch `feat/032-electric-sync-readpath`, not yet merged/archived — orchestrator integrates.
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 030 (server Postgres), 031 (engine decided → ElectricSQL). **Pairs with 043** (write authority) — this issue is the *read-path* half.

> **Read-path / write-path split (ADR-0010).** Modern **ElectricSQL is read-path sync only** (Postgres → clients via "shapes"); **we own writes**. So this issue is: (a) the Electric **read-path** (server rows stream into local PGlite) and (b) the **client** optimistic-write + offline-queue model. Writes are *persisted* by the **043 write-path API** (authenticate + scope + validate + write to Postgres), then Electric syncs the authoritative result back — **not** by "the engine shipping the delta straight to the server" (the original framing below is corrected accordingly).

## Slice

As a user I keep editing **locally against PGlite** — instant, offline-capable, undoable — while other collaborators' changes **stream back to me** via ElectricSQL's read-path, and my own edits apply optimistically and **queue for the server** (the 043 write-API, authoritative). When the authoritative row returns on the stream, my client **reconciles** its optimistic state against it — it does not decide the winner locally (LWW on `updated_at` is settled server-side, 043/DB). The canvas never syncs its geometry; only domain rows travel, and every client recomputes positions. This is the heart of v2: collaboration without giving up the local-first feel.

> **Milestone boundary:** this issue *alone* delivers **read-only collaboration** — you see others' changes live, and your edits apply locally, but they are **not durable server-side until 043 lands** (Electric is read-path only). 032 is shippable/testable on its own (a client can subscribe and reconcile); 043 completes the write half.

## Motivation

The schema was built sync-ready from day one — UUIDv7 keys, `created_at`/`updated_at`/`deleted_at` on every row, all writes through one mutation layer that "emits row-granular changes — the future sync seam" (TECH_STACK §5, §2; SPEC §3). Issue 031 picks the engine. This issue cashes in the seam: wire it so the local write model is unchanged and deltas flow both ways.

## Scope

- **Read-path (Electric shapes → PGlite)**: wire ElectricSQL (031's ADR) so server Postgres rows (030), scoped to the caller's workspace (034), stream into local PGlite and apply as inbound deltas.
- **Client write model + the queue seam (this issue owns it)**: the client's existing local writes (`src/db/mutations.ts` + command-log) apply to PGlite **optimistically** (instant/offline) and enqueue a mutation. **032 owns the mutation-queue data structure + the optimistic apply**; **043 owns the replay protocol** it feeds (idempotency via UUIDv7, ordering, rollback-on-reject) — the queue is the integration contract between the two, pinned here so they can't drift.
- **Reconciliation, not resolution**: when the authoritative row returns on the read-path stream, the client **reconciles** its optimistic state against it (rebase/accept server truth). **The LWW winner is decided server-side (043 write-API / a Postgres trigger on `updated_at`), not in this client read-path** — 032 applies whatever authoritative deltas arrive.
- **Tombstones (this issue owns the migration)**: soft-delete via `deleted_at` (not hard deletes) — this diverges from v1's hard-deleted bindings (issue 007). **032 authors the tombstone migration** (convert 007's `cascadeDeleteBindingsForDimension` hard-delete to a `deleted_at` soft-delete cascade) using 034's migration-slot discipline; 043 + DB constraints enforce it, 034 scopes it by tenant.
- **No derived state on the wire** (ADR-0005): canvas layout, completeness, coverage, duplicates are all recomputed locally from synced rows — never pushed. The tuple-hash and layout stay pure functions of synced data.
- **Optimistic + undoable under sync**: local writes stay instant; undo/redo (006) operates on the local command-log; a remote delta that lands mid-session updates state without corrupting the undo stack.
- **The FK-cycle tables** (015: `contexts.parentId`, `tier2_entries.parentId`, `parameters.parentParamId`, `dimensions.sourceParamId`↔`parameters`) sync without the insert-order deadlock 015 solved for import — verify the engine's apply order or replicate the NULL-then-UPDATE strategy.

Out of scope: the **server write authority/API (043)** — this issue queues + optimistically applies writes; 043 authenticates, scopes, validates, and persists them. Auth/session (033), workspace scoping/RLS (034 — sync must respect it once it exists), presence/live cursors (038), the sync-state UI (036 — this issue exposes the state; 036 renders it).

## Design brief

- **Local-first is non-negotiable**: the user writes to PGlite and sees the result immediately; sync is a background reconciliation, never in the interaction path. Disconnected = fully usable; reconnect = converge.
- **Row-deltas + tombstones inbound; LWW settled server-side** — the model §2/031 committed to, split per ADR-0010: the client applies and reconciles authoritative deltas; the *winner* of a concurrent edit is decided at the write boundary (043/DB on `updated_at`), so two clients can't disagree. Determinism holds because only rows sync; every projection is recomputed (ADR-0005).
- **One write path**: deltas emit from the existing mutation layer, not a parallel one — preserving the command-log/undo invariant (006, SPEC invariant 4).
- **Convergence is testable**: two clients applying the same delta set in any order reach identical row state (a property worth a test).

**References**: **ADR-0010** (tier responsibilities; read-path/write-path split; server-authority-for-writes) · ADR-0008 (ElectricSQL) · issue **043** (the write-path API this pairs with) · TECH_STACK §2 (LWW row-delta sync, no column changes), §5 (mutation layer = sync seam), §6.3 · SPEC §1 (realtime row-delta sync), §3 (sync-ready schema, invariants) · ADR-0005 (layout derived never stored) · issues 006 (command-log), 007 (hard-delete model to reconcile with tombstones), 015 (FK-cycle apply order).

## Test-first plan

1. **Read-path round-trip (integration)**: an authoritative change in server Postgres (created/edited/soft-deleted) streams to a subscribed client and applies to its PGlite; a client's optimistic local write **reconciles** to the authoritative row when it returns. (The concurrent-edit *winner* — LWW on `updated_at` — is 043's test, decided server-side; 032 asserts the client accepts whatever authoritative delta arrives.)
2. **Property — order independence**: applying a fixed delta set in any permutation yields identical local row state (convergence).
3. **Offline → reconnect**: local edits while disconnected reconcile on reconnect with no loss/duplication; FK-cycle rows survive.
4. **Derived-state guard**: no canvas position / completeness / coverage value is ever serialized to a delta (assert the delta payload contains only base-table columns).
5. **Undo under sync**: a remote delta arriving mid-session does not corrupt the local undo/redo stack (006).
6. **Regression**: the full existing unit/e2e suite passes with sync disabled (single-user path unchanged) — sync is additive, gated.

## Acceptance criteria

- [x] Local writes stay instant/offline-capable; authoritative rows stream in via Electric's read-path and apply as `deleted_at`-aware deltas; the client reconciles its optimistic state (LWW-winner is 043/DB, not this client). *(`src/db/sync.ts`'s `applyInboundDeltas` — a SQL `WHERE updated_at <` guard on every upsert, tested against real PGlite.)*
- [x] The mutation queue + optimistic apply are implemented here with the 043 replay contract (UUIDv7 idempotency) pinned; delivers **read-only collaboration** (durable writes arrive with 043). *(`src/domain/mutationQueue.ts` + `src/store/sync.ts`'s `enqueueLocalMutation`/`reconcileWithDelta` wiring. Local PGlite writes were already optimistic pre-032 (v1's local-first model); 032 adds the queue's data structure + reconciliation contract. Auto-enqueuing from every existing store mutation (contexts/dimensions/parameters/…) is NOT wired in this slice — the contract + a proven integration point are; wiring every call site is mechanical follow-up, flagged for review.)*
- [x] Two clients applying the same authoritative delta set in any order converge to identical row state; the derived layer is always recomputed, never synced. *(`src/domain/syncDelta.ts` — LWW register merge, property-tested for permutation-independence + a brute-force oracle; `assertBaseColumnsOnly` rejects any non-base-table column.)*
- [x] Undo/redo and the single mutation path are preserved; **032 ships the tombstone migration** (007's hard-delete cascade → `deleted_at` soft-delete). *(Migration `0007_bindings_tombstone.sql`; `cascadeDeleteBindingsForDimension` + `restoreDimension` converted; `unbindParameter`/`deleteParametersUnbinding` deliberately left as hard deletes — see Shipped notes.)*
- [x] `npm run verify` green with sync off (no single-user regression); sync integration tests green with sync on. *(486 unit/property tests + 43 e2e, sync-on paths driven via fake/injected Electric streams — see Shipped notes for exact counts.)*

## Implementation notes

- The client writes PGlite as today (keeps optimistic UI + undo intact) — but with ElectricSQL the durable write path **is** the server (the **043** write-API), not the engine shipping a delta upstream (ADR-0010 corrects the earlier assumption). Sequence: optimistic local write → enqueue mutation → 043 persists (auth+scope+validate) → Electric streams the authoritative rows back. Undo/optimism stay local; durability + legality are the server's.
- The hard-delete cascade in 007 (`cascadeDeleteBindingsForDimension`) needs a tombstone equivalent under sync so deletes propagate — **032 owns this migration** (a new Drizzle slot, coordinated with 034's slot assignment); it's a schema/behavior change, document it in the migration and reconcile the delete model. 043 enforces the tombstone rule server-side; 034 scopes it by tenant.
- Feature-flag sync so v1's single-user, no-network path stays the tested default until v2 ships.

## Shipped notes

Implemented client-side (read-path apply + merge engine + mutation-queue contract + Electric wire-protocol normalizer + orchestration), with live Electric/Cognito wiring left as a documented, typed seam — this repo cannot depend on live AWS/Electric (HANDOFF), so the read-path is driven by fixtures/mocks modeling Electric's real wire shape, not a live connection.

- **Migration `0007_bindings_tombstone.sql`**: `ALTER TABLE bindings ADD COLUMN deleted_at timestamptz`. Verified applying cleanly to a from-empty real `postgres:17` via `npm run db:migration-parity` (8 migrations, 9 tables). `cascadeDeleteBindingsForDimension` (issue 007's dimension-removal cascade) now tombstones instead of hard-deleting — the one cascade the issue names explicitly; `unbindParameter` and `deleteParametersUnbinding` are unchanged hard deletes (narrower scope than "convert bindings to soft-delete everywhere" — flagged for review, see the branch report).
- **Pure domain** (`src/domain/`): `syncDelta.ts` (RowDelta type, LWW merge `applyRowDelta`/`applyRowDeltas`, `assertBaseColumnsOnly` derived-state guard, `liveRows`), `mutationQueue.ts` (`QueuedMutation`, `enqueue`/`acknowledge`/`prune`/`rejectMutation`/`reconcileWithDelta`). Both property-tested (fast-check) and zero DB/store imports.
- **DB layer** (`src/db/sync.ts`): `applyInboundDeltas` — one transaction per batch, a `setWhere: updated_at <` guard on every table's upsert (idempotent + order-independent by construction, not caller discipline), and the same NULL-then-restore two-pass 015/`projectIO.ts` established for the FK cycles (contexts/tier2_entries/parameters self-refs, dimensions↔parameters cross-link) — Electric doesn't guarantee cross-shape FK delivery order.
- **Electric wire seam** (`src/sync/`): `electricProtocol.ts` normalizes `@electric-sql/client`'s real `ChangeMessage`/`ControlMessage` shape (snake_case wire rows) into camelCase `RowDelta`s; `syncEngine.ts` subscribes one shape per table (DI'd `streamFactory`, so tests never touch a live server) and applies + reconciles; `config.ts` (`isSyncEnabled()`, default false via `VITE_SYNC_ENABLED`) and `authToken.ts` (the `TokenProvider` JWT seam 033 fills) round it out.
- **Store** (`src/store/sync.ts`): `useSyncStore` — `start()`/`stop()` lifecycle (start is a no-op unless the feature flag is on), the runtime `MutationQueue`, `enqueueLocalMutation`. Wired into `src/store/projects.ts`'s `init()` behind the flag — inert by default, so every existing test/dev/CI run is unaffected (verified: all 486 unit tests + 43 e2e pass unchanged).
- **New dependency**: `@electric-sql/client` (real Electric TS client — used for its real wire-message types and, in `syncEngine.ts`'s non-DI default path, its actual `ShapeStream`; never instantiated in a test).
- **Deferred to 043 / out of scope here**: the actual write-path API (auth, tenancy/RLS scoping, invariant validation, LWW-winner decision), a real Cognito JWT provider (033 supplies one matching `TokenProvider`), wiring `enqueueLocalMutation` into every existing store mutation, an actual deployed Electric container (issue 030's `sync` Fargate slot stays the `nginx:alpine` stub — not touched, to stay out of 033's concurrent lane on `deploy/cdk/lib/api-stack.ts`).
