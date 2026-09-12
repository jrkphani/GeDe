# Decision log

One entry per decision that shapes the v2 build. Format: context, decision, consequences. Newest at the bottom. A decision is changed by a new entry that supersedes it, not by editing the old one.

Status key: **accepted** is in force; **superseded** points to the replacement.

---

## ADR-001 v1 scrapped and archived

**Status:** accepted, 2026-09-12

**Context.** v1 (Electric-sync PWA, Lambda behind an ALB, password-based Cognito pool, us-east-1) did not match the product described in the handover package: no lattice addressing, no CRDT document, no passwordless identity, GitHub Actions delivery. Retrofitting would have kept the wrong data model.

**Decision.** Tear down every v1 AWS resource, keep the final RDS snapshot for 30 days, branch the repository history to `archive/v1` (tag `v1-final`) and restart `main` from an empty tree with `docs/handover/` as the only carried-over content.

**Consequences.** Nothing from v1 is imported. The three external testers must register again on the new pool. History remains browsable for archaeology only.

## ADR-002 Monorepo layout with npm workspaces

**Status:** accepted

**Context.** The product has one SPA, one service, a CDK app and shared packages (domain, tokens, UI, schema). They must share TypeScript config, lint rules, one lockfile and one `verify` command that CodeBuild runs unchanged.

**Decision.** One repository, npm workspaces (`apps/*`, `services/*`, `packages/*`, `infra`), TypeScript project references, one ESLint flat config, one Prettier config, one Vitest workspace. Each package with its own conventions carries a `CLAUDE.md`.

**Consequences.** `npm run verify` at the root is the single gate. A change to `packages/core` is typechecked against every consumer in the same run. No package is published; all are `private`.

## ADR-003 Production only; staging is one `addStage`

**Status:** accepted

**Context.** Nine named users and one operator. The handover pipeline diagram has staging → manual approval → production.

**Decision.** Deploy a single `Prod` stage from `main`. Keep the `ManualApprovalStep` in the pipeline code, commented out, and make `GedeStage` parameterised so a `Staging` stage is one more `addStage` call.

**Consequences.** Every merge to `main` is a production deploy; PR review is the gate. Cost stays at one ALB, one RDS, one task. Adding staging later doubles the compute lines and needs its own subdomain and Cognito pool.

## ADR-004 Domain `gede.work`

**Status:** accepted

**Context.** The handover named `gede.1cloudhub.com`, a subdomain of a zone this account does not control. Passkeys bind to a relying party id, and ACM validation and Route 53 records are simplest inside one account.

**Decision.** Register `gede.work` through Route 53 Domains in account 975049998516 (US$14/yr, auto-renew, privacy). Web at the apex, `ws.` for WebSocket, `api.` for the smoke test. The WebAuthn RP id is `gede.work`.

**Consequences.** Passkeys must only be tested on `https://gede.work`. The ICANN registrant email must be verified within 15 days of registration or the domain is suspended.

## ADR-005 Sign in with Apple behind a flag

**Status:** accepted

**Context.** The PRD (AUTH-08) requires Sign in with Apple. Enabling it needs an Apple Developer team, a Services ID and a key that do not exist yet.

**Decision.** Wire the Apple identity provider in the Auth stack and the button in the SPA, both gated on CDK context `appleSignIn` (default `false`) which also flows into `config.json`. The secret lives at `gede/prod/apple-signin` when created.

**Consequences.** AUTH-08 is not satisfied in production until the flag is flipped; the runbook documents the steps. The button code follows Apple's rules from day one so flipping the flag changes nothing visual elsewhere.

## ADR-006 Alerts to `jrkphani@icloud.com`

**Status:** accepted

**Decision.** All CloudWatch alarms and the AWS Budget notify one SNS topic with one email subscription. No paging service.

**Consequences.** Alarm fatigue is the operator's problem to tune; thresholds are in `docs/ARCHITECTURE.md` §1.

## ADR-007 No NAT gateway

**Status:** accepted

**Context.** The sync task needs outbound reach to S3, Secrets Manager, Cognito JWKS and SES. A NAT gateway costs about US$33/month plus data, more than half the rest of the bill.

