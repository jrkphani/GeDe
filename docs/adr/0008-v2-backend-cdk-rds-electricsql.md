# ADR-0008: v2 backend — CDK VPC + RDS + ElectricSQL + better-auth

- **Status**: Accepted (the **auth** decision below is **superseded by [ADR-0009](0009-auth-cognito-over-better-auth.md)** — Cognito replaces better-auth; topology + sync stand)
- **Date**: 2026-07-06

## Context

v2 turns GeDe from a local-first single-user PWA into a collaborative product: an always-on server Postgres, bidirectional sync with the in-browser PGlite, authentication, workspaces, and multi-tenant RLS (issues 030–038). Two decisions were left open in TECH_STACK to be made "at v2 kickoff":

- **T5 — v2 database hosting.** The original sketch (TECH_STACK §6.3, issue 030 as first written) was **Postgres on a $10/mo Lightsail 2 GB box via Docker Compose** (Caddy · Postgres · sync · auth), RDS "only when ops pain justifies it." But issue 040 shipped an **AWS-native CDK** deployment (Network → Hosting → DNS), and `DEPLOYMENT.md §9` already described the v2 forward path as a **CDK-managed private VPC + NAT + managed RDS**. So §6.3 (Lightsail/Compose) and §9 (CDK/RDS) contradicted each other — building 030 as written would fork the deployment model away from the one 040 established.

- **T6 — sync engine.** ElectricSQL vs self-hosted Supabase, both Postgres-native, both open source; "decide at v2 kickoff."

These two are coupled: how the database is hosted constrains which sync engine is coherent, and both determine how auth (033) and RLS (034) are built.

## Decision

Adopt an **AWS-native, CDK-managed v2 backend**, resolving both open decisions together:

1. **Topology (T5) → CDK VPC + RDS.** v2 extends the issue-040 CDK app rather than introducing a second deploy model. The issue-040 `Gede-<Env>-Network` stack's forward-looking no-NAT VPC gains a **NAT gateway** + private/isolated subnet tiers; new stacks add **managed RDS PostgreSQL 17** in the isolated subnets (no public route; reachable only from the compute security group) and **compute (ECS Fargate)** in the private subnets behind the existing ALB seam. This supersedes the Lightsail + Docker Compose sketch (TECH_STACK §6.3, T5). The Postgres *dialect and migration history* are unchanged — the same Drizzle migrations run verbatim (ADR-0003); only the *hosting* changes.

2. **Sync engine (T6) → ElectricSQL.** Electric is a sync layer that runs **over our own Postgres** — it drops directly onto the RDS instance, matches GeDe's local-first PGlite↔Postgres shape-sync model, and preserves the core bet: one Postgres dialect, one migration history, UUIDv7 + `created_at`/`updated_at`/`deleted_at` on every row for LWW row-delta sync, derived layout never on the wire. Electric runs as a single container beside RDS.

3. **Auth (033) → better-auth (self-hosted).** _(SUPERSEDED by [ADR-0009](0009-auth-cognito-over-better-auth.md): auth is now **Amazon Cognito** — managed, no Fargate auth task, Google-Workspace-ready, lower cost. The rest of this ADR stands.)_ With Electric owning read-path sync and our own API owning the write path, auth is ours: a self-hosted **better-auth** service on Fargate, identity carried on the sync/API connection. RLS (034) is authored **directly in Postgres** and enforced at the Electric shape boundary.

## Why not self-hosted Supabase

Supabase bundles Postgres + Auth (GoTrue) + Realtime + PostgREST + RLS, so 033/034 would come partly "for free." But to honor the CDK+RDS topology it would have to be **self-hosted in full** (gotrue, realtime, postgrest, kong, …) — a much larger ops/attack surface than one Electric container + RDS — and its realtime model is broadcast, not the offline-first shape-sync PGlite reconciliation needs, so the local-first path would be DIY on top regardless. Supabase *cloud* would be lighter but then it hosts the database, contradicting the RDS decision. The bundled value is exactly what self-hosting on our own VPC makes expensive, and partly redundant with the RDS we already run.

## Consequences

- **Issue 030 is rewritten** from "Lightsail Postgres + Docker Compose" to "v2 network + RDS + compute (CDK)": add NAT + private/isolated tiers to the Network stack, a `Gede-<Env>-Data` (RDS) stack, and a `Gede-<Env>-Api` (Fargate: Electric sync + better-auth) stack. Migration-parity and tested-restore acceptance criteria carry over; backups become RDS automated backups/snapshots rather than `pg_dump` cron (the `pg_dump → S3` path stays documented as a portable-export escape hatch).
- **Cost rises** from the ~$10–15/mo Lightsail target to roughly **$30–60/mo** (RDS `db.t4g.micro` + NAT gateway + Fargate). This is the accepted price of an AWS-native, reproducible, single-deploy-model backend. Idle v1 hosting (§040) is unaffected (~$0).
- **Downstream issues inherit the choice**: 032 (Electric shape/row-delta wiring), 033 (better-auth), 034 (Postgres RLS at the Electric boundary), 035/037/038 unchanged in intent. Their References are updated to name Electric/better-auth instead of "T6 TBD."
- **TECH_STACK T5/T6 are marked Resolved**; §6.3 points here. `DEPLOYMENT.md §9` (already CDK/VPC/RDS) becomes the canonical v2 topology, no longer a "future sketch."
- **Issue 031** (the sync-engine spike) is satisfied by this ADR. The decision was taken analytically against the fixed CDK+RDS topology rather than by a running spike; if implementation surfaces a blocking Electric limitation, revisit here before writing 032.
