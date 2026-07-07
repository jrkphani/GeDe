# 031: Sync-engine decision — ElectricSQL vs self-hosted Supabase (T6)

- **Status**: DECIDED (ARCHIVED) → **ElectricSQL** (see [ADR-0008](../../adr/0008-v2-backend-cdk-rds-electricsql.md))
- **Milestone**: M8 (Server & sync)
- **Blocked by**: — (a decision spike; unblocks 032)

> **Decided 2026-07-06 (ADR-0008).** Given the fixed CDK VPC + RDS topology (T5 → RDS), **ElectricSQL** was chosen over self-hosted Supabase: it syncs over our own RDS, fits the local-first PGlite model, and avoids self-hosting Supabase's full multi-container stack on the VPC. Auth → **better-auth**; RLS authored directly in Postgres. The decision was taken analytically against the fixed topology rather than by running the spike below; the spike plan is retained as the revisit procedure if Electric hits a blocking limit while 032 is built.

## Slice

As the team, before writing sync code, we **decide** how Postgres row-deltas reach the client and back — **ElectricSQL** or **self-hosted Supabase** — via a time-boxed spike against a throwaway copy of the real schema, and record the choice + rationale as an **ADR**. This is T6, deliberately deferred to v2 kickoff; it is a decision, not an implementation, so it must not be pre-empted by guessing.

## Motivation

TECH_STACK §1/§6.3 and T6 leave the sync engine open: "both open source, both Postgres-native; decide at v2 kickoff … both satisfy row deltas, LWW, no positions on the wire." Every downstream sync issue (032, 036) and part of auth (033, if Supabase) hinges on this. Choosing wrong is expensive; choosing blind is worse. This issue produces the evidence.

## Scope — evaluate against GeDe's actual constraints

Spike both against a **copy of the current schema** (the 9 tables, UUIDv7 keys, `created_at`/`updated_at`/`deleted_at`, the FK cycles that 015's importer already had to handle) and score:

- **Row-delta sync fidelity**: streams row-granular changes into client PGlite and back, LWW on `updated_at`, soft-delete via `deleted_at` — with **no derived layout on the wire** (SPEC/ADR-0005: canvas positions are recomputed, never synced).
- **The mutation seam fit**: how each hooks the existing single write path (`src/db/mutations.ts` + command-log, "the future sync seam", TECH_STACK §5) — ideally the client keeps writing locally to PGlite and the engine ships the delta, so undo/redo (006) and optimistic UI are unchanged.
- **Offline-first**: local writes while disconnected, reconnection reconciliation, and how conflicts surface (feeds 036).
- **RLS / multi-tenancy**: enforcing workspace isolation *at the sync boundary* (034) — Postgres RLS carries over per §2; which engine respects it cleanly.
- **Auth coupling**: Supabase bundles auth (affects 033); Electric leaves auth separate (better-auth). Score the whole-stack cost, not just sync.
- **Ops cost on a 2 GB Lightsail box** (030): memory/CPU footprint of each stack alongside Postgres + Caddy; upgrade/patching toil.
- **Licensing & portability**: both Apache-2.0; confirm no lock-in that violates the "portable off AWS unchanged" stance (§6.3).

Out of scope: building the real sync (032); auth implementation (033). This issue ends at a signed ADR + a discardable spike branch.

## Design brief

- **Decide with evidence, time-boxed**: a spike branch per option, each proving one context round-trips (create on server → appears in a second client; edit offline → reconciles on reconnect) against the real schema — not a toy table.
- **Bias to the invariants**: whatever keeps "layout derived never stored", one migration history, LWW row-deltas, and the existing local-write/undo model intact wins ties.
- **Record it**: the output is `docs/adr/00NN-sync-engine.md` — decision, the scored comparison, what would reverse it (the T6 revisit trigger).

**References**: TECH_STACK §1/§2 (Postgres-native sync), §6.3 (v2 stack), T6 (the open decision), T5 (Lightsail footprint) · SPEC §3 (sync-ready schema), §1 (workspace RLS + realtime row-delta sync) · ADR-0005 (derived layout never stored) · issues 006 (command-log/mutation seam), 015 (FK-cycle handling the sync engine must also tolerate), 030 (the server slot this fills).

## Test-first plan

*(A spike, so "tests" = the round-trip demos each option must pass to be scorable.)*

1. **Delta round-trip**: create/edit/soft-delete a context on server Postgres → the change appears in a connected client's PGlite (and vice-versa) with LWW on `updated_at`.
2. **Offline reconcile**: disconnect a client, make local edits, reconnect → deltas merge without loss or duplication (the FK-cycle columns from 015 survive).
3. **RLS at the boundary**: a client scoped to workspace A never receives workspace B's rows through the sync stream.
4. **Seam fit**: local writes still flow through `mutations.ts` + command-log; undo/redo (006) behaves unchanged under sync.

## Acceptance criteria

- [ ] Both engines spiked against a copy of the real schema; the four round-trip demos above scored for each.
- [ ] A signed **ADR** records the decision, the comparison, and the revisit trigger (T6).
- [ ] The chosen engine's service is specified precisely enough to fill the `sync` (and possibly `auth`) slot in 030's Compose stack.
- [ ] No production code merged from the spike — spike branches are discarded; 032 implements against the decision.

## Implementation notes

- Keep the spikes in throwaway branches/worktrees; the deliverable is the ADR, not merged code.
- If Supabase wins, 033 (auth) and part of 034 (RLS) may fold into it — note the knock-on scope in the ADR so those issues can be re-sized.
- Watch the determinism invariant: neither engine may push or persist canvas geometry; only the domain rows sync, positions recompute on the client (ADR-0005).
