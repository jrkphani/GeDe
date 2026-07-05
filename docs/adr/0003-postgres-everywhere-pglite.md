# ADR-0003: PostgreSQL everywhere via PGlite

- **Status**: Accepted
- **Date**: 2026-07-04

## Context

v1 is single-user and local-first with a $0 infrastructure target; v2 adds Postgres-backed sync (workspace RLS, LWW row deltas). Selection criteria: open source, lowest AWS cost, no rewrite at the v1→v2 boundary. Alternatives considered: SQLite (dual-dialect cliff at v2), DynamoDB/Neptune (proprietary), MongoDB (SSPL), CouchDB (no multi-key constraints), Neo4j (GPLv3, server-only, kills $0 v1), Kùzu (development halted 2025).

## Decision

**PostgreSQL 17 is the only database engine for the project's life**: PGlite (Postgres-in-WASM, ~3 MB) in-browser for v1; the same schema on a server Postgres (Lightsail $5–10/mo) for v2. Drizzle ORM + drizzle-kit for schema-as-code and migrations from the first table.

## Consequences

- One SQL dialect, one migration history, RLS/constraints written once.
- v1 database cost is $0; the DB ships inside the app bundle.
- The domain's graph shape lives in the in-memory store, not the DB; the DB answers relational questions (coverage anti-joins, uniqueness, FK trees) which Postgres does natively.
- Escape hatch: Apache AGE adds openCypher inside Postgres if deep traversal queries ever appear — an extension, not a migration.
- Watch: PGlite bundle size/perf on low-end devices.
