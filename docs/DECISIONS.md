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

## ADR-027 Context menus are non-modal, open on their own long-press timer, and return focus to the selection

**Status:** accepted, 2026-09-14

**Context.** MENU-01..05 ask for cell, column, table, sheet and canvas menus that open from the pointer, from a long-press on tablet (RESP-03) and from the keyboard, close on Escape or a click outside, and return focus to the trigger. Radix ContextMenu is the primitive (non-negotiable 7). Three things in the way: a modal Radix menu marks the rest of the page `aria-hidden` while the focused cell stays focusable, which axe reports as `aria-hidden-focus` (serious); the grid's cells stop `pointerdown` propagating (the canvas would pan otherwise), so Radix's long-press timer, attached to the trigger region, never starts; and Radix returns focus to its trigger, which for a document-wide menu is the whole canvas rather than the cell that had it.

**Decision.** One `ContextMenu` over the canvas, the tables and the sheet strip, `modal={false}`: nothing behind it is hidden, a click outside both closes the menu and lands where it was aimed (desktop parity), Escape closes. The menu resolves what it landed on from the DOM the grid renders (`data-table-id`, `data-row-id`, `data-col-id`, the header's `data-col-id`, the sheet tabs, the plane), so the menus keep no second model of the document. Long-press runs from the wrapper's capture phase with Radix's own 700 ms delay and 10 px slop, and opens the menu the way the keyboard does — a synthetic `contextmenu` at the point — so Shift+F10, the ContextMenu key, right-click and touch share one path. A scrollable menu is focusable (`tabIndex=0`) so it can be scrolled from the keyboard. On close, focus goes to the cell that is selected — the cell a command just inserted or the neighbour of one it deleted — and otherwise to the element that had it when the menu opened.

**Consequences.** Every new surface passes axe with the menu open. A right-click selects the cell like a left-click does. Commands that other Wave 2 work provides (sort, filter, categories, graph) are present and disabled with the release that brings them (MENU-02), wired through `MenuSlots`.

## ADR-028 Cell clipboard: the browser's own copy / paste is the keyboard route; the async Clipboard API stays behind a user gesture

**Status:** accepted, 2026-09-14 (supersedes the first cut reviewed in #79)

**Context.** KEYS-03 binds ⌘X ⌘C ⌘V ⌥⇧⌘V to a selected cell. The first cut bound the three chords in the shell and read the clipboard through `navigator.clipboard.read()`, on the premise that a `gridcell` div is not editable and so raises no `paste`. The review disproved it: every engine runs its copy / cut / paste command on the focused element and dispatches the native `copy` / `cut` / `paste` events to it (Chromium executes Paste with `allow_execution_when_disabled`; Excalidraw and tldraw rely on exactly this). Binding the chord prevented that default, and the async read behind it prompts in Chromium on the first ⌘V, shows Firefox's paste-button popup on every ⌘V, and Safari's paste callout — none of it visible in the e2e, which granted the clipboard permissions to every test.

**Decision.** The shell binds none of ⌘X ⌘C ⌘V. The keydown's default runs, the browser raises the native event on the focused cell, and `keys/clipboard.ts` handles it: `copy` and `cut` write `text/plain` plus the cell's rich document under `application/x-gede-rich+json` into `clipboardData`; `paste` reads the rich flavour when present, else the text. No permission, no prompt, every engine. ⌥⇧⌘V is bound **passively** (`ShortcutBinding.passive`: the handler runs, the default is kept): it arms a match-style flag; the browser's own paste for the chord (Chromium and WebKit raise one for Paste and Match Style) consumes it as text only, and if none arrives by the next task the clipboard falls back to `readText()` — the one keyboard path that may prompt, on the one chord no engine serves natively. The menu commands (a click is a user gesture) use the async API: `write` with the rich flavour as a Chromium custom web format beside `text/plain`, `read` for Paste, both acceptable behind a menu item. Copy snapshot writes the displayed, formatted value. "Match style" writes an unmarked document (not a no-op text commit), so a cell that already held the same text with marks loses them.

**Consequences.** The two stores are not one: Chromium exposes the async route's custom web format only through `navigator.clipboard.read`, never through `DataTransfer`, so marks copied by menu and pasted by keyboard, or the reverse, degrade to text; text always survives. `clipboard.test.tsx` pins that no keydown reaches `navigator.clipboard.read` / `readText`, and `e2e/inspector.spec.ts` runs the ⌘C / ⌘V journey with `permissions: []`. Multi-cell (TSV) paste is not implemented: a tab-separated paste lands in one cell as text; KEYS-03 and MENU-04 do not ask for range paste.

## ADR-029 Per-cell change counters make the memoised grid cell correct

**Status:** accepted, 2026-09-14

**Context.** The PR #57 review found that `Cell` re-rendered the whole table per keystroke: the table's deep observer bumped one counter and every cell read the document again. Memoising `Cell` alone would be wrong — a cell reads its text from the Yjs map during render, so with equal props a changed cell would never re-render.

**Decision.** `grid/cell-versions.ts` keeps one deep observer per table and a counter per cell key: an event whose target sits under the `cells` or `cellFormat` map bumps that key (walking `parent` up to the map, because Yjs re-bases `event.path` on the outermost observed ancestor before deep observers run); an event that created or replaced either map bumps a bulk counter folded into every key. `Cell` takes `version` as a prop and is memoised with a by-value comparison of the two props the parent rebuilds each render (`cell`, `column`); traversal is read through a stable getter; a formula cell subscribes itself to the workbook index so a renamed label re-projects it. Structural changes (rows, columns, meta, selection) reach cells through their ordinary props.

**Consequences.** A keystroke renders one cell (`cell-versions.test.tsx` counts renders); a column format change renders that column; a selection change renders the two cells whose state moved. The first cell-format override on a table renders every cell once (the map arrives), then one per change.

## ADR-030 Collapse and expand keep the plain ⌥ arrows, and the shortcut sheet lists them as an addition to the handover map

**Status:** accepted, 2026-09-14

**Context.** ADR-025 added `⌥←` / `⌥→` for collapse and expand on the selected row — a keyboard route to the chevron that adds no tab stop per parent row (A11Y-01). They are not in `docs/handover/reference/shortcuts.md` (KEYS-01, KEYS-08), and `⌥←` / `⌥→` are the OS word-jump chords in text fields; `⌥⇧←` / `⌥⇧→` were the alternative.

**Decision.** Keep `⌥←` / `⌥→`. They act only on a selected cell that is not being edited: the grid's keydown path handles them by physical key and the editor never sees them, so the word-jump convention is untouched wherever there is a caret — inside the cell editor, the title field and the Find field. The plain-⌥ arrow is also the disclosure convention outliners use (Finder's list view among them), and one modifier fewer under the finger matters on the 44 px targets below 1024 px. The shortcut sheet lists them under "Table and cells" as "Collapse / expand row" with an `extra` marker naming this decision, and `shortcut-map.test.ts` pins the sheet to the handover reference plus exactly this row, and the shell's `CHORDS` to `HIER_CHORDS`, so neither table can drift from the other.

**Browser-reserved chords.** KEYS-02 and KEYS-07 also name ⌘N, ⌘W, ⌃⇥ and ⌃⇧⇥. Chrome and Safari keep them (new window, close tab, switch tab) and never deliver them to the page; only Firefox lets ⌘W through. The sheet lists them — the map is the PRD's — marked "the browser's in Chrome and Safari" with the other route beside each (the library's +, the mark back to the library, the sheet strip; KEYS-08), and the shell binds none of them, so the one engine that delivers ⌘W closes the tab as the person expects rather than doing something else. `reservedRows()` in `shortcut-map.ts` names exactly those three rows and the test pins them.

**Escape.** The shell's Escape (clear the selection, GRID-03) is disabled while a layered surface owns the key: the shortcut sheet, a context menu, or the rail in overlay mode below 1024 px (RESP-03), which now dismisses on Escape and on a press outside it like every layered surface. The overlay takes Escape in the capture phase and prevents it, so one keystroke closes one thing.

**Consequences.** `docs/handover/reference/shortcuts.md` is the handover document and is not edited; the product's map is the sheet. Any further chord beyond the reference must carry an ADR the same way.

## ADR-031 Archive and trash are document states; deletability follows access, not history

**Status:** accepted — LIB-D1..D11 (`wave3/library-states`). Numbered after ADR-027–030 (`wave2/inspector-menus-keys`, #79), which lands first; #77 carries a second ADR-026 that its integrator renumbers.

**Context.** The 2026-09-12 handover added delete vs archive to the library (LIB-D1..D11): a workscape someone was given access to must be archivable, never deletable, so nobody loses a document they hold; the guided sample (ONB-01, a later wave) is exempt from both; and "archive and trash are document states, not library-local flags — a second client signed in to the same account must observe the same state without a reload" (LIB-D11). The prototype models all of it in per-tab memory (`S.lib.trashed` / `archived` / `purged`, a static `d.shared`) and has no invitation model. Two rows pull in different directions: LIB-D2 says a workscape that has _ever_ been shared must not be deletable; LIB-D4 says revoking all access must _restore_ deletability.

**Decision.**

- **Two nullable timestamps on `documents`** (migration 0008): the existing `deleted_at` (trash; 30-day purge unchanged) and a new `archived_at` (archive; no expiry, LIB-D6). A row is archived or deleted, never both — a CHECK enforces it, and soft delete clears the archive as it sets `deleted_at`. Archive touches `archived_at` alone: every share, the link, the open room and `updated_at` stay (LIB-D3; participants see no change, and Recents keeps its order). The owner's Recents, Browse and Shared filter `archived_at IS NULL`; a participant's views do not.
- **`documents.ever_shared`, LIB-D4 over LIB-D2's wording.** The flag is written only by the repository, inside the share transactions: set by every path that inserts a share — an invitation accepted or converted at sign-in, a link redeemed, a person with an account named in the sheet (access on the spot is an accepted share, not a sent one) — and by switching the link on (LIB-D1 names "no active share link" as a condition of deletability, and nobody can tell who holds a URL); cleared by removing a participant, stopping sharing, or switching the link off, once no share remains and the link is `none`. Sending an invitation never sets it (LIB-D4: "at the moment the first invitation is accepted, not when it is sent"). So "ever" in LIB-D2 is read as "has been shared and access remains": revoking all access restores Delete, as LIB-D4 requires. The pipeline's backfill sets the flag for rows that already have a share or a link on. `DELETE /api/documents/:id` answers 409 `shared` while it is true; the SPA reads the same flag for the toolbar wording and the server has the last word. Every share transaction and the owner's Delete (`documents.tryDelete`) take the document row `FOR UPDATE` first: that lock conflicts with the `FOR KEY SHARE` a share insert holds through its foreign key, so removing the last participant never evaluates "no share remains" beside an acceptance that has not committed, and Delete waits for such an acceptance and is then refused (review of #88; `pg.live.test.ts` pins both interleavings).
- **`documents.sample`** ships now, unset by anything (ONB-01 seeds it later), so the guard cannot be forgotten: Delete and Archive answer 409 `sample`, the toolbar action is `aria-disabled` with the reason, the row is flagged Sample (LIB-D10).
- **A second client learns of the change the way it learns of every other remote change to the list (LIB-D11): by re-reading it.** The library had no push channel and no polling — rooms are per document, so a document's awareness cannot carry a library state change to a tab that has not opened it. Rather than a per-user socket (a new authenticated endpoint, a per-user registry, and cross-task fan-out the service does not have yet), the library re-reads its view every 15 s while the tab is visible and at once when the tab becomes visible or the window regains focus (`routes/library/refresh.ts`), replacing state only when the rows differ. Four requests a minute per tab against a per-user budget of 300. A per-user channel is the growth step if the cadence ever reads as slow.
- **Feedback (LIB-D9).** Reversible actions — delete, archive, recover, unarchive, recover all — go straight through and raise a Toast whose Undo reverses through the API (`recover`, `unarchive`, `archive`, `delete`, and for Recover All a delete of each id the service returned). The single-delete confirmation dialog is gone: a modal before a reversible action is friction the toast already covers, and the prototype has none. Delete All alone is permanent, sits behind an `AlertDialog` (Radix; focus starts on Cancel, outside clicks do not dismiss) whose copy says it cannot be undone, and its toast says so again with no Undo (LIB-D8).
- **Phone is read-only in the library too.** Below 768 px no delete, archive, recover, unarchive or purge affordance renders (non-negotiable 5, RESP-02); the toolbar says "View only on phone" where they were.

**Consequences.** A shared workscape can never be deleted while anyone holds access — including by its owner through the API — and `stop-sharing` is the documented way back to Delete. An archived unshared workscape (reachable through the API) offers Unarchive only; deleting it clears the archive. The purge job is unchanged and never sees `archived_at`. `recover-all` now returns the ids it recovered. `services/sync` audit rows gain `document.archive` and `document.unarchive`.

## ADR-032 Cross-table references: method calls in the grammar, engine-owned derived cells, reconciled rows

**Status:** accepted, 2026-09-12 — extends ADR-023; builds on ADR-025's `splitChild`; revised after review of #77

**Context.** PRD §14 and REF-01..05 add reference cells, pulls, mapping columns and derived columns; HIER-07 adds `Split()` children. Each needs a stored shape that keeps ids (PRD §20), recomputes through the dependency graph in the Worker, converges across replicas and stays read-only in every write path. The hierarchy and sort work landed in parallel, so the shapes are additive.

**Decision.**

- **Grammar.** ADR-023's grammar gains one production: `reference '.' Method [ '.' Chip ] '(' [name '='] literal, … ')'` with `Method ∈ {Extract, Split, Replace, Format, Concat}` — the PRD's set (§2 Replace, §3 Extract, §4 Split, §20 "Split, Replace, Extract, Concat", §22 Format presets). `Length` and `Trim` are not offered: a string length is a §9 conditional-highlight metric, not a method, and `Trim` is `Format("Trimmed")`. The target is an ordinary reference, so it binds to an id token on commit and projects back like any other; the arguments are literals, optionally named (`Extract(Style="Highlight:Yellow")`, §3); `Extract.Date()` (§9) is the chip named property-style and means `Extract("date")`. Methods receive the cell's rich text — marks survive (`packages/core/CLAUDE.md`), so `Style=` reads highlights and inline marks; the engine ships a cell's marks only when it has any. `Split` evaluates to a `list` value; the rest to text. `Format` cases through `Intl` for the active locale, which the app hands the Worker as a `locale` request (every formula re-evaluates on change). Regular expressions are checked with `isRe2Safe` before they run, in the Worker.
- **Reference cell (REF-01)** is the smallest formula there is: one entity-spelled bound cell, `={e:T:R:C}`. No new persisted kind; `referenceTargetOf` (memoised by source) recognises it for rendering (accent mono, `@` badge, path beneath in a wrapped row — ADR-024 applies).
- **Derived column (REF-04)** stores its spec on the column map (`source: 'derived'`, `derive: { sourceColId, method, args }`; an argument is text or `{ name, value }`) and no cells. The engine synthesises `={c:T:R:SRC}.Method(args)` per row, so a derived cell is a graph node like any formula: it recomputes on every upstream change, and other formulas can read it. A document cell in a derived column takes precedence over the synthesised one — that is how a `Split()` child holds its piece. The column's label is its signature; `renameColumn` re-spells the derived columns that name a source, and the grid's delete command re-spells them to `@#REF.…`. The lineage header (source span, pipeline span) renders on the title bar's second lattice row, not in a row of its own, so adding a derived column never moves an address (non-negotiable 3).
- **Pull (REF-02)** stores `source: 'pulled'`, `pull: { tableId, colId, filter }` on the receiving column, which is relabelled `↰ Table · Column`. Every source row is mirrored unless the contains filter excludes it — PRD §14 names only the filter, so a blank source cell is mirrored too; a formula or derived source cell reads by the value the engine evaluated (`PullReader.cellValue`), never by its source text. Mirrored rows are real rows of the receiving table whose id is the source row's id (provenance and determinism in one), marked `rowMeta.pulledFrom`, with a `={c:T:R:C}` cell in the receiving column so the value is the engine's. Provenance is one hop: a source's own pulled rows are not pulled again, so a chain of pulls cannot loop. A reconciler (`reconcilePull`, under `REF_ORIGIN`, which undo does not track) keeps the row set in step: binding the pull is one undo step, rows included; a source edit stays one step. Own rows come first and the mirrored block last, in source order: a row a person appends (`addRow` puts it at the end) is moved up before the block, one row at a time, and split children of a pulled row ride inside the block behind their parent.
- **Reconcilers are minimal diffs (`ref/rows.ts`).** A Yjs insert is a fresh item, so a delete-all-and-reinsert on two writing replicas duplicates every row after merge and never settles. Instead: drop later duplicates of an id (both replicas hold the same merged order, so both delete the same items), delete only unwanted rows, insert only missing ones, and move one row at a time into order. A concurrent insert or move duplicates a row once; the next pass deduplicates it without a new insert, and a replica that sees the other's finished result writes nothing. Pinned by a truly concurrent exchange test for both reconcilers (settles in fewer than 30 rounds, equal rows, no duplicate ids).
- **`observePulls`** reconciles only the pulls whose source (or receiving table) a transaction touched, and only for changes the row set can read — cells, rows, columns, a column's source/pull/derive/link, a row's provenance; a resize, move or title changes nothing. It caches each source row's filter text and forgets only the rows a transaction's cells changed; rows that read the engine are never cached, and `reconcileFilteredPulls` re-runs those after a results batch.
- **Mapping column (REF-03)** stores `source: 'linked'`, `link: { tableId, colId }`; the cell's value is plain text written only by the picker (`GridCommands.pickMappingValue` → `setMappingValue`, which refuses a value the target does not hold). Options are the target's distinct stored values through `Intl.Collator`; a derived column cannot be a target (it has no stored values), and the panel says so.
- **`Split()` children (HIER-07)** are materialised from engine results on the main thread by `reconcileSplitChildren`: rows `hash(parent~index)` (ULID-shaped, so they fit inside bound tokens) directly beneath the parent, flagged and levelled through `markSplitChildrenBatch` (one table walk for every unsettled parent) inside the reconcile's transaction (ADR-025's contract: `effectiveDepths`, so a merge-shaped parent depth is normalised) with `rowMeta.splitOf = { rowId, index }` as provenance. One `Split` column per table renders children; a table whose split column went yields none, so stale children go too.
- **Guard (REF-05).** `rowReadOnlyReason` gains `pulled` beside ADR-025's `group` and `splitChild`; `isGraphDimensionCandidate(column)` admits only `entered` columns. **The guard is the app layer's**, as GRID-04's is: `commitCell`, `commitRichCell`, `clearCell`, `pickMappingValue` and find-and-replace consult `cellReadOnlyReason`; the core mutations (`setCellText`, `commitCellText`, `replaceInCell`) write what they are given, so a sync replay or a migration can. A core test pins that split.

**Consequences.** The pull filter runs where the reconciler runs — the main thread of the replica that can write — over text the document holds or values the engine already evaluated; nothing is evaluated there. A read-only replica (phone, viewer) reconciles nothing and sees what the writing replica produced. A derived column's cells cannot be typed, pasted or found-and-replaced into; the pipeline is edited through the inspector's panel. The `Style=` form depends on marks the engine ships only for marked cells, so an unmarked cell yields nothing rather than everything.

## ADR-033 Graph keys are the graph's own and the shortcut sheet lists them as a "Graphs" group

**Status:** accepted, 2026-09-13 — GRAPH-09, GRAPH-10, INSP-08 (`wave4/graphs`, #90); extends ADR-030's rule that any chord beyond the handover reference carries an ADR

**Context.** A ring node, a parameter dot and a coverage cell are SVG elements inside a graph object. GRAPH-10 gives a node two pointer gestures — click selects its row, double-click opens a child sheet named after its symbol — and GRAPH-09 lights adjacency on hover. A keyboard user needs every one of those without a pointer (A11Y-01) and needs to discover them (KEYS-08), but `docs/handover/reference/shortcuts.md` predates graphs and has no group for them, and `shortcut-map.test.ts` pins the sheet to the reference plus the rows an ADR names.

**Decision.** One tab stop per graph (roving `tabIndex`, `data-graph-item` carries the traversal index because SVG paint order is not traversal order); the arrows, Home and End move between nodes, dots and cells; Enter (or Space) is the click — select the graph, then the node's row; Shift+Enter is the double-click — open the child sheet; Escape cancels pointing mode (capture phase, `event.code`, so the shell's Escape does not also clear the selection). The keys are handled by the graph, not bound by the shell, like Tab and the arrows in a table; `Escape` reuses the shell's `escape` chord id. The sheet lists them under a **Graphs** group between "Table and cells" and "View", each row marked `extra: 'ADR-033'`, and `shortcut-map.test.ts` pins exactly those rows beside ADR-030's. Focus on a node is the focus ring (`--focus-ring`, 2 px at 2 px offset, drawn as a ring around the node so it never hides under the node's own stroke); selection is a distinct treatment — the selected node carries a thicker amber stroke and its symbol underlined — so focus and selection read apart even when both are amber (A11Y-02, A11Y-04).

**Consequences.** The handover document is not edited (ADR-030). Hover emphasis and focus emphasis are the same state, so a screen-reader user tabbing through nodes hears the same adjacency a pointer user sees.

## ADR-034 Appearance is paint over the lattice: merged cells are visual spans, pins and stacking are table keys, DAG edges are derived

**Status:** accepted, 2026-09-13 — extends ADR-023 (id-bound tokens) and the FMT-06 column-scope shape; filed from #91

**Context.** INSP-04..07 and MENU-04 add table styles, fills, borders, typography, conditional rules, merge controls, stacking, pin to viewport, canvas layouts and DAG edges. The lattice has exactly one address per position (GRID-01, GRID-02, non-negotiable 3), and the PRD names "merge controls" without saying what a merged cell is. Every one of these must converge across replicas, stay in the undo history as one step per change, and never move an address.

**Decision.**

- **Vocabularies, not values.** Every stored appearance field is a token name or a closed option (`packages/core/src/style/types.ts`); the stylesheet maps names to `packages/tokens` custom properties. Readers guard: an off-vocabulary value written by a newer client reads as absent, never breaks an older one.
- **Column scope with a cell override**, as the data format (FMT-06): `appearance` on the column map, `cellAppearance` on the table keyed like `cells`. A row appended later inherits by construction. A cell override clears a field back to inherit; it cannot express "none" over a column value (a known limit, filed in #91's review).
- **A merge is a visual span** stored on its anchor (`spans` map, `rowId:colId → { rows, cols }`). The covered cells keep their ids, addresses, data and formulas; the grid renders them as empty placeholders the way a hidden column's cells leave the grid, traversal skips them and lands on the anchor, unmerge shows them again unchanged. A span is resolved against today's row and column order and clipped to the table, so a deleted covered row shrinks it; a span whose anchor column is hidden is not in force until the column returns; two concurrent overlapping merges resolve deterministically (sorted anchor keys, the later one dropped from the index). A selection or edit a collaborator's merge covers lands on the anchor; the draft commits into the covered cell first (GRID-06).
- **Conditional rules** live on the column (`rules`), first match wins, and are evaluated only in the rules Worker (`workers/rules.worker.ts`) over the text the renderer shows — a formula's evaluated value, never its source. A rule's text colour under 4.5:1 on its fill resolves to ink and the cell says so (`UNSAFE_TEXT_ON_FILL`, measured from the tokens by `contrast.test.ts`); every match carries a glyph with the rule's words (A11Y-04).
- **Stacking (`z`) and pin (`pinned`) are table keys; `edgesShown` is a sheet key.** They are document state, so every replica sees the same paint order and the same pinned tables, and each toggle is an undo step. A pinned table's live copy renders in a layer that scales but never pans; an inert ghost keeps its lattice origin so DAG context and addresses are untouched (PRD §10).
- **DAG edges are never stored.** They are read from the id-bound tokens of every formula cell on the sheet (typed formulas, reference cells, pulled cells), counted per table pair; cross-sheet edges are counted in the Arrange tab, not drawn (PRD §11). Drawn as SVG in the DOM layer while they number in the tens; PRD §20 reserves a canvas layer for the hundreds.
- **Fit-to-content** measures with canvas `measureText` in the cell's font and snaps to whole units (GRID-01). A width is geometry, and geometry is addressing: the columns after a fitted column re-address exactly as after a divider drag. Where no 2D context exists the control is disabled with that reason rather than guessing.

**Consequences.** No appearance control moves a cell's address; only the width and wrap writes (fit, scale) do, and those are the same lattice writes the dividers make. Find still indexes covered cells (they hold data); whether it should skip them as it skips hidden columns is open (#91 review). Pin and stacking being shared means one participant's pin is everyone's — the PRD does not say otherwise, and frozen columns already behave this way.