**Decision.** Place the Fargate task in a public subnet with a public IP. Its security group admits ingress only from the ALB security group. RDS stays in a private subnet reachable only from the task security group. S3 uses a gateway endpoint.

**Consequences.** Monthly cost about US$62 instead of US$95. The task's public IP is not reachable on any port other than what the security group allows (none from the internet). If policy later requires private subnets, adding NAT changes nothing else.

## ADR-008 Node 22 and PostgreSQL 17

**Status:** accepted

**Context.** The handover named Node 20 and PostgreSQL 16. Node 20 reached end of life in April 2026.

**Decision.** Node 22 everywhere (`.nvmrc`, `engines`, CodeBuild image, `node:22-alpine` in the Dockerfile). RDS PostgreSQL 17 on Graviton.

**Consequences.** Same schema and wire protocol as the spec assumed. Aurora Serverless v2 (growth step 2) supports 17.

## ADR-009 Keep the v1 RDS final snapshot and the us-east-1 CDK bootstrap

**Status:** accepted

**Decision.** The teardown's CloudFormation `SNAPSHOT` policy produces the only durable copy of v1 data; keep it, tagged `Purpose=v1-final-backup`, and delete manually after 30 days. Keep `CDKToolkit` in us-east-1 because the Edge stack (CloudFront certificate, WAF) must deploy there anyway.

## ADR-010 WebSocket direct to the ALB, REST through CloudFront

**Status:** accepted

**Context.** CloudFront's WebSocket idle timeout is 60 s and cannot be raised. A y-websocket room expects a connection to stay open for the length of an editing session.

**Decision.** `wss://ws.gede.work` resolves to the ALB (idle timeout 3600 s). `https://gede.work/api/*` is a CloudFront behaviour to the same ALB so the WAF inspects every REST call.

**Consequences.** WebSocket traffic is not behind the WAF; the service enforces JWT verification and permission on every upgrade and message instead (SHARE-03). Two hostnames, one certificate in `ap-southeast-1` for the ALB and one in `us-east-1` for CloudFront.

## ADR-011 Passwordless Cognito with `USER_AUTH`

**Status:** accepted

**Context.** AUTH-01..10: no password is ever stored or accepted. Both the CDK L2 and the Cognito service require `PASSWORD` in the pool's sign-in policy, so passwordless must be enforced at the app-client level.

**Decision.** `featurePlan: ESSENTIALS`; pool policy `AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP, WEB_AUTHN]` (Cognito rejects a choice-based pool without PASSWORD — confirmed at first deploy, 2026-09-12); WebAuthn RP id `gede.work`, user verification required. The SPA client enables only `authFlows: { user: true }` (the `USER_AUTH` choice-based flow). The browser uses Amplify v6 `signIn({ options: { authFlowType: 'USER_AUTH' } })` with `EMAIL_OTP` or `WEB_AUTHN` as the preferred challenge.

**Consequences.** Tokens are held in memory only (AUTH-09). Account creation is implicit through email OTP. Email delivery uses Cognito's sender until SES leaves sandbox (see runbook).

## ADR-012 CodePipeline with CodeBuild ARM, no GitHub Actions

**Status:** accepted

**Context.** The PRD §21 forbids GitHub Actions and requires CodeBuild on ARM. The Docker image must be `linux/arm64`; building it natively avoids emulation.

**Decision.** One CDK `CodePipeline` (`GeDe`, ap-southeast-1) using `LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0` at `ComputeType.SMALL` for Synth, SelfMutate and Assets (privileged for Docker). Source is GitHub through a CodeConnections connection. Stages: Source → Synth → SelfMutate → Assets → Prod → Smoke. The only laptop deploy, ever, is the pipeline stack itself.

**Consequences.** `npm run verify` is what CodeBuild runs; if it is red locally it is red in CI. Bump to `MEDIUM` if a build exceeds about 20 minutes.

## ADR-013 Radix as the headless primitive

**Status:** accepted

**Context.** The design system requires a headless library for menus, dialogs, tabs, selects, switches and toasts, naming Radix explicitly with Ark and Base UI as alternates. A hand-rolled dropdown is a defect.

**Decision.** Radix UI primitives, wrapped once in `packages/ui` with tokens applied. Application code imports `@gede/ui`, never `@radix-ui/*`.

