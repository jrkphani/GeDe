# HANDOFF — 2026-07-10 (sharing / collaboration thread)

For the next agent. Read this → `docs/issues/README.md` → the relevant issue. Everything else is reference.

## Where things stand

**Repo**: https://github.com/jrkphani/GeDe (public, `main`). Live at **https://d1nzod71m3rz6x.cloudfront.net** (AWS `975049998516`, `us-east-1`; push to `main` → CI `verify.yml` → `deploy.yml` runs `cdk deploy --all -c debugApi=true`).

**M11 (write loop) is long done and live** — a signed-in user's edits persist to RDS through the `/write` Lambda (issues 044–050; 051–054 bug-fixes archived). Details are historical now; see git log / `DEPLOYMENT.md §9a` if needed.

**The sharing bug (GitHub #8 / issue 055) is now FULLY BUILT, PUSHED & DEPLOYED LIVE — pending only a manual smoke.** A tester reported "invited users don't get the project." The 3-layered root cause was fixed across a 12-issue chain, all shipped, on `origin/main` (HEAD `abad346`), and live (build `index-gbTwbkZH.js`, Electric replicating, migrations through 0014):

| Issue | What | State |
| --- | --- | --- |
| 056/057/058 | write-path + membership-gated tenancy + Electric read-path | ✅ live |
| 060/061 | invitee accept/decline UI (`PendingInvitations`) + in-app notify / honest "Extend" relabel | ✅ live (email deferred — SES prod access) |
| 062 | invitations **stream** to invitees (email-scoped) — the real delivery fix | ✅ live |
| 063 | clear-on-sign-out (wipe local data) + redirect to the 064 hero | ✅ live |
| 064 | hero/landing page — `HeroLanding.tsx` (shadcn `login-05`), replaces Hero/LoginScreen | ✅ live |
| 065 | project-list clickable affordance (row opens; rename via revealed pencil/F2) | ✅ live |
| 066 | invitation revoke/decline/resend now sync to RDS | ✅ live |
| 067 | `workspace_members` streams (membership-scoped) → consistent Members list | ✅ live |

**THE ONE REMAINING STEP — a clean two-identity smoke.** Everything is deployed; nothing else is coded. **GitHub #8 stays OPEN and 055 stays "◐ partial" until** this passes: a real invitee, in a **separate browser profile** (empty local PGlite — same-browser "it works" is a local-data illusion, the trap that hid 062/066/067 earlier), signs in → sees the **Invitations badge** → clicks **Accept** (confirm server-side: `workspace_members` **+1** via the 049 debug API + the invitee's shape request in Electric's CloudWatch logs) → the project streams in → the Members panel is consistent → **sign-out clears local data + lands on the hero**. Then: **close #8**, flip 055 → resolved, `git mv docs/issues/055-*.md docs/issues/done/`, README row → ✅.

Local `main` == `origin/main` (all pushed). Electric runs at `desiredCount 1`.

## Non-negotiables (how to work)

1. **TDD, red first** — each issue has a Test-first plan; write those, watch fail, implement.
2. **Deploy = push to `main`** — CI is the only deploy path; never hand-`cdk deploy` (classifier blocks it anyway). `verify` (typecheck→eslint→stylelint→vitest→playwright) gates deploy.
3. **Schema only via migrations** (`0000`–`0014`; the 045 runner Lambda globs `src/db/migrations/*.sql` and applies to RDS on deploy). Electric-synced tables need `REPLICA IDENTITY FULL` (0012 base tables, 0013 `invitations`, 0014 `workspace_members`). Adding a migration bumps the count hardcoded in `deploy/cdk/test/migration-*.test.ts` — update those.
4. **Ship ritual**: Status→SHIPPED, `git mv` to `done/`, README ✅ row, one commit per issue.
5. **Parallel subagents need worktree isolation** — concurrent agents both `git add`/commit in the same tree and race (one commit bundles the other's files; README ship-ritual rows collide). Run ≤2 in parallel, each `isolation: "worktree"`, on disjoint file sets; **have them SKIP the README edit** (centralize it yourself) and cherry-pick each branch into `main` on completion. Dependent work (B needs A) stays sequential or runs in the main tree. Verify each subagent's claims against the code before trusting.
6. **Verify live, don't infer.** "Deployed" ≠ "works." Local-first data makes same-browser tests a false positive — for cross-user features test with a **separate browser profile** (empty local PGlite) and watch the server (049 debug API counts + Electric CloudWatch logs).

## You have an AWS MCP server (`mcp__aws-api__call_aws`) — use it
Authenticated to the GeDe account. CloudWatch logs are the fastest debugger (write Lambda group `…WriteApiFunction…`, Electric group `…SyncTaskDefSyncContainerLogGroup…`). Inspect RDS via the **049 debug API** over HTTPS: `TOKEN=$(aws secretsmanager get-secret-value --secret-id <DebugTokenSecretArn = Api stack output> --query SecretString --output text)`; `curl -H "x-debug-token: $TOKEN" https://…/debug/db/counts` (or `POST /debug/db/query {"sql":"SELECT …"}`, SELECT-only). Shell `aws` needs `AWS_PROFILE=phani-quadnomics`. The **auto-mode classifier blocks mutating AWS + `git push` + `gh variable set`** — hand the user a `!` command for those.

## Sharing architecture (current)
- **Read-path scope is server-side** (shape proxy, `src/server/shapeProxy/*`): the client never controls a shape's `table/where/params` (Electric has no per-request auth). `src/domain/syncScope.ts` = `SYNCED_TABLES` + per-table WHERE; scoped from the **verified JWT** — memberships for most tables (fail-closed on empty), `invitations` also by verified **email** (062), `workspace_members` membership-only (067).
- **Write-path** (`src/server/writeApi/*`): `checkTenancy` allows a non-own workspace only if `isMember` (057); `invitations`/`workspace_members` allow-listed (056). Client mutation ops are `upsert`/`update`/`delete` (`src/domain/mutationQueue.ts`) — use `update` for a bare column edit; `upsert`→`insert` (`ON CONFLICT DO NOTHING`) silently no-ops an edit to an existing row (066).
- **Invitee flow (complete)**: owner `invite()` → RDS (056); invitee's client streams the invite by verified email (062) → `PendingInvitations` badge (060) → Accept → seat mutation (057) → `refreshProjects` restarts read-path → project streams in (058); `workspace_members` streams so the Members list is consistent (067); revoke/decline/resend sync (066); sign-out wipes local data + redirects to hero (063).

## Gotchas paid for this session (don't rediscover)
- **Electric bring-up took 5 sequential deploy fixes**, all now guarded: (1) EC2 **SG descriptions** reject apostrophes/non-ASCII — a synth-time guard test (`deploy/cdk/test/security-group-descriptions.test.ts`) now catches it; (2) `npm ci` **ETIMEDOUT** on `onnxruntime-node`'s nuget GPU download → `ONNXRUNTIME_NODE_INSTALL=skip` set in both workflows; (3) swapping the sync ECS service in place fails ("container did not have port 80") → **rename the construct id to force replacement**; (4) new ALB **listener rules collide on priority** with the live ones (check `elbv2 describe-rules`; `/sync*`=20, `/write*`=30, `/debug`=40); (5) **Electric needs `wal_level=logical`** (RDS param group, static → needs reboot) — it was already active, so no reboot; stage new Electric at `desiredCount 0` if replication isn't confirmed, then scale up.
- **Pre-push hook flakes** on `src/domain/canvasLayout.test.ts`'s 40ms frame-budget assertion under load — just re-run `git push` (a follow-up should make it load-tolerant).
- **`cdk.out` scatter fills the disk** (~40–50 GB per deploy burst; ~87 GB cleared this session; ENOSPC freezes the shell — and once the disk is full even the Bash tool can't write its output file, so only a user `!` command can recover) — periodically `rm -rf "$TMPDIR"/cdk.out* /private/var/folders/*/*/T/cdk.out* deploy/cdk/cdk.out .claude/worktrees/*/deploy/cdk/cdk.out`.
- **Worktree agents branch from `origin/main` (last PUSHED commit), NOT local HEAD** — so unpushed work (incl. the agent's own issue doc) is missing from the worktree. **Push first** so origin is current before launching worktree agents on dependent code. Worktrees also lack `node_modules` (gitignored) — tell the agent to `ln -s <main>/node_modules node_modules` (and `deploy/cdk/node_modules`) before running verify. `git worktree list`/`prune` to see/clean them; the branch is `worktree-agent-<id>` (cherry-pick `-x` its commit). A shadcn/new npm dep added in a worktree lands in `package.json`/lock via cherry-pick but must be `npm install`ed into main's shared `node_modules` (CI's fresh `npm ci` is fine).
- **A subagent may misread its own harness reminders** ("date changed"/agent-types list) as file "prompt-injection" — verify the file (it's been clean every time); don't panic.
- (Earlier gotchas — `PgWriteStore` needs the live/SQL test not the fake pg client; `VITE_SYNC_ENABLED` gates both flush+read-path; Cognito custom attrs force pool replacement (use `workspaceIdForSub`); pin RDS CA bundle for node-`pg` TLS; OIDC deploy role can't `describe-stacks` (Cognito/`VITE_SYNC_URL` come from GitHub repo **vars**) — all still apply; see git history.)

## Docs map
`docs/SPEC.md` (domain+invariants) · `TECH_STACK.md` · `STYLE_GUIDE.md` · `SITEMAP.md` · `adr/` (0008 backend, 0009 Cognito, 0010 tiers) · `DEPLOYMENT.md §9` (v2 topology) · `docs/issues/` (README = index; `done/` = shipped). Knowledge graph in `graphify-out/` (gitignored; `/graphify --update` after big changes).
