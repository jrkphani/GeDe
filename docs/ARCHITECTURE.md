# GeDe architecture

This is the architecture as built in v2. It supersedes the deployment section of the handover C4 (`docs/ARCHITECTURE-DIGEST.md` §1.4) where the two differ; the differences are listed at the end with reasons. The C4 remains the reference for the component split and the capacity model.

## 1. Topology

Single AWS account 975049998516, single production environment, primary region `ap-southeast-1`, with one cross-region stack in `us-east-1` for the CloudFront certificate and WAF.

```
Browser
  │
  ├─ https://gede.work ─────────► CloudFront (+ WAF managed rules) ──► S3 "web" (SPA bundle + /config.json)
  │                                       │
  ├─ https://gede.work/api/* ─────────────┴───────────────────────────► ALB (HTTPS) ──► ECS Fargate ARM64 · sync service
  │                                                                       │
  ├─ wss://ws.gede.work/ws/:docId ────────────────────────────────────────┘   (direct to ALB, 1 h idle timeout)
  │
  └─ Cognito (user pool, passwordless) ── WebAuthn / email OTP / Apple OIDC (flagged)

Sync service ──► RDS PostgreSQL 17 (private subnet, TLS)
             ──► S3 "docs" (snapshots, versioned, via gateway endpoint)
             ──► SES (share invitations)
```

| Component     | Service and settings                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS           | Route 53 hosted zone `gede.work` (registered in the same account). `gede.work` and `www.gede.work` → CloudFront; `api.gede.work` and `ws.gede.work` → ALB.                                                                                                                                                                                                                                           |
| Edge          | CloudFront distribution, SPA origin S3 (OAC), `/api/*` behaviour to an HTTP origin at `api.gede.work` (the ALB) with caching disabled, SPA fallback for deep links. WAF with AWS managed rule groups. Certificate in `us-east-1`.                                                                                                                                                                    |
| Web           | S3 bucket, private, content-hashed assets with long cache, `index.html` and `config.json` with no-cache. `config.json` is written by CDK from stack outputs.                                                                                                                                                                                                                                         |
| Network       | VPC, 2 AZs, public and private subnets, **no NAT gateway**. S3 gateway endpoint. Interface endpoints only where a private-subnet caller needs them.                                                                                                                                                                                                                                                  |
| Service       | ECS Fargate, ARM64, 0.5 vCPU / 1 GiB, desired 1, task in a **public subnet with a public IP**; task security group allows ingress only from the ALB security group. Deployment circuit breaker with rollback on. Logs to CloudWatch, 1-month retention. Task role: read/write on the `docs/` prefix, read its own DB secret, send through the SES identity.                                          |
| Load balancer | ALB, HTTPS with an ACM certificate in `ap-southeast-1` for `api.gede.work` + `ws.gede.work`, idle timeout 3600 s for WebSocket, health check `GET /healthz`.                                                                                                                                                                                                                                         |
| Database      | RDS PostgreSQL 17, `db.t4g.micro`, 20 GB gp3, single-AZ, 7-day PITR, private subnet, deletion protection, `SNAPSHOT` removal policy. Generated credentials (`gede_admin`) in Secrets Manager, injected into the task as `PG*` variables; TLS `verify-full` against the bundled RDS CA.                                                                                                               |
| Documents     | S3 bucket `docs`, versioned, 90-day noncurrent retention, lifecycle to Glacier IR after 90 days. Task role scoped to this bucket.                                                                                                                                                                                                                                                                    |
| Identity      | Cognito user pool, `featurePlan: ESSENTIALS`, pool policy `[PASSWORD, EMAIL_OTP, WEB_AUTHN]` (Cognito requires PASSWORD to be listed), WebAuthn relying party id `gede.work`. Passwordless is enforced by the SPA client, which has the `USER_AUTH` flow only and no password field. Email via Cognito's built-in sender until SES leaves sandbox. Apple IdP wired behind CDK context `appleSignIn`. |
| Ops           | CloudWatch alarms → SNS email `jrkphani@icloud.com`: `gede-prod-service-cpu` (> 60 % for 10 min), `gede-prod-alb-5xx` (> 1 % of requests), `gede-prod-db-free-storage` (< 5 GiB). AWS Budget `gede-prod-monthly` US$100 with alert at 80 %. The handover's snapshot-lag and WebSocket-reconnect alarms need custom metrics from the service and are not yet implemented.                             |

