#!/usr/bin/env bash
# db:parity — apply every migration to a throwaway postgres:17 container, apply
# them a second time (must be a no-op), then check that every table and column
# declared in src/schema.ts exists in the live database.
#
# Skips cleanly (exit 0, message on stderr) when Docker is not available so
# `npm run verify` stays green on machines without it. CI runs it for real.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "db:parity: docker is not available; skipping" >&2
  exit 0
fi

name="gede-parity-$$"
port="${PARITY_PORT:-55432}"
password="parity"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "db:parity: starting postgres:17 on :$port"
docker run -d --rm --name "$name" \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_USER=gede -e POSTGRES_DB=gede \
  -p "$port:5432" postgres:17 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U gede -d gede >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name" pg_isready -U gede -d gede >/dev/null

export PGHOST=127.0.0.1 PGPORT="$port" PGUSER=gede PGPASSWORD="$password" PGDATABASE=gede PGSSLMODE=disable

cd "$root"
npx tsx packages/db/scripts/parity-check.ts
echo "db:parity: ok"
