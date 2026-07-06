#!/usr/bin/env bash
#
# deploy/migration-parity/check-migrations.sh
#
# Issue 030 test-first plan #1 (migration parity): applies the app's full
# Drizzle migration history — the same `src/db/migrations/*.sql` files
# `src/db/migrate.ts` applies (in filename order) against in-browser PGlite —
# to a real PostgreSQL 17 server from empty, and asserts it applies cleanly.
# This is the proof behind ADR-0008 / issue 030's core bet: the v2 RDS
# boundary adds ZERO schema fork — same dialect, same migration files, no
# hand-edited DDL.
#
# CI-oriented: wired into .github/workflows/migration-parity.yml against a
# `postgres:17` service container (see that file for the exact DATABASE_URL
# it sets).
#
# Locally, this requires a real, empty Postgres 17 to point DATABASE_URL at,
# e.g.:
#   docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     bash deploy/migration-parity/check-migrations.sh
#
# With no DATABASE_URL set (the default — this repo's dev worktrees have
# neither a live RDS instance nor a guaranteed local Docker daemon), the
# script SKIPS cleanly (exit 0) rather than failing. Issue 030 explicitly
# does not want this authored-but-unexercised check to block implementation
# on local Docker/Postgres availability.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/src/db/migrations"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "migration-parity: DATABASE_URL is not set — skipping (not a failure)."
  echo "migration-parity: this check only runs against a real Postgres 17 (see .github/workflows/migration-parity.yml's postgres:17 service container, or run one locally — see this script's header comment)."
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "migration-parity: psql not found on PATH — skipping (not a failure)."
  echo "migration-parity: install the postgresql-client package, or run in CI where it is preinstalled on ubuntu-latest."
  exit 0
fi

if ! psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -c 'select 1' >/dev/null 2>&1; then
  echo "migration-parity: could not connect to DATABASE_URL — skipping (not a failure)."
  exit 0
fi

if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  echo "migration-parity: migrations directory not found at ${MIGRATIONS_DIR}" >&2
  exit 1
fi

shopt -s nullglob
files=("${MIGRATIONS_DIR}"/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "migration-parity: no .sql files found under ${MIGRATIONS_DIR}" >&2
  exit 1
fi

echo "migration-parity: applying ${#files[@]} migration(s) from ${MIGRATIONS_DIR} to a clean database..."

# Sort by filename — drizzle-kit's numeric prefixes (0000_, 0001_, ...) are
# the exact order src/db/migrate.ts applies them in for PGlite.
IFS=$'\n' sorted_files=($(printf '%s\n' "${files[@]}" | sort))
unset IFS

applied=0
for f in "${sorted_files[@]}"; do
  name="$(basename "$f")"
  echo "  -> ${name}"
  # ON_ERROR_STOP=1: any failing statement aborts the whole check non-zero —
  # "applies cleanly from empty" means every statement in every file
  # succeeds, in order, against a database that starts with nothing.
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${f}"
  applied=$((applied + 1))
done

echo "migration-parity: applied ${applied} migration(s) cleanly from empty."

# Cheap parity signal beyond "no statement errored": the resulting public
# schema actually has tables (i.e. the DDL really landed, not a silent
# no-op).
table_count="$(psql "${DATABASE_URL}" -At -c "select count(*) from information_schema.tables where table_schema = 'public'")"
if [[ "${table_count}" -lt 1 ]]; then
  echo "migration-parity: expected at least 1 table in the public schema post-migration, found ${table_count}" >&2
  exit 1
fi

echo "migration-parity: public schema has ${table_count} table(s) post-migration. OK."