Why no NAT: the only thing that would use it is the sync task reaching S3, Secrets Manager, Cognito's JWKS endpoint and SES. A public IP on the task plus a security group that only admits the ALB gives the same reachability for ~US$33/month less. RDS stays private and is reachable only from the task security group.

Why WebSocket bypasses CloudFront: CloudFront caps idle WebSocket connections at 60 s and adds a hop to every awareness message. A y-websocket room needs an hour-long idle connection. `wss://ws.gede.work` therefore points at the ALB directly; `/api/*` still goes through CloudFront so the WAF sees every REST call.

## 2. Pipeline

One CDK app in `infra/` defines `PipelineStack` (CodePipeline `GeDe`) and `GedeStage` (eight stacks: Network, Data, Auth, Edge, Service, Web, Dns, Ops). Every stage of the pipeline runs on CodeBuild `LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0`, `ComputeType.SMALL`.

| Stage      | What runs                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Source     | GitHub via CodeConnections, branch `main`.                                                                                                 |
| Synth      | `npm ci`, `npm run verify` (typecheck, lint, format check, unit tests), `npm run build -w apps/web`, `cdk synth`.                          |
| SelfMutate | The pipeline updates itself if `PipelineStack` changed, then restarts.                                                                     |
| Assets     | Builds the `linux/arm64` sync image natively (privileged) and publishes the web bundle and templates to the asset buckets in both regions. |
| Prod       | Deploys the eight stacks; Edge in `us-east-1` first (certificate, WAF), the rest in `ap-southeast-1`.                                      |
| Smoke      | `curl -fsS --retry 12 $API_URL/healthz`; `curl -fsS $APP_URL/` contains `id="root"`. Both URLs come from stage outputs.                    |

A failed ECS deployment is rolled back by the circuit breaker; a failed stack update is rolled back by CloudFormation; a failed Smoke step marks the execution failed and leaves the previous task set running. There is no manual approval step today; a `ManualApprovalStep` is left commented in `infra/` for a future Staging → Prod gate.

## 3. Environments

Production only. `GedeStage` is instantiated once as `Prod` with the `PROD` config from `infra/lib/config.ts` (account, region, domain, `envName`, alerts email, budget); stack names are `GeDe-Prod-<Network|Data|Auth|Edge|Service|Web|Dns|Ops>`. A `Staging` environment is a second `EnvConfig` and one more `pipeline.addStage(new GedeStage(…, 'Staging', …))` before `Prod`, with its own subdomain and its own Cognito pool; see `docs/RUNBOOK.md` for the steps. Nothing in the app distinguishes environments at build time; the SPA reads `/config.json` and the service reads environment variables.

## 4. Data model

The document layer is a Yjs CRDT: `Y.Map` per document with `sheets`, `tables`, `graphs`, `meta`; each table holds `columns`, `rows` and a `cells` map keyed `rowId:colId` whose values are `Y.XmlFragment` rich text or a formula string. Ids are ULIDs generated client-side; A1 addresses are computed from lattice position and never stored.

The relational layer holds what a CRDT cannot: identity, access control, listing, the update log, and a rebuildable projection for search and audit. The exact tables and columns are in `docs/ARCHITECTURE-DIGEST.md` §1.5 and are mirrored one-to-one by `packages/db/src/schema.ts`.

| Layer                     | Tables                                                                | Written by                                    |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Relational, authoritative | `users`, `documents`, `shares`, `invites`, `doc_updates`, `snapshots` | Sync service request handlers and room writer |
| Relational, projection    | `sheets`, `tables`, `columns`, `rows`, `cells`, `graphs`, `audit_log` | Projection worker only; rebuildable           |
| Document                  | Yjs update log (`doc_updates`) and snapshots (S3 `docs`)              | The CRDT, via the room writer                 |

Functional requirements are in `docs/REQUIREMENTS.md`; the ones that shape this model are SHARE-01..05 (shares, invites, link access, presence), LOAD-05..06 (optimistic local replica in IndexedDB), LIB-08 (30-day soft delete via `documents.deleted_at`) and FIND-03 (search across the projection).

