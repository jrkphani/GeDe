# 078: Electric serves stale / empty shapes for some synced tables — streamed content never materializes (non-deterministic)

- **Status**: OPEN — **the current read-path blocker.** Root cause definitively characterized (below); fix is Electric-server-internals and not yet chosen.
- **Milestone**: M8 — sync read-path reliability (ElectricSQL)
- **Severity**: **Critical** — content is written to RDS and delivered when a shape is fresh, but Electric serves **empty** shapes for some tables in some sessions, so the client renders 0 rows. Design tier fails deterministically (its 4 tables are usually among the affected); Foundation/Architecture render flakily session-to-session. This is why the end-to-end persistence smoke still fails after 068/071/072/073/075/076 all landed.

## Definitive diagnosis (via a temporary in-build debug hook, `window.__gede`, commit 70a0bf4)

A live `?__introspect=1` session read the app's real local PGlite + sync store directly. Ground truth (project `SmokeTest-1783847004`, fresh context, Design empty, status bar "Synced"):

```
PGlite counts:  dimensions=0 parameters=0 contexts=0 bindings=0 tier2_tables=0 tier2_entries=0
                tier1_purpose=4 tier1_props=4 projects=6 workspaces=1
syncState:      hasError=false  pendingCount=0
  appliedAt:    dimensions=0 parameters=0 contexts=0 bindings=0 tier2=0   ← onApplied NEVER fired
                projects/tier1/members = real timestamps                  ← applied fine
  upToDateTables: ALL 11 (incl. the 6 empty ones)
```

Reading: for the 6 empty tables, **`onApplied` never fired** (`appliedAt=0`), there was **no error** (`hasError=false`), yet the shape is **up-to-date**. So the client didn't drop the rows on apply — it **never received any change messages** for those shapes this session (the shape delivered "up-to-date" with an empty snapshot). The client is behaving correctly on an empty shape; **Electric handed it empty data** despite the rows existing in RDS. Non-deterministic across sessions (which tables are empty varies).

## What this rules OUT (all verified correct / working live)

- **Not client apply/FK-race (072/075/077).** `appliedAt=0` + `hasError=false` means apply was never even attempted — nothing to roll back. 075/077's mechanisms require rows to *arrive*; they never did.
- **Not client store-refresh (075B).** The stores faithfully mirror PGlite (which is genuinely empty).
- **Not auth (068), write path (071/073), or the 502 timeout (076)** — all shipped & verified live; data is confirmed in RDS.
- **Not a publication gap.** `pg_publication_tables` shows all 11 tables in `electric_publication_default`; migration 0012 set `REPLICA IDENTITY FULL` on all of them.
- **Not stale client localStorage** — fresh browser contexts (empty localStorage) still hit it.

Electric's own container logs show **no shape-creation events** for the affected tables during the failing session → Electric **reused cached shapes** (didn't re-snapshot) and served their stale/empty contents. A **manual Electric restart** (`ecs update-service --force-new-deployment`) clears the cache and temporarily fixes it (done once this session, issue-040-era topology) — **but it recurs.**

## Suspected mechanism (not yet confirmed) & next diagnostic

Electric caches shapes (keyed by table + WHERE + params) with a materialized snapshot + a WAL-driven log. A shape created when the table was empty (an earlier session) whose log then didn't receive the later inserts stays empty. The open question: **is Electric's logical-replication slot healthy and current, or stuck/lagging** so WAL inserts never reach the cached shapes?
- **NEXT (unrun):** `SELECT slot_name, active, wal_status, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag FROM pg_replication_slots` via the 049 debug API. Slot inactive / large lag → WAL-flow problem (fixable: slot/`wal_level`/Electric restart-on-deploy). Slot healthy → genuine Electric shape-cache consistency bug (needs an Electric version/config change or a force-fresh-shapes workaround).

## Candidate fixes (choose after the slot check)

1. **WAL/slot fix** if the slot is unhealthy (most desirable — a real config bug).
2. **Force-fresh-shapes** — bust Electric's shape cache (e.g. a rotating element in the shape request from `src/server/shapeProxy`, or a shape-cleanup on deploy) so a session always gets a current snapshot. Trades caching efficiency for correctness.
3. **Automated Electric cache-clear** (restart-on-deploy / periodic) — operational band-aid, not a real fix.
4. **Electric version upgrade** if this is a known upstream shape-consistency bug.

## Downstream impact / dependencies

Blocks the end-to-end content-persistence smoke, **055 (#8 sharing)** (an invitee's shared project streams through this same path), and the "does content survive logout" acceptance for 073/075. 075 and 077 remain correct latent fixes but neither resolves this.

## Diagnostic assets to CLEAN UP once closed

- **`src/main.tsx` `window.__gede` debug hook (commit 70a0bf4)** — TEMPORARY, guarded by `?__introspect=1` / `VITE_DEBUG_INTROSPECT`. **Remove when 078 is closed.**
- **`src/sync/materialization.integration.test.ts`** — real-PGlite integration harness (from the 077 diagnosis); keep as a regression asset.

**References**: `src/sync/syncEngine.ts` (client apply/subscribe — correct), `src/store/sync.ts` (appliedAt signals, `upToDateTables`), `deploy/cdk/lib/api-stack.ts` (Electric ECS task/env, ShapeProxy), migration `0012_electric_replica_identity.sql`, the 049 debug API (`/debug/db/query`).
