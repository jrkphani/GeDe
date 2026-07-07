# 045: Apply the Drizzle migration history to the deployed RDS

- **Status**: SHIPPED — code complete; combined verify green (837 vitest + 87 CDK jest + `cdk synth --all`, incl. new `Gede-Test-Migrations` stack); integrated on `m11-close-write-loop`. **Live AWS deploy pending** (CI on merge to `main`); the migrations apply to the deployed RDS at that point.
- **Milestone**: M11 (Close the cloud write loop)
- **Blocked by**: 030 (RDS instance + VPC — SHIPPED)

## Slice

As the operator of the v2 backend, the deployed RDS Postgres actually **has the schema** — all tables, indexes, and the workspace RLS policies from migrations `0000`–`0011` — so the write-path (046) has somewhere to write and RLS (034) is genuinely enforced on the server. Today the RDS is provisioned but **empty**: no migration mechanism has ever run against it.

## Motivation

The whole "one dialect, no migration cliff" bet (TECH_STACK §2, ADR-0008) assumes the *same* Drizzle migrations that run against browser PGlite also run against server Postgres. But **nothing in the deployed system applies them to the RDS**:

- `src/db/migrate.ts` runs migrations against **PGlite only** (its parameter is typed `PGlite`; the SQL is bundled via Vite `import.meta.glob` in the browser).
- The only server-Postgres path, `deploy/migration-parity/check-migrations.sh`, applies the migrations to a **throwaway `postgres:17` container in CI** to prove *parity* — it never touches the deployed RDS.
- The one compute resource that reaches the RDS (the 043 write Lambda) is a `503` stub that never opens a connection.

So the RDS is an empty database. The server-side RLS policies (034) exist only as `.sql` files, not as live policies. This must be fixed before 046 (deploy the real handler) or the first real write fails on a missing table.

## AWS ground truth (verified 2026-07-07)

- **RDS** `gede-test-data-databaseb269d8bb-qz2k82jhfezk.cc5kmayi8lnm.us-east-1.rds.amazonaws.com`: engine `postgres`, status `available`, `db.t4g.micro`, 20 GB, **`PubliclyAccessible=false`**, isolated subnets, no internet route.
- **Reachability**: no bastion/EC2 in `vpc-0480acfd2fe498678` (0 running instances), so the DB is reachable **only from inside the VPC** (the compute SG). Credentials live in Secrets Manager (`Gede-Test-Data` output `DatabaseSecretArn = arn:aws:secretsmanager:us-east-1:975049998516:secret:GedeTestDataDatabaseSecretD-RQSoeipmUaWt-i9ZEmH`).
- **DB security group** `sg-0584f9a338281fca4` admits `:5432` from the write Lambda SG (`sg-063bbc30b9dbdcc62`) and the sync SG (`sg-0557cc2b8226fb08e`) — the network path exists; only the *applier* is missing.

## Scope

- **A one-shot migration runner that executes inside the VPC** (it must be — the RDS has no public route). Options, cheapest first:
  - a **CDK `AwsCustomResource` / provider Lambda** (VPC-attached, in the private subnets, SG allowed into the DB SG) that runs the Drizzle SQL files in filename order on deploy, or
  - a short-lived **Fargate/CodeBuild task** invoked from the deploy pipeline.
- **Reuse the existing SQL** (`src/db/migrations/*.sql`) and the same filename-order application the runtime migrator + parity check already use — do **not** fork a second migration path. The runner applies `0000`–`0011` and records them so re-runs are idempotent (skip already-applied).
- **RLS/least-priv roles**: apply 034's `app_user` role + RLS policies (they're inert on PGlite because it connects as owner; they must be live on the server). Confirm the write Lambda connects as the least-priv role, not the master user.
- **Credentials from Secrets Manager** (never hardcoded); the runner reads the `DatabaseSecretArn`.

Out of scope: authoring any new migration (this applies the existing history); the write handler itself (046); TLS (047).

## Design brief

- **Idempotent + ordered**: same discipline as `src/db/migrate.ts` and `check-migrations.sh` — apply in filename order, track applied files, safe to re-run on every deploy.
- **In-VPC by necessity**: the RDS is isolated by design (DEPLOYMENT §9); the applier goes to the data, the data does not come to the applier. No "temporarily make RDS public" shortcuts.
- **One migration source of truth**: PGlite (browser), the CI parity container, and the RDS all consume the *same* `.sql` files. If they diverge, that's a bug in this runner, not a second dialect.

**References**: TECH_STACK §2 (one dialect / no migration cliff), §6.4 (deploy pipeline) · ADR-0008 (RDS) · issue 034 (RLS policies, `app_user` role, migration `0008`) · issue 043 (the write path that needs the schema) · `deploy/migration-parity/check-migrations.sh` (the parity proof to mirror) · DEPLOYMENT §9.

## Test-first plan

1. **Runner idempotency (unit/integration against a local `postgres:17`)**: applying `0000`–`0011` to a fresh DB creates the expected tables; a second run is a no-op (no error, no duplicate DDL).
2. **RLS live (integration)**: after applying, a connection as `app_user` with `app.current_user_id`/`app.current_workspace_id` set sees only its workspace's rows; cross-tenant `SELECT` returns nothing — i.e. 034's policies are actually enforced (they were inert on PGlite).
3. **Parity guard (CI)**: the runner and `check-migrations.sh` apply the identical file set (assert the migration list matches, so the deployed schema can't silently drift from the parity proof).
4. **Deploy smoke**: post-deploy, `\dt` (via the runner's own logging or a diagnostic query) shows the full table set on the RDS.

## Acceptance criteria

- [ ] The deployed RDS contains all tables/indexes/policies from `0000`–`0011`; a fresh query as `app_user` is RLS-scoped.
- [ ] The migration runner is **idempotent** and runs **inside the VPC** from the deploy pipeline; credentials come from Secrets Manager.
- [ ] The RDS applies the **same** `.sql` files as PGlite and the parity check (no forked SQL).
- [ ] `npm run verify` + CDK assertions green; a post-deploy check confirms the schema is present.

## Implementation notes

- A VPC-attached provider Lambda is the `$0`-idle option and matches the serverless posture of 043/ADR-0010. Give it the same DB-facing SG as the write Lambda (or reuse it).
- Watch migration-slot hygiene (HANDOFF): the `.sql` files are the runtime source; the drizzle-kit snapshot chain is not read by the applier. Apply strictly by filename order.
- This is a hard prerequisite for 046 — deploy the real handler only after the schema exists, or the first write 500s on a missing relation.
