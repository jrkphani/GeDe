# packages/db — conventions

Drizzle schema, numbered SQL migrations and the migration runner for PostgreSQL 17.
Consumed by `services/sync` (which runs the migrations on boot). Read the root `CLAUDE.md` first.

## Schema is the digest

`src/schema.ts` mirrors `docs/ARCHITECTURE-DIGEST.md` §1.5 exactly: table names, column names, types, nullability and primary keys. If the digest and the schema disagree, fix the schema or change the digest in the same PR with the reason; never let them drift silently.

Authoritative tables: `users`, `documents`, `shares`, `invites`, `doc_updates`, `snapshots`.
Projection tables (rebuildable): `sheets`, `tables`, `columns`, `rows`, `cells`, `graphs`, `audit_log`.

## Migrations

- Every schema change is a new numbered file in `migrations/` (`0007_add_x.sql`) plus the matching `schema.ts` change, in the same PR. `npm run generate -w packages/db` (drizzle-kit) produces the SQL; review it before committing.
- Never edit a migration that has reached `main`. `main` is production; the file has already run. Write a new migration that alters or reverts.
- Migrations are plain SQL, forward-only, idempotent where PostgreSQL allows (`IF NOT EXISTS`). Each runs in a transaction; the runner records it in `__migrations(name, applied_at)`. `migrations.test.ts` refuses any `DROP` other than `DROP CONSTRAINT` and any `TRUNCATE`/`DELETE FROM`; a column added later must use `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <c>` so the schema-parity test can find it.
- The runner takes `pg_advisory_lock` before reading `__migrations` and releases it after the last statement, so two tasks booting at once cannot race; the wait is bounded by `lock_timeout` (2 min), an unlock failure never masks the error that caused it, and the session limits the runner sets are `RESET` before its connection returns to the pool.
- The ledger records the SHA-256 of every applied file (migration 0005, `checksum`). A file whose text differs from its row fails the boot with the file named; rows from before 0005 are pinned on the next run. So: never edit a shipped file, not even a comment — write a new one.
- Every foreign key a cascade or the projection walks has an index (migration 0004); declare new ones in `schema.ts` as well, `migrations.test.ts` and `db:parity` check both directions.
- Tests run migrations from zero against a throwaway database and assert the resulting schema; there is no other way to know a migration works. `npm run db:parity` does this in Docker; the pipeline's Synth step runs it with `CI=true` (where a missing Docker is a failure) before anything deploys.

## Types

- Emails are `citext` (`CREATE EXTENSION IF NOT EXISTS citext` in migration 0000). Uniqueness on `users.email` and lookups on `invites.email` are case-insensitive by type, not by `lower()`.
- Ids that come from the CRDT (`sheets.id`, `tables.id`, `columns.id`, `rows.id`, `graphs.id`) are `text` ULIDs. Relational ids (`users`, `documents`, `invites`) are `uuid`.
- `doc_updates.update` is `bytea`. `cells.rich`, `columns.format_opts`, `columns.derived`, `graphs.slice`, `tables.options`, `cells.style` are `jsonb`.
- Enums are PostgreSQL enums declared in migrations and mirrored with `pgEnum` in `schema.ts`: `link_access(none, view, edit)`, `permission(view, edit)`, `column_format(auto, text, number, currency, date)`, `graph_kind(ring, coverage)`.
- Timestamps are `timestamptz`, defaulted to `now()` in the database, never set by the application.

## Source of truth

- The Yjs CRDT is the source of truth for cell content and document structure. `doc_updates` + `snapshots` are the CRDT's durable form.
- Projection tables exist for search, audit and reporting. They are written only by the projection worker in `services/sync`, never by a request handler and never by a user action. A projection table can be truncated and rebuilt from the CRDT at any time; a migration that makes that untrue is wrong.
- `cells` carries `gin(to_tsvector('simple', text_plain))` for search (FIND-03). Do not add a full-text engine.

## Package shape

- Exports: `schema` (Drizzle tables and enums), `applyMigrations(pool, dir, options)`, and `createPool(env)` (TLS `verify-full` with the RDS CA bundle from `PGSSLROOTCERT`; with `NODE_ENV=production` any other `PGSSLMODE` is refused). Every pooled session carries `statement_timeout` 30 s, `lock_timeout` 10 s and `idle_in_transaction_session_timeout` 30 s (`POOL_TIMEOUTS`).
- Unique constraints the service matches by name (`users_email_key`) are named explicitly in `schema.ts`; keep them equal to what the SQL created.
- No business logic here. Queries that encode permissions or document rules belong in `services/sync`.
- Dev dependencies only for `drizzle-kit`; runtime dependencies are `drizzle-orm` and `pg`.

## Tests

Vitest. Migration tests need `DATABASE_URL` pointing at a local PostgreSQL 17 (`docker run -e POSTGRES_PASSWORD=gede -p 5432:5432 postgres:17`); they skip with a logged reason when it is absent. Test names start with the requirement id where one applies (`test('SHARE-02 invite expires after 14 days', …)`).