## 5. Persistence and snapshots

1. A client connects to `/ws/:docId` with a Cognito access token. The service verifies the JWT, resolves permission from `shares` and `documents.link_access`, and joins the socket to the room.
2. On cold open the room loads the latest snapshot from S3 (`documents.snapshot_key`) and replays `doc_updates` with `seq > snapshot_seq`.
3. Each incoming update is appended to `doc_updates` (author from the JWT) and then fanned out to the other sockets. View-only sockets' updates are dropped before this step.
4. Every 500 updates, or 5 minutes after the last update, the room writes `Y.encodeStateAsUpdate` to `s3://<docs bucket>/docs/<documentId>/<seq>.bin`, inserts a `snapshots` row, updates `documents.snapshot_key/snapshot_seq`, and deletes `doc_updates` up to `seq`.
5. The projection worker, debounced per document, materialises tables, columns, rows and cell text into the projection tables.
6. On `SIGTERM` every dirty room snapshots before the process exits (25 s budget).

The browser keeps its own replica in IndexedDB (`y-indexeddb`), so edits survive 401, 429, 5xx and offline periods and merge on reconnect.

## 6. Growth steps

From the handover capacity plan (`docs/ARCHITECTURE-DIGEST.md` §1.7). Each step swaps a transport or store behind an existing component boundary.

| Trigger                                       | Change                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ≈ 50 users, or any task > 60 % CPU            | Step 1. ECS to 2+ tasks; ElastiCache Redis for room pub/sub (y-redis pattern); task 1 vCPU / 2 GiB.                     |
| ≈ 200 users, or Postgres > 70 % CPU sustained | Step 2. Snapshot-restore into Aurora Serverless v2, Multi-AZ; projection worker to its own ECS service.                 |
| Update log > 50 GB, or compaction lag         | Step 3. Move `doc_updates` to DynamoDB (pk document_id, sk seq, TTL after snapshot).                                    |
| Users outside SE Asia                         | Step 4. Second region for the sync service with Aurora Global Database read replica; documents pinned to a home region. |

The first cost step, before any of these, is adding a NAT gateway if the security posture ever requires the task to be in a private subnet; nothing else changes.

## 7. Deviations from the handover specification

| Handover said                                       | v2 does                                          | Why                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node 20                                             | Node 22                                          | Node 20 reached end of life in April 2026; 22 is the current LTS on Fargate and CodeBuild ARM images.                               |
| PostgreSQL 16                                       | PostgreSQL 17                                    | Current RDS major on Graviton; same wire protocol and schema; longer support window.                                                |
| Public + private subnets (NAT implied for the task) | No NAT; task in a public subnet, SG-restricted   | Saves ~US$33/month on a ~US$62 bill; ingress is still only from the ALB; RDS stays private.                                         |
| `/ws` origin behind CloudFront                      | `wss://ws.gede.work` direct to the ALB           | CloudFront's 60 s WebSocket idle cap breaks y-websocket rooms; the ALB allows 3600 s.                                               |
| Sign in with Apple as a live IdP                    | Wired behind CDK context `appleSignIn=false`     | Needs an Apple Developer team, Services ID and key; enabled by the runbook when those exist. The button is not rendered until then. |
| Staging and production stages with manual approval  | Production only                                  | Nine users, one operator; a staging stage is one `addStage` call and the approval step is already written but commented out.        |
| Domain `gede.1cloudhub.com`                         | `gede.work`                                      | Registered in the same AWS account so Route 53, ACM validation and the passkey RP id are all under one control.                     |
| GitHub source via CodeStar, staging → production    | CodeConnections, `main` → production             | Same GitHub App mechanism under its current name; single environment as above.                                                      |
| SES as the Cognito sender from day one              | Cognito built-in sender until SES leaves sandbox | SES production access is a support request; the built-in sender's 50/day covers nine users. Switching is one line (runbook).        |

## 8. Cost

About US$62 per month: ALB ≈ 18, Fargate ARM ≈ 15, RDS ≈ 15, WAF ≈ 6, CloudFront + S3 + Route 53 ≈ 3, CloudWatch ≈ 3, CodeBuild ≈ 2. Cognito is free under 50k MAU. The domain is US$14 per year. With a NAT gateway the figure would be about US$95.