**Consequences.** Focus traps, roving tabindex, portal positioning, ARIA wiring and dismiss semantics come from Radix. The grid body and canvas objects are custom (Radix has no grid). Upgrading Radix touches one package.

## ADR-014 Yjs over Automerge

**Status:** accepted

**Context.** PRD §20 leaves the CRDT choice open between Yjs and Automerge. The service needs a wire protocol, the browser needs offline persistence, and presence (SHARE-04) needs an awareness channel.

**Decision.** Yjs. The service speaks the stock y-websocket protocol (sync + awareness) so the browser uses the unmodified `y-websocket` provider; `y-indexeddb` gives the local replica for LOAD-05/06; awareness carries user id, name, colour, selected cell and sheet. Rich text is `Y.XmlFragment`, which maps onto the ProseMirror schema through `y-prosemirror`.

**Consequences.** Persistence is an append-only update log plus snapshots; the relational projection is derived. Future multi-task fan-out follows the y-redis pattern (growth step 1).

## ADR-015 Vitest over Jest

**Status:** accepted

**Context.** The monorepo is ESM and TypeScript strict; Vite is already the web bundler.

**Decision.** Vitest with a workspace file at the root; jsdom for `apps/web` and `packages/ui`, node for everything else; `vitest bench` for the performance budgets in `packages/core`. Playwright for e2e.

**Consequences.** One test runner configuration, no Babel or ts-jest. Test names carry requirement ids and feed `docs/TRACEABILITY.md`.

## ADR-016 Runtime `config.json`

**Status:** accepted

**Context.** Cognito ids, the API base and the WebSocket URL are outputs of stacks deployed after the web bundle is built. v1 baked them in as `VITE_*` variables, which coupled the build to the environment.

**Decision.** The SPA fetches `/config.json` at startup. The Web stack writes it from stack outputs at deploy time (`BucketDeployment` with `Source.jsonData`). Locally it is copied from `config.example.json`. No `VITE_*` environment variables carry deployment values.

**Consequences.** One bundle serves any environment; a Staging stage needs no rebuild. The SPA shows the loading tier while the file loads and a 503 page if it cannot.

## ADR-017 CloudFront WAF, ops alarms and a budget from day one

**Status:** accepted

**Decision.** AWS managed rule groups on the CloudFront distribution; alarms on task CPU, ALB 5xx ratio and RDS free storage; an AWS Budget at US$100/month alerting at 80 %. All defined in the Ops and Edge stacks and deployed with the first pipeline run. The handover's snapshot-lag and WebSocket-reconnect alarms follow once the sync service emits those metrics.

**Consequences.** Roughly US$6/month for WAF. The guardrails in the handover capacity plan exist before the first user does.

## ADR-018 `/api` reaches the ALB only through CloudFront (origin-verify header)

**Status:** accepted — extends ADR-010

