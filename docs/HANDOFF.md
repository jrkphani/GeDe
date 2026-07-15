# HANDOFF — 2026-07-15 (read-path persistence + sharing thread — sharing CLOSED)

For the next agent. Read this → `docs/issues/README.md` → the relevant issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public, `main`). Live at **https://d1nzod71m3rz6x.cloudfront.net** (AWS `975049998516`, `us-east-1`). **Deploy = push to `main`** → CI `verify.yml` → `deploy.yml` runs `cdk deploy --all -c debugApi=true`. Current live build: `index-CtFK4EI1.js`.

**The headline:** a tester's "shared project / content doesn't survive logout" was a **multi-layer onion** in the Electric read/write path. **All layers are now fixed, deployed, and verified live — cross-user sharing (055/#8) works end-to-end**, confirmed in a live two-identity Playwright smoke: invite delivered → accepted → invitee joins (real `workspace_members` row) → sees the shared project's content → survives sign-out/in materializing from RDS. Write path is bulletproof; the read path materializes + persists.

| Layer | Issue | State |
| --- | --- | --- |
| Read-path never authenticated + no sign-in rehydrate | **068** | ✅ SHIPPED |
| `/write` 502 — caller's workspace never provisioned (FK 23503) | **071** | ✅ SHIPPED (self-heals) |
| Streamed `projects` dropped on a local FK + no store refresh | **072** | ✅ SHIPPED |
| Domain content never enqueued to the write outbox | **073** | ✅ SHIPPED |
| Design-tier apply FK-race + no store refresh | **075** | ✅ SHIPPED (verified once 078 landed) |
| ShapeProxy Lambda 15s timeout severed Electric's long-poll → 502s | **076** | ✅ SHIPPED |
| Electric served stale/empty shapes (experimental `allow_subqueries` shape churn) | **078** | ✅ SHIPPED (pin 1.7.7 + migration 0015 denormalized `workspace_id`, dropped the flag) |
| Email-scoped invite dropped on the client apply (no parent-workspace self-heal) | **079** | ✅ SHIPPED (`ensureWorkspaceStub` in all apply cases) |
| Accept rejected `cross_tenant` (guard needs the seat it would create) | **080** | ✅ SHIPPED (dedicated server-authoritative `/accept` endpoint) |

## How sharing was closed (the chain, for context)

`068`→`072`→`073`→`075`→`078` fixed single-user content materialization + persistence (see the 078 row above for its own two-step fix). Then the invitee side:
- **079** (`done/079`) — the email-scoped invite (062) reached the invitee's browser but was **dropped on the client apply**: `applyInboundDeltas`' `invitations`/`workspace_members` cases lacked the parent-`workspaces` self-heal `projects` got in 072, so a first-time invitee (no local `workspaces` row) hit a silent local FK violation. Fixed with a shared `ensureWorkspaceStub` wired into all three apply cases. Proven by a deterministic real-PGlite repro before the fix.
- **080** (`done/080`) — accepting was rejected `cross_tenant`: `checkTenancy` gates the `workspace_members` insert on a membership that only that insert would create. Fixed with a dedicated **server-authoritative `/accept` endpoint** (new CDK route + Lambda + CloudFront behavior) that verifies the JWT, validates the pending invite against the caller's **server-verified email** (fail-closed, TOCTOU-hardened `FOR UPDATE`), and atomically seats the member + stamps `accepted_at`. Verified live end-to-end.

## Still open / follow-ups (not blockers)
- **077** — real latent bug (retry-drain whole-batch rollback on a child-canvas dimension) but PROVEN *not* the live smoke's cause (all smoke dims have `context_id: null`). Real-PGlite repro in `src/sync/materialization.integration.test.ts` (kept as a regression asset). Fix when convenient.
- **RLS is a no-op in prod** (every Lambda connects as the `gede_admin` owner role; migration 0008's `app_user` has no login). Now more salient: **080's `/accept` is the SOLE authorization boundary for cross-workspace joins** — its own app-layer validation, no RLS backstop. Wiring a real `app_user` credential so RLS actually enforces deserves its own security-hardening issue. Flagged in `done/071` + `done/080`.
- **CDK-synth `/tmp` leak** — the `deploy/cdk` jest suite runs `cdk synth`, staging assets into `$TMPDIR/cdk.out*` (~63 MB each) and never cleaning up; a few `npm test` runs filled the disk twice this session. Worth a test-teardown or `TMPDIR` override.
- **081** (`081-tier1-existing-scenario-rich-text.md`) — new feature, documented not built: Tier 1 "Existing Scenario" rich-text field (Lexical). Foundation IA order: **Purpose → Existing Scenario → value architecture table**.

## Cleanup done this session
- **`window.__gede` debug hook removed** (`src/main.tsx`, `src/vite-env.d.ts`) now that 078/079/080 closed. `src/sync/materialization.integration.test.ts` kept as a regression asset.

## Non-negotiables (how to work)
1. **TDD, red first.** 2. **Deploy = push to `main`** (CI is the only path; `verify`→`deploy`). 3. **Schema only via migrations** (`0000`–`0014`; the 045 runner globs `src/db/migrations/*.sql`; Electric-synced tables need `REPLICA IDENTITY FULL`; adding a migration bumps the count in `deploy/cdk/test/migration-*.test.ts`). 4. **Verify subagent claims against the code** before trusting — done every time this session, caught a real drain-race bug. 5. **Verify LIVE, don't infer** — local-first PGlite makes same-browser tests a false positive; test cross-user in a separate browser profile and watch the server. 6. **Parallel subagents**: ≤2, `isolation: "worktree"`, disjoint file sets, skip the README edit (centralize it); overlapping/dependent work stays sequential in the main tree.

## Tooling
- **AWS MCP** (`mcp__aws-api__call_aws`) — authenticated to the account; CloudWatch is the fastest debugger (Write Lambda `…WriteApiFunction…`, ShapeProxy `…ShapeProxyFunction…`, Electric `…SyncContainerLogGroup…-iC9rDOPocc3x`).
- **049 debug API** (SELECT-only over the ALB): `TOKEN` = get-secret-value of the Api-stack `DebugTokenSecretArn`; `curl -H "x-debug-token: $TOKEN" http://<ALB DNS>/debug/db/counts` or `POST /debug/db/query {"sql":"SELECT …"}`. ALB DNS: `Gede-T-Alb16-7PG12HghU4Wa-1482490479.us-east-1.elb.amazonaws.com`.
- **The auto-mode classifier blocks mutating AWS + `git push` + secret-plaintext reads** — hand the user a `!` command for those (though `git push` has gone through directly some pushes this session).

## Docs map
`docs/SPEC.md` · `TECH_STACK.md` · `STYLE_GUIDE.md` · `SITEMAP.md` · `adr/` · `DEPLOYMENT.md §9` · `docs/issues/` (README = index; `done/` = shipped). Knowledge graph in `graphify-out/` (gitignored).
