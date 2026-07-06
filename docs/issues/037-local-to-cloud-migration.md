# 037: Local → cloud project migration (the on-ramp)

- **Status**: OPEN
- **Milestone**: M10 (Collaboration polish)
- **Blocked by**: 033 (auth), 034 (workspaces), 032 (sync)

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

- [ ] A local project can be moved into a workspace in one gesture, structure-preserving, atomic, with the local copy safe until the mirror is confirmed.
- [ ] Envelope bumps to `formatVersion:2` (+`workspace_id`); v1 envelopes remain importable.
- [ ] Reuses 015's serializer/importer (no parallel path); `npm run verify` green.
