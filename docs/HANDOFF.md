# HANDOFF — 2026-07-12 (read-path persistence thread)

For the next agent. Read this → `docs/issues/README.md` → the relevant issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public, `main`). Live at **https://d1nzod71m3rz6x.cloudfront.net** (AWS `975049998516`, `us-east-1`). **Deploy = push to `main`** → CI `verify.yml` → `deploy.yml` runs `cdk deploy --all -c debugApi=true`. Current live build: `index-CtFK4EI1.js`.

**The headline:** a tester's "shared project / content doesn't survive logout" turned out to be a **7-layer onion** in the Electric read/write path. **Six layers are fixed, deployed, and verified live; one remains (078).** The **write path is bulletproof** — content reliably reaches RDS (verified: 17/17 mutations `applied`, rows present via the 049 debug API).

| Layer | Issue | State |
| --- | --- | --- |
| Read-path never authenticated (`sync.start()`→`noAuth`) + no sign-in rehydrate | **068** | ✅ SHIPPED (200s, no 401s; projects rehydrate) |
| `/write` 502 — caller's workspace never provisioned in RDS (FK 23503) | **071** | ✅ SHIPPED (`/write` 200 `applied`, self-heals) |
| Streamed `projects` dropped on a local FK + no store refresh | **072** | ✅ SHIPPED (projects persist + render) |
| Domain content never enqueued to the write outbox (opt-in, 9/45 sites wired) | **073** | ✅ SHIPPED (all content writes → RDS) |
| Design-tier apply FK-race + no store refresh | **075** | ◐ shipped, but **blocked by 078** |
| ShapeProxy Lambda 15s timeout severed Electric's ~20s long-poll → 502 storm | **076** | ✅ SHIPPED (Timeout=30, 502s gone) |
| **Electric serves stale/empty shapes → content never materializes** | **078** | 🔴 **OPEN — the one remaining blocker** |

## THE remaining bug: 078 (read it first)

`docs/issues/078-electric-serves-stale-empty-shapes.md`. **Electric (the sync server) serves stale/empty cached shapes for some synced tables, non-deterministically** — so streamed content renders as empty (Design tier 3/3, Foundation/Architecture flaky). **Proven** via a temporary debug hook (`window.__gede`, see below): the rows are **not in local PGlite**, `appliedAt=0` (the client never received change messages), `hasError=false`, shape marked `upToDate` — i.e. Electric handed the client *empty data* while the rows sit in RDS. Everything **we** own is verified correct: publication has all 11 tables, `REPLICA IDENTITY FULL` (0012), auth/write-path/502-timeout all fixed. A manual Electric restart (`ecs update-service --force-new-deployment` on the sync service) clears the cache and temporarily fixes it → **recurs**.

**Next step (unrun):** check the logical-replication slot health (query in the 078 doc). Slot stuck/lagging → WAL-flow fix. Slot healthy → genuine Electric shape-cache consistency bug → force-fresh-shapes workaround (bust the shape cache from `src/server/shapeProxy`) or an Electric version/config change. **Not a client-code bug** — 075 and 077 are real fixes but neither resolves this (the client never gets the rows).

## Diagnostic assets — CLEAN UP when 078 closes
- **`src/main.tsx` `window.__gede` hook (commit `70a0bf4`)** — TEMPORARY, guarded by `?__introspect=1`. Live now. `window.__gede.query(sql)` reads local PGlite; `.syncState()` dumps hasError/appliedAt/upToDateTables. **Remove it.**
- **`src/sync/materialization.integration.test.ts`** — real-PGlite apply/race harness (from the 077 diagnosis). Keep as a regression asset; it proves 077's latent bug.

## Also open (not blockers)
- **055 (#8 sharing)** ◐ — chain 056–067 all shipped; the auth/provisioning/timeout bugs that secretly broke it are fixed & live; the two-identity smoke is unfinished because it hits the same **078** materialization wall.
- **077** — real latent bug (retry-drain whole-batch rollback on a child-canvas dimension) but PROVEN *not* the live smoke's cause (all smoke dims have `context_id: null`). Fix when convenient.
- **RLS is a no-op in prod** (write Lambda connects as the owner role; `app_user` has no login) + a tenant-context GUC key mismatch — flagged in `done/071`; file as its own issue when tackling security hardening.

## Non-negotiables (how to work)
1. **TDD, red first.** 2. **Deploy = push to `main`** (CI is the only path; `verify`→`deploy`). 3. **Schema only via migrations** (`0000`–`0014`; the 045 runner globs `src/db/migrations/*.sql`; Electric-synced tables need `REPLICA IDENTITY FULL`; adding a migration bumps the count in `deploy/cdk/test/migration-*.test.ts`). 4. **Verify subagent claims against the code** before trusting — done every time this session, caught a real drain-race bug. 5. **Verify LIVE, don't infer** — local-first PGlite makes same-browser tests a false positive; test cross-user in a separate browser profile and watch the server. 6. **Parallel subagents**: ≤2, `isolation: "worktree"`, disjoint file sets, skip the README edit (centralize it); overlapping/dependent work stays sequential in the main tree.

## Tooling
- **AWS MCP** (`mcp__aws-api__call_aws`) — authenticated to the account; CloudWatch is the fastest debugger (Write Lambda `…WriteApiFunction…`, ShapeProxy `…ShapeProxyFunction…`, Electric `…SyncContainerLogGroup…-iC9rDOPocc3x`).
- **049 debug API** (SELECT-only over the ALB): `TOKEN` = get-secret-value of the Api-stack `DebugTokenSecretArn`; `curl -H "x-debug-token: $TOKEN" http://<ALB DNS>/debug/db/counts` or `POST /debug/db/query {"sql":"SELECT …"}`. ALB DNS: `Gede-T-Alb16-7PG12HghU4Wa-1482490479.us-east-1.elb.amazonaws.com`.
- **The auto-mode classifier blocks mutating AWS + `git push` + secret-plaintext reads** — hand the user a `!` command for those (though `git push` has gone through directly some pushes this session).

## Docs map
`docs/SPEC.md` · `TECH_STACK.md` · `STYLE_GUIDE.md` · `SITEMAP.md` · `adr/` · `DEPLOYMENT.md §9` · `docs/issues/` (README = index; `done/` = shipped). Knowledge graph in `graphify-out/` (gitignored).
