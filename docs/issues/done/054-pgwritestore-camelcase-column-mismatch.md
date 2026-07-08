# 054: PgWriteStore used camelCase payload keys as snake_case SQL columns (Postgres 42703)

- **Status**: SHIPPED — fixed in commit `83dd4d9` (`fix(043): convert camelCase payload keys to snake_case columns in PgWriteStore`), verified live 2026-07-08 as part of 050's end-to-end write-loop test.
- **Milestone**: M11 (Close the cloud write loop)
- **Found via**: 050's live end-to-end smoke (sign-in → create project → verify in RDS via 049)

## Symptom

Immediately after 053's fix shipped, `POST /write` still returned `502`; CloudWatch logs showed `error: column "workspaceid" of relation "projects" does not exist` (Postgres error code `42703`).

## Root cause

Client mutation payloads carry Drizzle's **camelCase** JS field names (e.g. `workspaceId`), but the DB columns are **snake_case** (`workspace_id`). `src/server/writeApi/store.ts` used the payload keys verbatim as SQL column names, so `workspaceId` was sent literally instead of being converted — Postgres folds unquoted identifiers to lowercase, so `workspaceId` became `workspaceid`, which doesn't exist. (See `electricProtocol.ts`'s `SQL_TO_JS_COLUMNS` for the canonical mapping this should have mirrored.)

Same systemic root cause as 053: `PgWriteStore` had never run against a live Postgres before (its contract test uses a fake `pg` client that doesn't parse SQL), so this mismatch was latent until 050's live write test.

## Fix

Shipped in commit `83dd4d9`. Each payload key is now converted to its snake_case SQL column name (regular camel→snake), with the server-stamped-column exclusion applied *after* conversion (so `updatedAt` is also correctly excluded, not just `updated_at`):

```ts
const SERVER_STAMPED = new Set(['id', 'updated_at', 'deleted_at'])
const toSqlColumn = (jsKey: string): string => jsKey.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
const entries = Object.entries(mutation.payload)
  .map(([jsKey, value]) => [toSqlColumn(jsKey), value] as const)
  .filter(([col]) => !SERVER_STAMPED.has(col))
```

## Follow-up (OPEN)

Shares 053's follow-up: a **regression test** for `PgWriteStore` against a real Postgres (`src/server/writeApi/pgWriteStore.*.test.ts`), since the 043 contract test's fake `pg` client never parses SQL and so cannot catch either the duplicate-column or the camelCase/snake_case class of bug. Track completion of that test separately; this issue's own fix has already shipped and is verified live.

**References**: 043 (original `PgWriteStore` implementation), `src/sync/electricProtocol.ts` (`SQL_TO_JS_COLUMNS`, the mapping this fix mirrors), 050 (the live end-to-end test that surfaced this), 053 (the immediately-preceding, related duplicate-`id`-column bug — same systemic root cause).
