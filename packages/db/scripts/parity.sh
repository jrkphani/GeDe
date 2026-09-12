#!/usr/bin/env bash
# db:parity — apply every migration to a throwaway postgres:17 container, apply
# them a second time (must be a no-op), then check that every table and column
# declared in src/schema.ts exists in the live database. The least-privilege
# app role is bootstrapped on both runs (as in production) and its privileges
# are asserted from a connection as that role (#36).
#
# Locally, skips cleanly (exit 0, message on stderr) when Docker is not
# available so a laptop without it is not blocked. In the pipeline (`CI=true`,
# set on the Synth step in infra/lib/pipeline-stack.ts, whose CodeBuild
# project runs privileged so Docker is there) a missing Docker is a failure:
# the migrations must have run somewhere before they run against production.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [ "${CI:-}" = "true" ]; then
    echo "db:parity: CI=true but docker is not available; the migrations were not exercised" >&2
    exit 1
  fi
  echo "db:parity: docker is not available; skipping (set CI=true to make this a failure)" >&2
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
export PGAPPUSER=gede_app PGAPPPASSWORD="parity-app"

cd "$root"
npx tsx packages/db/scripts/parity-check.ts
echo "db:parity: ok"
