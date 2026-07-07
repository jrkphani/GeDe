# 032: Sync integration — server Postgres ⇄ client PGlite (row-delta, LWW)

- **Status**: OPEN
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 030 (server Postgres), 031 (engine decided → ElectricSQL). **Pairs with 043** (write authority) — this issue is the *read-path* half.

> **Read-path / write-path split (ADR-0010).** Modern **ElectricSQL is read-path sync only** (Postgres → clients via "shapes"); **we own writes**. So this issue is: (a) the Electric **read-path** (server rows stream into local PGlite) and (b) the **client** optimistic-write + offline-queue model. Writes are *persisted* by the **043 write-path API** (authenticate + scope + validate + write to Postgres), then Electric syncs the authoritative result back — **not** by "the engine shipping the delta straight to the server" (the original framing below is corrected accordingly).

## Slice

As a user I keep editing **locally against PGlite** — instant, offline-capable, undoable — while my changes **sync as row-deltas** to the shared Postgres and other collaborators' changes stream back, merged **last-write-wins on `updated_at`**. The canvas never syncs its geometry; only the domain rows travel, and every client recomputes positions. This is the heart of v2: collaboration without giving up the local-first feel.

## Motivation

The schema was built sync-ready from day one — UUIDv7 keys, `created_at`/`updated_at`/`deleted_at` on every row, all writes through one mutation layer that "emits row-granular changes — the future sync seam" (TECH_STACK §5, §2; SPEC §3). Issue 031 picks the engine. This issue cashes in the seam: wire it so the local write model is unchanged and deltas flow both ways.

## Scope

- **Read-path (Electric shapes → PGlite)**: wire ElectricSQL (031's ADR) so server Postgres rows (030), scoped to the caller's workspace (034), stream into local PGlite and apply as inbound deltas.
- **Client write model**: the client's existing local writes (`src/db/mutations.ts` + command-log) apply to PGlite **optimistically** (instant/offline) and enqueue a mutation for the **043 write-path API** to persist server-side; the authoritative result returns via the read-path stream. (This issue builds the queue + optimistic apply; 043 is the server authority.)
- **LWW conflict resolution on `updated_at`**, soft-delete via `deleted_at` (tombstones, not hard deletes — note this diverges from v1's hard-deleted bindings, issue 007; reconcile the delete model here).
- **No derived state on the wire** (ADR-0005): canvas layout, completeness, coverage, duplicates are all recomputed locally from synced rows — never pushed. The tuple-hash and layout stay pure functions of synced data.
- **Optimistic + undoable under sync**: local writes stay instant; undo/redo (006) operates on the local command-log; a remote delta that lands mid-session updates state without corrupting the undo stack.
- **The FK-cycle tables** (015: `contexts.parentId`, `tier2_entries.parentId`, `parameters.parentParamId`, `dimensions.sourceParamId`↔`parameters`) sync without the insert-order deadlock 015 solved for import — verify the engine's apply order or replicate the NULL-then-UPDATE strategy.

Out of scope: the **server write authority/API (043)** — this issue queues + optimistically applies writes; 043 authenticates, scopes, validates, and persists them. Auth/session (033), workspace scoping/RLS (034 — sync must respect it once it exists), presence/live cursors (038), the sync-state UI (036 — this issue exposes the state; 036 renders it).

## Design brief

- **Local-first is non-negotiable**: the user writes to PGlite and sees the result immediately; sync is a background reconciliation, never in the interaction path. Disconnected = fully usable; reconnect = converge.
- **Row-deltas, LWW, tombstones** — the model §2 and 031 committed to. Determinism holds because only rows sync; every projection is recomputed (ADR-0005).
- **One write path**: deltas emit from the existing mutation layer, not a parallel one — preserving the command-log/undo invariant (006, SPEC invariant 4).
- **Convergence is testable**: two clients applying the same delta set in any order reach identical row state (a property worth a test).

**References**: **ADR-0010** (tier responsibilities; read-path/write-path split; server-authority-for-writes) · ADR-0008 (ElectricSQL) · issue **043** (the write-path API this pairs with) · TECH_STACK §2 (LWW row-delta sync, no column changes), §5 (mutation layer = sync seam), §6.3 · SPEC §1 (realtime row-delta sync), §3 (sync-ready schema, invariants) · ADR-0005 (layout derived never stored) · issues 006 (command-log), 007 (hard-delete model to reconcile with tombstones), 015 (FK-cycle apply order).

## Test-first plan

1. **Two-client round-trip (integration)**: client A creates/edits/soft-deletes a context → client B converges; and the reverse. `updated_at` LWW resolves a concurrent edit deterministically.
2. **Property — order independence**: applying a fixed delta set in any permutation yields identical local row state (convergence).
3. **Offline → reconnect**: local edits while disconnected reconcile on reconnect with no loss/duplication; FK-cycle rows survive.
4. **Derived-state guard**: no canvas position / completeness / coverage value is ever serialized to a delta (assert the delta payload contains only base-table columns).
5. **Undo under sync**: a remote delta arriving mid-session does not corrupt the local undo/redo stack (006).
6. **Regression**: the full existing unit/e2e suite passes with sync disabled (single-user path unchanged) — sync is additive, gated.

## Acceptance criteria

- [ ] Local writes stay instant/offline-capable; changes sync both ways as row-deltas with LWW on `updated_at` and `deleted_at` tombstones.
- [ ] Two clients converge to identical row state regardless of delta order; the derived layer is always recomputed, never synced.
- [ ] Undo/redo and the single mutation path are preserved; the delete model (hard vs tombstone) is reconciled and documented.
- [ ] `npm run verify` green with sync off (no single-user regression); sync integration tests green with sync on.

## Implementation notes

- The client writes PGlite as today (keeps optimistic UI + undo intact) — but with ElectricSQL the durable write path **is** the server (the **043** write-API), not the engine shipping a delta upstream (ADR-0010 corrects the earlier assumption). Sequence: optimistic local write → enqueue mutation → 043 persists (auth+scope+validate) → Electric streams the authoritative rows back. Undo/optimism stay local; durability + legality are the server's.
- The hard-delete cascade in 007 (`cascadeDeleteBindingsForDimension`) needs a tombstone equivalent under sync so deletes propagate — call this out as a schema/behavior change and migrate it.
- Feature-flag sync so v1's single-user, no-network path stays the tested default until v2 ships.