**Context.** The Wave 1 audit (#33) showed `https://api.gede.work/api/*` answering directly: the ALB is internet-facing because the WebSocket must bypass CloudFront's 60 s idle cap (ADR-010), so anyone could skip the WAF by calling the origin hostname. A regional WAF on the ALB would double the WAF bill and still leave two enforcement points to keep in sync.

**Decision.** CloudFront adds a secret `X-Origin-Verify` header to every `/api/*` origin request. The ALB's HTTPS listener is deny-by-default (fixed 403, JSON body) with two rules: `/ws/*` forwards unconditionally (the service verifies the JWT on the upgrade); `/api/*` and `/healthz` forward only when the header matches. The value is a Secrets Manager secret generated by the Web stack (64 alphanumeric characters — ALB header conditions treat `*` and `?` as wildcards) and referenced from both the CloudFront origin and the listener rule as a `{{resolve:secretsmanager:…}}` dynamic reference, so it never appears in a template, `cdk.out` or a log. Rotation is by generation: `ORIGIN_VERIFY_GENERATIONS` in `infra/lib/stacks/web-stack.ts` lists the secrets the ALB accepts and `ORIGIN_VERIFY_PRESENTED` names the one CloudFront sends. Because Web deploys before Service, presenting a generation in the same merge that adds it would leave the ALB refusing it for the whole Service deploy, so a rotation is three merges — add (`[1, 2]`), present (`2`), drop (`[2]`) — with no window in which the two sides disagree (runbook §12). The `api.gede.work` record stays: it is the CloudFront origin hostname and carries the ALB certificate. The Smoke step probes `https://gede.work/api/health` and asserts the bare origin answers 403.

**Consequences.** ServiceStack now depends on WebStack (it consumes the secret ARNs), so Web deploys before Service and the two no longer run in parallel; the origin hostname is still a string, so there is no cycle. Target-group health checks do not pass through listener rules, so the internal `/healthz` probe is unaffected; external `/healthz` is dead (use `/api/health`). The WebSocket remains outside the WAF, as in ADR-010; the rate-based rule (ADR-021) does not see it.

## ADR-019 Passwordless hardening: no account recovery, scoped attributes, rotating refresh tokens

**Status:** accepted — extends ADR-011

**Context.** Cognito refuses to drop `PASSWORD` from a choice-based pool's first factors (ADR-011), and the audit (#35) showed the remaining path: with `AccountRecovery.EMAIL_ONLY`, `ForgotPassword` + `ConfirmForgotPassword` on the public client let anyone with one-time mailbox access set a durable password on an account that was never meant to have one. The client also defaulted to reading and writing every attribute.

**Decision.** `accountRecovery: NONE` (renders `admin_only`; there is nothing to recover in an OTP/passkey pool). The SPA client reads `email`, `email_verified`, `name`, `given_name`, `family_name`, `locale` and writes the same minus `email_verified` — exactly what AUTH-03, the Apple mapping and services/sync use. Refresh-token rotation is on with a 30 s grace period (Amplify 6.20 stores the rotated token). The client keeps `ALLOW_USER_AUTH` only; the pool policy is unchanged.

**Consequences.** A user who loses every passkey and mailbox access has no self-service recovery; an operator uses `AdminSetUserPassword`-free paths (`AdminUpdateUserAttributes` to a new verified email, then OTP). `SignUp` with a `Password` is still accepted by Cognito — the password cannot be used to sign in through this client and cannot be reset, so it is inert; removing it entirely needs a pool-level change Cognito does not offer. Threat protection (`FeaturePlan.PLUS`) remains deferred on cost grounds. In-place update; no pool replacement.

## ADR-020 SPA fallback is a CloudFront Function, not custom error responses

**Status:** accepted

**Context.** Distribution-wide `errorResponses` (403/404 → 200 `index.html`) exist to serve deep links from the S3 origin, but CloudFront applies them to every behaviour, so `/api/*` authorization and not-found responses reached the browser as `200 text/html` (#38).

**Decision.** A `viewer-request` CloudFront Function (`gede-<env>-spa-router`, JS runtime 2.0) on the default behaviour rewrites any path whose last segment has no extension to `/index.html`. `/assets/*` and `/api/*` have no function; `errorResponses` is gone.

**Consequences.** API status codes pass through unchanged. A genuinely missing file with an extension now returns S3's own error (403 behind OAC) instead of the shell, which is the correct answer. Client-side routes must not contain a dot in their last segment (document ids are ULIDs; none do).

## ADR-021 Edge hardening and the review gate: CSP, three WAF groups, a rate rule, branch protection instead of a manual approval

**Status:** accepted — extends ADR-012 and ADR-017

**Context.** Items from #40 and #42: no Content-Security-Policy, a single WAF managed group, no rate limit, CodeBuild logs without retention, the ECS task role able to delete object versions and list the whole bucket, no ALB deletion protection, and a commented-out `ManualApprovalStep`. The audit also asked for base-image digest pins, an unprivileged Synth, and egress restriction.

**Decision.**

- **CSP** on both SPA response-headers policies: `default-src 'self'`; `script-src 'self'`; `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` (Radix sets positioning styles inline; the bundle has no inline scripts); `font-src 'self' https://fonts.gstatic.com`; `img-src 'self' data:`; `connect-src 'self' https://cognito-idp.<region>.amazonaws.com wss://ws.<domain>` plus the hosted-UI domain only when Apple sign-in is on; `worker-src 'self' blob:`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`. The `/api/*` behaviour has no response-headers policy and is unaffected.
- **WAF**: rate-based rule first (2000 requests per IP per 5 minutes, block), then `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `AWSManagedRulesAmazonIpReputationList`.
- **`/api/*` origin request policy** is `ALL_VIEWER_EXCEPT_HOST_HEADER`, so the service sees `Host: api.<domain>` rather than the viewer's.
- **Task role**: `s3:GetObject`/`PutObject`/`DeleteObject` on `docs/*` (a purge writes delete markers), `s3:ListBucket` with `s3:prefix` `docs/*`, explicit deny on `s3:DeleteObjectVersion`; no Secrets Manager grant (the execution role injects `PG*`; the service never calls Secrets Manager).
- **ALB `deletionProtection: true`**; **CodeBuild** logs to one group with 30-day retention; `.dockerignore` excludes `.claude/`, `**/.env*`, `.git`.
- **No manual approval step.** With a single Prod environment there is nothing to promote from and the merger would approve their own change; the gate is GitHub branch protection on `main` (PR, one review, `verify` green — runbook §13, applied by the owner with `gh api`). Re-enable the step when a Staging stage exists (ADR-003).

**Deferred, with reasons.** Base-image digest pins live in `services/sync/Dockerfile` (sync owner). Moving `db:parity` out of the privileged Synth project, egress restriction on the task (needs interface endpoints or NAT, ADR-007) and reading secrets at runtime instead of env injection are tracked in #40/#42. DB secret rotation is not required now: the credential is generated, never typed, and reachable only from the service security group.

## ADR-022 A least-privilege application role, bootstrapped by the migration runner

**Status:** accepted — closes #36

**Context.** The service and the nightly jobs task connected to RDS as the master user `gede_admin` (`rds_superuser`) and ran migrations with the same pool. Any app-layer bug became a superuser session: DDL, extensions, role management, dropping `doc_updates`.

**Decision.**

- **Two identities per task.** ECS injects the master secret as `PG*` and a second, generated secret `gede/<env>/db-app` (`{ username: gede_app, password }`, punctuation-free) as `PGAPPUSER`/`PGAPPPASSWORD`. Both task definitions (service and `gede-<env>-jobs`) get both.
- **The runner bootstraps the role, not a migration file.** `applyMigrations(pool, dir, { appRole })` runs a DO block as the master user under the existing advisory lock, after the ledger exists and before the first migration file: `CREATE ROLE … NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS` if missing; `ALTER ROLE … LOGIN … PASSWORD`; `GRANT CONNECT`, `USAGE` on `public`, `SELECT/INSERT/UPDATE/DELETE ON ALL TABLES`, `USAGE/SELECT ON ALL SEQUENCES`; `ALTER DEFAULT PRIVILEGES` for both so tables later migrations create are covered; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `REVOKE INSERT/UPDATE/DELETE/TRUNCATE ON __migrations`. Why not a migration: a migration runs once and is checksummed, but a password rotation, a hand-dropped role or a new table all need the grants re-applied; an idempotent step on every boot does that. The name and password reach the DO block through `set_config` bind parameters and `format('%I'/'%L')`, so no statement text carries the password.
- **The runtime pool is the app role.** `main.ts` opens a `max: 1` master pool for the migrations, ends it, then opens the runtime pool with `createPool(env, { as: appRole })`; it logs the user it connects as. Nothing the runtime does needs more than DML (`FOR UPDATE [SKIP LOCKED]`, `to_tsvector`, transactions); `pg.live.test.ts` runs the whole repository as the app role and `db:parity` asserts the role's privileges on postgres:17 before anything deploys.
- **Production fails loudly.** `appRoleFromEnv` throws when `NODE_ENV=production` and the app credentials are missing, and when only one of the two is set; the task exits 1 and the circuit breaker keeps the previous task definition. Locally (no `PGAPPUSER`) the runtime stays on the master user.
- **Rotation** is "put a new secret value, force a new deployment" (runbook §3): the next boot re-applies `ALTER ROLE … PASSWORD`.

**Consequences.** The RDS master user is `rds_superuser`, not a superuser, so `ALTER ROLE` must not mention `SUPERUSER`, `REPLICATION` or `BYPASSRLS` even negated; those are set at `CREATE ROLE` only and asserted by parity, which for that reason runs the bootstrap as a non-superuser CREATEROLE database owner rather than the container's superuser. Default privileges bind to the migrating role, so migrations must keep running as the master user (they do). A future runtime query that needs an owner privilege (`TRUNCATE`, `REFRESH MATERIALIZED VIEW`) fails in the live tests before it reaches a task; the answer is a grant in the bootstrap, not the master pool. Rotation has a window on the outgoing task (runbook §3): one role has one password, so the old task cannot open new connections between the new task's bootstrap and its own drain; a two-role (blue/green) rotation would close it and is not needed for a generated, never-typed credential today.

**Residual risk, deliberately accepted.** The master credentials stay in the task's environment (`PGUSER`/`PGPASSWORD`) for the life of the process, because the same process runs the migrations. A SQL injection or a leaked runtime session is now DML-only; a code-execution bug that reads the environment is not contained by this change. Closing that needs the migrations in a one-shot task with its own task definition (the master secret injected there only), tracked with the other runtime-secret work in #40/#42.

## ADR-023 Formula references are stored as ids inside the formula string

**Status:** accepted, 2026-09-13

**Context.** PRD §20 requires every §13/§14 reference to store ids, with A1 addresses as a presentation projection; the first cut of `wave2/formulas` bound references to the A1 text at evaluation time, so inserting a row above `=Sum(B6)` changed what it read. The formula string is the persisted contract (the `cells` map in the CRDT and `cells.formula` in Postgres), so the shape had to be right before merge. Options considered: (a) a parallel `refs` map or a `Y.Map` cell value, (b) Excel-style rewriting of the A1 text on every structural edit, (c) id-bound tokens inside the stored string.

**Decision.** (c). A formula cell stays a string starting with `=`, so `isFormula`, `setCellText`, undo, sync and the Postgres projection are unchanged, but every reference the person typed is bound once at commit (`commitCellText`, the only commit path for typed text) and written as a token: `{c:T:R:C}` cell, `{e:T:R:C}` cell spelled as an `@` path, `{r:T:R1:C1:R2:C2}` range (corner ids; the interior is whatever lies between them today), `{k:T:C|…}` lattice column (the table columns under it). Display projects the tokens back to A1/`@` from the current lattice, so a row inserted above shows `=Sum(B7)` and reads the same cell; a deleted target projects as `#REF` and evaluates to `⚠ reference removed`, and undo restores the binding. An address over empty canvas has no id and stays as typed (positional) until re-committed; an unknown `@` path likewise. The engine re-resolves only formulas bound into the edited table and re-evaluates only when the dependency set actually changed, so moves, wraps and renames evaluate nothing.

**Grammar and versioning.** The kind letter (`c`, `e`, `r`, `k`) is the grammar version: a new shape takes a new letter and an existing letter keeps decoding forever, so a document written today reads tomorrow without a migration; there is no separate version marker. A token typed or pasted by hand binds like any other (the grammar is the parser's, not a hidden one); inside quotes it is text. A range corner that reached past the table at commit is stored open-ended — `^` the table's first row or column, `*` its last — so `=Sum(B5:B20)` over a five-row table follows the table as rows come and go rather than drifting with the address.

**Placeholders.** A reference whose target is gone projects as `#REF`; one whose target exists but has no address (a hidden column) projects as `#hidden`. Both parse as placeholder references, and on commit each keeps, in order, the token the cell already held behind a placeholder, so opening `=Sum(#hidden)`, adding an operand and pressing Enter leaves the reference bound; a placeholder typed with no token behind it evaluates to `⚠ reference removed`.

**Consequences.** Structural edits never change what a formula reads. Two replicas converge on the same string. Ranges grow when a row is inserted inside them and not when one is inserted just outside (the PRD is silent; this matches the corner-id model and is pinned by tests). What remains positional — an address over empty canvas, a range with neither corner on a table, an unknown `@` path — is flagged in the outlines and the cell's badge as "not anchored" (A11Y-04: text, not hue) until re-committed. Find indexes and the server projects the _projected_ expression (`cells.text_plain`), never the tokens; `cells.formula` keeps the stored form. The projection index is rebuilt lazily per document on structural or label changes, never per keystroke.

## ADR-024 The formula expression line needs a wrapped row

**Status:** accepted, 2026-09-13

**Context.** FX-07 says a formula cell renders its value with a reference badge and the expression on a secondary line. A compact row is one lattice unit (22 px) and addressing is exact (non-negotiable 3, GRID-09), so a second line cannot be drawn without changing the row's height, which is a document edit.

**Decision.** In a compact row the cell shows the value and the badge; the expression is the cell's tooltip, the editor's initial text and the inspector's copy. In a wrapped row (two units, GRID-09) the expression renders on the second line. The deviation is filed here rather than in a comment; the prototype's compact formula cells show the expression at reduced size, and a future tier of the grid may adopt that once the text-size floor for A11Y is settled.

**Consequences.** FX-07's secondary line is visible only in wrapped rows; the e2e journey wraps the row to assert it and asserts the tooltip in the compact row.

## ADR-025 Row hierarchy: depth is data, the subtree moves with its row, a collapsed subtree leaves the lattice

**Status:** accepted — HIER-01..10, KEYS-06 (`wave3/hierarchy`)

**Context.** PRD §4 and §15 describe an outline over table rows: any row can be nested one level under the row above or promoted, parents collapse, `Split()` output renders as read-only child rows. The handover prototype moves a single row's depth and never checks the invariant of HIER-02 when it renders; the PRD states the invariant and says depth must never move an address (HIER-09) while hiding must recompute them (GRID-02).

**Decision.**

- **Depth and collapse are per-row data in `rowMeta` (HIER-10)**, written by `nestRow` / `promoteRow` / `setRowCollapsed` / `collapseAll` / `expandAll` in `packages/core/src/hier/mutations.ts`, one `transact` each. Validity (HIER-02) is decided in core on the _effective_ depths; the same predicates (`canNest`, `canPromote`) disable the controls, so the grid never asks for what the document refuses.
- **Readers normalise first.** `effectiveDepths` clamps every stored depth to at most one deeper than the row above. A merge (two replicas nesting different rows at once, a parent deleted under a nested child) can leave stored depths that break HIER-02; the outline every reader sees still obeys it, and the next write of that row normalises the data.
- **Nest and promote carry the subtree.** Promoting a parent alone would leave its children two levels below it, which HIER-02 forbids; moving the subtree keeps a valid outline valid under every accepted operation (property tested). This differs from the prototype, which moved the row alone. A consequence, inherent to depth-as-data: a sibling that followed a promoted row may now resolve to it as its parent (HIER-03), because position is data.
- **A collapsed subtree has no lattice presence.** Rows under a collapsed ancestor have height 0 in `rowHeights`, no address in `cellAddress` / `tableAddresses`, are not drawn and are skipped by traversal — exactly what a hidden column is (GRID-02: addresses recompute on hide). Depth alone never changes an address (HIER-09, tested on random nest/promote sequences).
- **The outline column** is `table.outlineColumn` when set and visible, else the first visible column. Indent is `--outline-indent` (15 px, `packages/tokens`) × depth, carried by `--gd-outline-depth` on the cell, so the number lives in one place. While `table.groupBy` names a column (the grouping feature's key) the outline column shows no depth (HIER-08); the data keeps it.
- **A table with any nesting is a `treegrid` to assistive tech**, not a `grid`: that is the role whose rows may carry `aria-level` and `aria-expanded` (axe rejects them on a grid's rows). A flat table stays a grid. The chevron is a labelled button with `aria-expanded`, a tab stop only for the pointer; the keyboard route is `⌥←` / `⌥→` on the selected cell, alongside the handover's `⌘]` / `⌘[` (KEYS-06), all resolved from `event.code`. `⌥←` / `⌥→` are not in `docs/handover/reference/shortcuts.md`; they exist because A11Y-01 needs a keyboard route to the chevron that does not add a tab stop per parent row.
- **Split children** carry `rowMeta.splitChild`; `cellReadOnlyReason` answers `splitChild` for them (HIER-07). `markSplitChildren` / `clearSplitChildren` are the writes the formula engine's `Split()` will call; nothing else sets the flag.
- **A sorted or filtered view locks the outline the way grouping does.** Sort and filter are per-user _view_ state (PR #74): they reorder or drop drawn rows while depth stays relative to the row above in document order, so a sorted view could draw a child above its parent and `⌘]` would nest under a row that is not the one visually above. While the viewer's sort or filter is active — `viewSorted` on `TableView` and `HierarchyPanel`, wired by the sort feature, default false — the outline column shows no depth, prefix or chevron, the table is a plain `grid`, and nest, promote and collapse are refused with the reason announced (HIER-08 semantics; the data keeps its depth). The same lock applies under `groupBy`: depth that is not displayed is not edited.
- **The chevron's hit area below 1024 px is the 44 px token (RESP-05).** A lattice row is 22 px, so the glyph stays 22 px tall and a `::before` pseudo-element on the button, `--hit-target` square and centred on the glyph, takes the press; it overlaps the leading edge of the rows above and below by 11 px, the accepted trade-off for a target inside a lattice row. The outline cell lets the area out of its `overflow` (its text clips itself) except while its editor is open. The button is a pointer target only (`tabIndex -1`, never focused); the keyboard route is `⌥←` / `⌥→` on the focused cell, so the grid keeps one tab stop.
- **`collapsed` is settled whenever a row can lose its last child.** A delete, a promote or a row inserted directly under a collapsed parent runs `settleCollapsed` in the same transaction, clearing the flag on any row without descendants, so a stale flag never re-hides the next subtree that forms there.
- **Every row is born with its `rowMeta` map** (`createTable`, `addRow`, `insertRowBefore`). Two replicas that first write different keys of the same row while apart — one nests it, the other wraps it — would each create their own nested map and Yjs keeps one; a map that exists from the row's birth takes both writes (tested). Rows from before this change still get their map on first write.
- **Read-only viewers cannot toggle collapse.** Collapse state is document state that syncs (HIER-10), so a viewer (phone, RESP-02; view-only share, SHARE-03) sees the chevron's state as a glyph and the row's `aria-expanded`, with no control. PRD §RESP lists "expand groups" among phone actions; that is category bands (SORT-05), which are a separate feature, and a local-only toggle here would diverge from HIER-10.

**Consequences.** `setRowDepth` remains as the raw, unvalidated write for fixtures and the projection; product code uses `nestRow` / `promoteRow`. Inserting a row directly below a collapsed parent (context menu) lands it at depth 0 and takes over the subtree; the old parent, now childless, is expanded by `settleCollapsed`. The add-row strip appends at the end and is unaffected. `HierarchyPanel` (`routes/document/hier/`) is exported for the inspector and not mounted in this change; HIER-01's inspector half and HIER-07's `Split()` half stay partial in `docs/TRACEABILITY.md` until those land.

## ADR-026 Sort, filter and grouping are per-user view state, not document state

**Status:** accepted, 2026-09-13

**Context.** SORT-01..06 and PRD §9, §15 describe sorting, filtering and grouping a table without saying whether collaborators share the result. The first implementation stored `sortBy`, `filter` and `groupBy` on the table's Y.Map, citing HIER-10 ("depth and collapse state persist per row in the document and sync to collaborators"). HIER-10 is explicit for the hierarchy only; every other view preference the PRD names — the library's sort ("the choice persists per user", LIB), the locale (I18N-05) — is per user, and the architecture's awareness payload (user, colour, selected cell, sheet) carries no view state either. Under the shared reading an editor's filter makes a view-only or phone participant's rows vanish, an A–Z rearranges every open screen, and the footer's "sum of visible rows" becomes a shared value.

**Decision.** Sort, filter and grouping are viewer state, persisted per (user, document, table) on the device in `localStorage` under `gede.view.<sub>.<docId>` (`apps/web/src/doc/view-state.ts`), and wiped at sign-out together with the IndexedDB replicas ("Nothing is left on this device", AUTH-09). Band collapse stays per viewer, in memory. The document carries no view keys; the sync service never sees them. View changes are not undo steps (they are not document edits). `readGroupBy(store, tableId)` and `useTableView(tableId)` are the readers the hierarchy layer uses for HIER-08; the pure projection (`packages/core/src/sort`) is unchanged. Footer totals respect the viewer's own filter.

**Consequences.** A view-only participant and a phone reader can sort and filter their own view; a collaborator's view never moves anyone else's rows; the two-replica guarantee is that the document is byte-identical whatever each viewer sorts. Views do not follow a user across devices (the locale does, through the server); if that is wanted later it is a per-user server record, never a document key. Migration: documents written by the previous build may carry the three keys; readers ignore them and nothing writes them.
