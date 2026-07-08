# 053: PgWriteStore INSERT duplicated the `id` column (Postgres 42701)

- **Status**: SHIPPED — fixed in commit `ec13449` (`fix(043): exclude server-stamped columns from PgWriteStore INSERT`), verified live 2026-07-08 as part of 050's end-to-end write-loop test.
- **Milestone**: M11 (Close the cloud write loop)
- **Found via**: 050's live end-to-end smoke (sign-in → create project → verify in RDS via 049)

## Symptom

`POST /write` returned `502`; CloudWatch logs showed `error: column "id" specified more than once` (Postgres error code `42701`).

## Root cause

`src/server/writeApi/store.ts` built the INSERT statement as `INSERT INTO t (id, updated_at, <every payload key>)`, stamping `id`/`updated_at` explicitly and then appending **all** keys from the client's mutation payload — but the client payload also echoes `id` (and `updated_at`), so those columns were duplicated in the column list.

This was latent because `PgWriteStore` had never actually run against a real Postgres before: its 043 contract test uses a fake `pg` client that doesn't parse SQL, so a malformed statement like this would pass the test unnoticed. It only surfaced when 050's live end-to-end write test hit real RDS.

## Fix

Shipped in commit `ec13449`. Server-stamped columns (`id`, `updated_at`, `deleted_at`) are now excluded from the payload-derived columns for both insert and update:

```ts
const RESERVED_COLUMNS = new Set(['id', 'updated_at', 'deleted_at'])
const entries = Object.entries(mutation.payload).filter(([col]) => !RESERVED_COLUMNS.has(col))
```

(Superseded shortly after by commit `83dd4d9` — see 054 — which folds this exclusion into the camelCase→snake_case conversion, checking `SERVER_STAMPED` *after* the key conversion so `updatedAt` is also caught.)

## Follow-up (OPEN)

A **regression test** for `PgWriteStore` against a real Postgres — this bug and 054 were both latent because the contract test's fake `pg` client never parses SQL. A SQL-generation/live-DB test is being added in this same cleanup pass (see `src/server/writeApi/pgWriteStore.*.test.ts`). Track completion of that test separately; this issue's own fix has already shipped and is verified live.

**References**: 043 (original `PgWriteStore` implementation + its fake-pg contract test), 050 (the live end-to-end test that surfaced this), 054 (the immediately-following, related camelCase/snake_case bug — same systemic root cause).
