# HANDOFF — 2026-07-10 (sharing / collaboration thread)

For the next agent. Read this → `docs/issues/README.md` → the relevant issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public, `main`). Live at **https://d1nzod71m3rz6x.cloudfront.net** (AWS `975049998516`, `us-east-1`; push to `main` → CI `verify.yml` → `deploy.yml` runs `cdk deploy --all -c debugApi=true`).

**M11 (write loop) is long done and live** — a signed-in user's edits persist to RDS through the `/write` Lambda (issues 044–050; 051–054 bug-fixes archived). Details are historical now; see git log / `DEPLOYMENT.md §9a` if needed.

**Active thread: the sharing bug (GitHub issue #8 / issue 055).** A tester reported "invited users don't get the project." Root cause was 3-layered; the fix is a multi-issue chain, mostly shipped & deployed, **not yet end-to-end-verified**:

| Issue | What | State |
| --- | --- | --- |
| 056 | invitation/member writes reach RDS | ✅ live (verified: `invitations` 0→1) |
| 057 | membership-gated tenancy + accept-seat | ✅ live |
| 058 | ElectricSQL read-path deployed | ✅ **live & replicating** (Electric 1.7.7, `electric_slot_default`) |
| 060 | invitee accept/decline UI (`PendingInvitations`) | ✅ deployed |
| 061 | in-app notify + honest "Extend" relabel | ✅ (email deferred — blocked on SES prod access) |
| 062 | invitations **stream** to invitees (email-scoped) | ✅ shipped `da4cbbe` (**pushed? NO — see below**) |
| 066 | sync invitation revoke/decline/resend | ⏳ in progress |
| 063 | clear-on-sign-out + redirect to 064 hero | ⏳ queued |
| 064 | hero/landing page (shadcn `login-05`) | ⏳ queued |
| 065 | project-list clickable affordance (UX) | ⏳ queued |
| 067 | stream `workspace_members` (consistent Members list) | ⏳ queued |

**055 is PARTIAL; GitHub #8 stays OPEN** until 063–067 land AND a **clean two-identity smoke** proves a real invitee (separate browser profile) accepts and receives the project.

**Unpushed commits exist on local `main`** (062 `da4cbbe` + 066/067 docs, and whatever 066/063/064/065/067 add). Plan: implement the queue, then **one combined push** → CI deploy → smoke → close #8. Electric is running at `desiredCount 1` (reconciled in CDK).

## Non-negotiables (how to work)

1. **TDD, red first** — each issue has a Test-first plan; write those, watch fail, implement.
2. **Deploy = push to `main`** — CI is the only deploy path; never hand-`cdk deploy` (classifier blocks it anyway). `verify` (typecheck→eslint→stylelint→vitest→playwright) gates deploy.
3. **Schema only via migrations** (`0000`–`0013`; the 045 runner Lambda globs `src/db/migrations/*.sql` and applies to RDS on deploy). Electric-synced tables need `REPLICA IDENTITY FULL` (migrations 0012/0013; 067 needs one for `workspace_members`).
4. **Ship ritual**: Status→SHIPPED, `git mv` to `done/`, README ✅ row, one commit per issue.
5. **Subagents SEQUENTIALLY on shared files** — concurrent subagents both `git add`/commit in the same tree and race. Parallelize only on truly disjoint files (worktree isolation) or serialize. Verify each subagent's claims against the code before trusting.
6. **Verify live, don't infer.** "Deployed" ≠ "works." Local-first data makes same-browser tests a false positive — for cross-user features test with a **separate browser profile** (empty local PGlite) and watch the server (049 debug API counts + Electric CloudWatch logs).

## You have an AWS MCP server (`mcp__aws-api__call_aws`) — use it
Authenticated to the GeDe account. CloudWatch logs are the fastest debugger (write Lambda group `…WriteApiFunction…`, Electric group `…SyncTaskDefSyncContainerLogGroup…`). Inspect RDS via the **049 debug API** over HTTPS: `TOKEN=$(aws secretsmanager get-secret-value --secret-id <DebugTokenSecretArn = Api stack output> --query SecretString --output text)`; `curl -H "x-debug-token: $TOKEN" https://…/debug/db/counts` (or `POST /debug/db/query {"sql":"SELECT …"}`, SELECT-only). Shell `aws` needs `AWS_PROFILE=phani-quadnomics`. The **auto-mode classifier blocks mutating AWS + `git push` + `gh variable set`** — hand the user a `!` command for those.

## Sharing architecture (current)
- **Read-path scope is server-side** (shape proxy, `src/server/shapeProxy/*`): the client never controls a shape's `table/where/params` (Electric has no per-request auth). `src/domain/syncScope.ts` = `SYNCED_TABLES` + per-table WHERE; scoped from the **verified JWT** (memberships; invitations also by verified email — 062). `workspace_members` still NOT streamed (067).
- **Write-path** (`src/server/writeApi/*`): `checkTenancy` allows a non-own workspace only if `isMember` (057); `invitations`/`workspace_members` allow-listed (056).
- **Invitee flow**: owner `invite()` → RDS (056); invitee's client streams the invite by email (062) → `PendingInvitations` badge (060) → Accept → seat mutation (057) → `refreshProjects` restarts read-path → project streams in (058). Gaps: revoke/decline don't sync yet (066), members list doesn't stream (067).

## Gotchas paid for this session (don't rediscover)
- **Electric bring-up took 5 sequential deploy fixes**, all now guarded: (1) EC2 **SG descriptions** reject apostrophes/non-ASCII — a synth-time guard test (`deploy/cdk/test/security-group-descriptions.test.ts`) now catches it; (2) `npm ci` **ETIMEDOUT** on `onnxruntime-node`'s nuget GPU download → `ONNXRUNTIME_NODE_INSTALL=skip` set in both workflows; (3) swapping the sync ECS service in place fails ("container did not have port 80") → **rename the construct id to force replacement**; (4) new ALB **listener rules collide on priority** with the live ones (check `elbv2 describe-rules`; `/sync*`=20, `/write*`=30, `/debug`=40); (5) **Electric needs `wal_level=logical`** (RDS param group, static → needs reboot) — it was already active, so no reboot; stage new Electric at `desiredCount 0` if replication isn't confirmed, then scale up.
- **Pre-push hook flakes** on `src/domain/canvasLayout.test.ts`'s 40ms frame-budget assertion under load — just re-run `git push` (a follow-up should make it load-tolerant).
- **`cdk.out` scatter fills the disk** (~49 GB this session → ENOSPC freezes the shell) — periodically `rm -rf "$TMPDIR"/cdk.out* /private/var/folders/*/*/T/cdk.out* deploy/cdk/cdk.out`.
- **A subagent may misread its own harness reminders** ("date changed"/agent-types list) as file "prompt-injection" — verify the file (it's been clean); don't panic.
- (Earlier gotchas — `PgWriteStore` needs the live/SQL test not the fake pg client; `VITE_SYNC_ENABLED` gates both flush+read-path; Cognito custom attrs force pool replacement (use `workspaceIdForSub`); pin RDS CA bundle for node-`pg` TLS; OIDC deploy role can't `describe-stacks` (Cognito/`VITE_SYNC_URL` come from GitHub repo **vars**) — all still apply; see git history.)

## Docs map
`docs/SPEC.md` (domain+invariants) · `TECH_STACK.md` · `STYLE_GUIDE.md` · `SITEMAP.md` · `adr/` (0008 backend, 0009 Cognito, 0010 tiers) · `DEPLOYMENT.md §9` (v2 topology) · `docs/issues/` (README = index; `done/` = shipped). Knowledge graph in `graphify-out/` (gitignored; `/graphify --update` after big changes).
