# 030: v2 server — CDK VPC + RDS + compute (Electric/better-auth slots)

- **Status**: SHIPPED — all 5 stacks live & verified (PR #3 + deploy fixes #4/#5/#6); RDS 17.9 private/isolated, Fargate sync/auth stubs healthy behind the ALB
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 029 (deploy account/OIDC exist), 040 (the CDK app this extends); pairs with 031 (**decided** — ADR-0008: ElectricSQL)

> **Superseded framing**: this issue originally specified a **Lightsail + Docker Compose** stack. ADR-0008 (T5/T6 resolved at v2 kickoff) changed the v2 backend to **AWS-native CDK: VPC + NAT + RDS + Fargate**, extending the issue-040 app rather than forking a second deploy model. The content below reflects that decision.

## Slice

As the maintainer I can stand up the v2 backend — a **managed RDS PostgreSQL 17** in private isolated subnets, plus the **compute tier** (ECS Fargate) that will host the ElectricSQL sync service and the better-auth service — by extending the **issue-040 CDK app** (`deploy/cdk/`), running the **exact same Drizzle migrations** as the in-browser PGlite, with managed backups. This is the always-on Postgres every collaboration feature depends on, provisioned as code in the same single-deploy-model pipeline (029) that already ships v1.

## Motivation

ADR-0008 makes the v2 backend AWS-native CDK (VPC + NAT + RDS + Fargate), superseding the Lightsail/Compose sketch and reconciling the contradiction between TECH_STACK §6.3 and `DEPLOYMENT.md §9`. §2 promises the v1 schema/migrations/RLS/constraints move to the server **verbatim** — the whole PGlite-now/Postgres-later bet only pays off if that migration path is real and tested. This issue proves it against **real RDS**: same `pg` dialect, same migration history, no rewrite; and it lands the network + data + compute foundation the sync (032) and auth (033) services drop into.

## Scope

- **Network stack extension** (`Gede-<Env>-Network`, from issue 040): add a **NAT gateway** and the **private (compute)** + **isolated (data)** subnet tiers the v1 stack was written to grow into (§9). v1's no-NAT static path is unchanged.
- **`Gede-<Env>-Data` stack**: **RDS PostgreSQL 17** (`db.t4g.micro` to start) in the **isolated** subnets — no public route, reachable only from the compute security group; encryption at rest; automated backups + snapshots enabled. Credentials in Secrets Manager (no standing secrets, mirroring 029).
- **`Gede-<Env>-Api` stack**: the **Fargate compute tier** behind the ALB seam, with **sync** and **auth** service *slots* — declared and wired into the ALB/DNS, but populated by 031→**032** (ElectricSQL sync container) and **033** (better-auth). This issue leaves them as documented, health-checked placeholders, not implemented.
- **Migrations on the server**: run the existing `drizzle-kit` migration history against **RDS** and prove it applies cleanly from empty (the same files v1 runs against PGlite — no dialect fork, no hand-edited DDL, global rule).
- **Backups**: **RDS automated backups** (point-in-time) + retained snapshots; the `pg_dump → S3 → Glacier` path stays **documented as a portable-export escape hatch** (off-AWS recovery), test-restored once.
- **All in `deploy/cdk/`**: new stacks + the network extension are the deployment contract, deployed by the **same 029 OIDC pipeline** (`cdk deploy --all`). No second deploy model.

Out of scope: the sync protocol itself (031 decided → 032 implements); auth (033); RLS policy authoring (034 — the schema is already RLS-ready per §2).

## Design brief

- **One deploy model, extended not forked**: v2 grows the issue-040 CDK app (network → +NAT/subnets → +RDS → +Fargate), deployed by the 029 pipeline. No Compose, no second toolchain (ADR-0008).
- **Same engine, same migrations, top to bottom**: RDS runs the identical Postgres 17 dialect and the identical Drizzle migration files — the v2 boundary adds *zero* schema churn (UUIDv7 keys + `created_at`/`updated_at`/`deleted_at` already there for LWW row-delta sync, §2).
- **Private by default**: RDS in isolated subnets, no public IP; compute in private subnets, egress via NAT only; only the ALB is internet-facing (§9). Postgres is never publicly exposed.
- **Recoverable by default**: a database with no tested restore is not a backup. Prove a restore (from an RDS snapshot and via the `pg_dump` escape hatch) once and document it.

**References**: **ADR-0008** (v2 backend: CDK VPC + RDS + ElectricSQL + better-auth) · `DEPLOYMENT.md §9` (v2 topology, now canonical) · issue **040** (the CDK app + stacks this extends) · issue **029** (the OIDC pipeline that deploys it) · TECH_STACK §2 (Postgres everywhere), §6.3/T5/T6 (**resolved** by ADR-0008) · SPEC §3 (sync-ready schema invariants) · global rule: migrations only, no direct schema edits.

## Test-first plan

1. **Migration parity**: a CI/script step applies the full `drizzle-kit` history to a throwaway `postgres:17` container (and, in a deploy smoke step, to the real RDS) from empty and asserts the final schema matches the one the unit suite validates against PGlite.
2. **CDK assertion tests** (mirror 040's `deploy/cdk/test/`): the Network stack now has a NAT gateway + private/isolated subnets; the Data stack's RDS is not publicly accessible and sits in isolated subnets; the Api stack's services are ALB-fronted with healthchecks; app-wide tags propagate.
3. **Backup round-trip**: restore an RDS snapshot into a fresh instance **and** `pg_dump → restore` into a clean container → row counts + a checksum match.
4. **Private-exposure check**: RDS security group admits only the compute SG; no `0.0.0.0/0` ingress; Postgres has no public endpoint.

## Acceptance criteria

- [ ] `cdk deploy --all` (via the 029 pipeline) yields the extended Network (NAT + private/isolated) + `Gede-<Env>-Data` (RDS 17, private) + `Gede-<Env>-Api` (Fargate, health-checked sync/auth slots) stacks.
- [ ] The v1 Drizzle migration history applies to **RDS** from empty with no edits — proven in CI/deploy smoke.
- [ ] RDS automated backups + snapshots configured; a restore is tested and documented (plus the `pg_dump` escape hatch).
- [ ] CDK assertion tests cover the new stacks; RDS is never publicly exposed; secrets live in Secrets Manager.

## Implementation notes

- The `sync` and `auth` Fargate services are stubs here — **031 is decided (ADR-0008: ElectricSQL)**, so 032 fills `sync` with the Electric container and 033 fills `auth` with better-auth. Wire the ALB routes + service discovery so those slots drop in without re-architecting.
- Keep secrets (DB credentials, service tokens) in **Secrets Manager**, injected into Fargate task definitions — never in the repo, mirroring 029's no-standing-secrets stance.
- Cost target rises to ~**$30–60/month** all-in (RDS + NAT + Fargate) per ADR-0008 — the accepted price of the AWS-native single-deploy-model backend. v1 static hosting (040) stays ~$0.
- Pre-assign the migration slot before any schema-touching sibling (032/034) runs in parallel, per the HANDOFF worktree discipline.
