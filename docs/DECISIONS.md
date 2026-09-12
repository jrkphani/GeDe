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
