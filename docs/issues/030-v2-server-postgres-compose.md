# 030: v2 server — Lightsail Postgres + Docker Compose + backups

- **Status**: OPEN
- **Milestone**: M8 (Server & sync)
- **Blocked by**: 029 (deploy account/OIDC exist); pairs with 031 (sync-engine choice fills the `sync`/`auth` services)

## Slice

As the maintainer I can stand up the v2 backend — real **PostgreSQL 17** plus TLS termination and a reverse proxy — from a single **Docker Compose** file on a **$10/mo Lightsail 2 GB** instance, running the **exact same Drizzle migrations** as the in-browser PGlite, with automated backups. This is the always-on Postgres every collaboration feature depends on, provisioned as code so it stays portable off AWS.

## Motivation

TECH_STACK §6.3 specifies the v2 server as a Lightsail Docker Compose stack (Caddy · Postgres 17 · sync · auth) and §2 promises the v1 schema/migrations/RLS/constraints move to the server **verbatim** — the whole PGlite-now/Postgres-later bet (T5) only pays off if that migration path is real and tested. This issue proves it: same `pg` dialect, same migration history, no rewrite.

## Scope

- **`deploy/compose/` Docker Compose stack**:
  - **Caddy** — TLS termination (automatic ACME) + reverse proxy to the API/sync services on `api.<domain>`.
  - **postgres:17** — the database; a volume for data; tuned for a 2 GB box.
  - **sync** and **auth** service *slots* — declared but populated by 031 (sync engine) and 033 (auth); this issue leaves them as documented placeholders wired into Caddy, not implemented.
- **Migrations on the server**: run the existing `drizzle-kit` migration history against server Postgres and prove it applies cleanly from empty (the same files v1 runs against PGlite — no dialect fork, no hand-edited DDL, global rule).
- **Backups** (§6.3): nightly `pg_dump` → S3 with a lifecycle rule → Glacier at 90 days, plus a weekly Lightsail snapshot. Restore is documented and test-restored once.
- **Provisioning as code**: the Compose file + Caddyfile + backup cron live in `deploy/` and are the deployment contract; the box can be recreated from them (portable off AWS unchanged, §6.3).

Out of scope: the sync protocol itself (031/032); auth (033); RLS policy authoring (034 — though the schema is already RLS-ready per §2); RDS/Aurora migration (T5 — only when ops toil justifies it).

## Design brief

- **Same engine, same migrations, top to bottom**: the server runs the identical Postgres 17 dialect and the identical Drizzle migration files — the v2 boundary must add *zero* schema churn (SPEC sync-readiness: UUIDv7 keys + `created_at`/`updated_at`/`deleted_at` on every row are already there for LWW row-delta sync, §2).
- **Cheapest always-on, portable**: Lightsail over RDS/Aurora until backup/patching toil exceeds the cost delta (T5). The Compose file means the same stack runs on any Docker host.
- **Recoverable by default**: a database with no tested restore is not a backup. Prove `pg_dump` → restore into a clean box once and document it.

**References**: TECH_STACK §2 (Postgres everywhere; §2 "v2 server adopts LWW row-delta sync without column changes"), §6.3 (v2 stack + backups), §6.4 (Actions-only deploy), T5 (Lightsail vs RDS) · SPEC §3 (sync-ready schema invariants) · global rule: migrations only, no direct schema edits.

## Test-first plan

1. **Migration parity**: a CI/script step applies the full `drizzle-kit` history to a throwaway `postgres:17` container from empty and asserts the final schema matches (same migrations that pass against PGlite in the unit suite).
2. **Compose up**: `docker compose up` brings Caddy + Postgres healthy; Caddy serves TLS and proxies `api.<domain>` (healthcheck endpoints green).
3. **Backup round-trip**: `pg_dump` a seeded DB → restore into a fresh container → row counts + a checksum match. Runs in CI against ephemeral containers.
4. **Config lint**: Caddyfile + Compose validate; Postgres is not exposed publicly (only Caddy/private network).

## Acceptance criteria

- [ ] `docker compose up` yields a healthy Caddy + Postgres 17 stack on a 2 GB box, TLS on `api.<domain>`.
- [ ] The v1 Drizzle migration history applies to server Postgres from empty with no edits — proven in CI.
- [ ] Nightly `pg_dump → S3 → Glacier(90d)` + weekly snapshot configured; a restore is tested and documented.
- [ ] Stack + backup are codified in `deploy/`; Postgres is never publicly exposed.

## Implementation notes

- The `sync` and `auth` Compose services are stubs here — 031 decides Electric vs Supabase (which changes what fills `sync`, and possibly folds `auth` into Supabase), 033 fills auth. Wire the Caddy routes so those slots drop in without re-architecting.
- Keep secrets (DB password, backup creds) out of the repo — Lightsail/Compose env from a secret store, mirroring the no-standing-secrets stance of 029.
- v2 cost target ~$10–15/month all-in (§6.3).
