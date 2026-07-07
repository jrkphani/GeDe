# 037: Local → cloud project migration (the on-ramp)

- **Status**: SHIPPED (unmerged — on `feat/037-local-to-cloud`, based on `feat/v2-collaboration-wave`/PR #7, not yet integrated)
- **Milestone**: M10 (Collaboration polish)
- **Blocked by**: 033 (auth), 034 (workspaces), 032 (sync)

## Implementation notes (2026-07-07)

- **Envelope v2 was already shipped by 034** — `FORMAT_VERSION` bumped to 2
  and `workspaceId`/`remapEnvelope(..., targetWorkspaceId)` already existed
  on this branch before this issue started. This issue's "Envelope v2" scope
  bullet is therefore already satisfied; nothing further was needed there.
- **Migration `0011_adopted_into_project.sql`**: adds `projects.adopted_into_project_id`
  (nullable, self-referencing FK to `projects.id`) — the idempotency marker:
  set on the SOURCE local project once adopted, pointing at the fresh-id copy
  in the destination workspace. Deliberately excluded from the envelope
  schema (`src/domain/projectEnvelope.ts`) — it's local-instance bookkeeping,
  not portable project content.
- **`src/db/projectIO.ts`**: `importProject` gained an optional 4th param
  (`ImportOptions.onInserted`) — a hook invoked inside the same transaction,
  after the deferred-FK second pass, before commit. `adoptProject(db,
  sourceProjectId, targetWorkspaceId)` reuses `gatherProjectRows` +
  `serializeEnvelope`/`parseEnvelope`/`importProject` on the SAME db
  (self-import into a different workspace) and uses `onInserted` to stamp the
  source row atomically — a mid-transaction failure rolls back the copy AND
  the stamp together. Idempotent for sequential calls (a project whose
  `adoptedIntoProjectId` is set short-circuits to the existing cloud copy).
- **`src/db/workspaces.ts`**: added `listWorkspacesForUser` and
  `getOrCreateUserWorkspace` — the signed-in "target picker" seam (ensures a
  signed-in sub has at least their own workspace, creating "My Workspace" on
  first use, mirroring `getOrCreateDefaultWorkspace`'s local-solo pattern).
- **No live write-path client exists anywhere in this repo yet** (HANDOFF:
  "deferred until the client queue actually flushes to /write" — 032's own
  optimistic-write queue is enqueue-only, no HTTP flush is wired for ANY
  mutation, not just this issue's). So "push through the sync/write-path"
  is implemented as: `src/store/projects.ts`'s `adoptProject` action enqueues
  every row of the newly-adopted copy onto `useSyncStore`'s existing
  `mutationQueue` (issue 032) exactly as a live write eventually will —
  this is the on-ramp's write-path integration point, ready for whenever
  032/043's client flush lands. This is a disclosed scope decision, not a
  gap unique to 037.
- **UI**: `src/components/AdoptProjectButton.tsx` — a per-row "Move to
  workspace…" gesture (account-gated like `WorkspaceMembers`), a `Combobox`
  target picker, and a status-bar confirmation (no modal). Once adopted, the
  row shows a quiet static "In workspace" label instead.

## Slice

As an existing single-user with projects in local PGlite, when I sign in I can **adopt a local project into a workspace** — it uploads once, becomes server-backed, and syncs from then on — without losing history or re-entering anything. The v1→v2 transition is a one-click move, not a manual re-key.

## Motivation

Every current user has data only in `idb://gede`. Auth (033) + workspaces (034) + sync (032) create the shared world, but there's no bridge from the local world into it. Issue 015 already built the exact bridge material — a versioned, deterministic, id-remapping **project envelope** — so this is a reuse, not a new serializer.

## Scope

- **Adopt flow**: from the projects list (signed in), "Move to workspace…" on a local project → serialize via 015's envelope → create the rows server-side in the chosen workspace (034's `workspace_id`) → the local project becomes a synced mirror (032).
- **Envelope v2**: 015's `formatVersion:1` gains `workspace_id` → `formatVersion:2`; keep v1 envelopes importable (remap into the target workspace) so old JSON backups still load (034 already flagged this).
- **Id strategy**: reuse 015's fresh-UUID bijection so the adopted project can't collide with existing server rows; preserve all FK/self-ref/cross-link structure (015's guarantee).
- **Idempotent + safe**: adoption is atomic (015's transactional import model); a failure leaves the local project untouched and offers the JSON export fallback (ADR-0006, the backup story).

Out of scope: bulk-adopting every local project at once (one at a time first), bidirectional "download a cloud project back to local" (revisit), merging a local project *into* an existing server project.

## Design brief

- **Reuse, don't rebuild** (015): the envelope, id-remap, and atomic transactional import already exist and are property-tested — extend them with `workspace_id`, don't write a parallel path.
- **Never lose local data**: adoption copies up; the local copy stays until the sync mirror is confirmed. The JSON export (015) remains the escape hatch at every step.
- **Calm, one gesture** (STYLE_GUIDE §9): "Move to workspace…" with the target picker; a status-bar confirmation, no modal wizard.

**References**: issue 015 (project envelope, id-remap, atomic import — the reused machinery + ADR-0006 backup note), 034 (`workspace_id`, default workspace), 032 (becomes a synced mirror), 033 (identity) · SPEC §3 (schema invariants) · STYLE_GUIDE §9.

## Test-first plan

1. Round-trip: a local project adopted into a workspace reproduces identically server-side (extends 015's round-trip property test with `workspace_id`).
2. v1 envelope compatibility: a `formatVersion:1` export still imports (remapped into the target workspace) under the v2 reader.
3. Atomicity: a mid-adoption failure rolls back server-side and leaves the local project intact.
4. Post-adopt: the adopted project then syncs (032) as a normal workspace project.

## Acceptance criteria

- [x] A local project can be moved into a workspace in one gesture, structure-preserving, atomic, with the local copy safe until the mirror is confirmed. (`adoptProject`, `AdoptProjectButton`; atomicity + "source untouched on failure" covered by `src/db/projectIO.test.ts`.)
- [x] Envelope bumps to `formatVersion:2` (+`workspace_id`); v1 envelopes remain importable. (Already shipped by 034; re-verified still covered by `src/domain/projectEnvelope.test.ts` / `src/db/projectIO.test.ts`.)
- [x] Reuses 015's serializer/importer (no parallel path); `npm run verify` green. (`adoptProject` calls `gatherProjectRows` → `serializeEnvelope` → `envelopeToJson` → `parseEnvelope` → `importProject`, the exact same path as the drag-drop export/import flow — no parallel machinery.)

**Deferred / disclosed** (see Implementation notes): the actual client→server HTTP write-path flush does not exist anywhere in this repo yet (per HANDOFF, out of scope for any issue until 032/043's queue-flush lands) — adoption's rows are enqueued onto the existing optimistic-write queue (032), ready for that flush, not yet delivered over the wire. Concurrent (overlapping, not sequential) double-adoption is guarded at the UI layer (busy-disable) rather than with DB-level row locking — sequential idempotency (the test-first plan's actual ask) is fully covered.
