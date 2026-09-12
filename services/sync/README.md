# services/sync

Sync & API service: Fastify 5 REST under `/api`, y-websocket document rooms under
`/ws/:docId`, Cognito JWT verification, persistence to Postgres (`doc_updates`) and S3
(snapshots). Migrations from `packages/db/migrations` run at boot under an advisory lock.

## Environment

| Variable                                             | Required         | Default   | Notes                                                   |
| ---------------------------------------------------- | ---------------- | --------- | ------------------------------------------------------- |
| `PORT`                                               |                  | `3000`    |                                                         |
| `LOG_LEVEL`                                          |                  | `info`    | pino level                                              |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | yes              |           | libpq names; injected from Secrets Manager in ECS       |
| `PGSSLMODE`                                          |                  | `disable` | `verify-full` in production                             |
| `PGSSLROOTCERT`                                      | with verify-full |           | `/app/rds-global-bundle.pem` in the image               |
| `COGNITO_USER_POOL_ID`                               | yes              |           |                                                         |
| `COGNITO_CLIENT_ID`                                  | yes              |           | access tokens are verified with `tokenUse: 'access'`    |
| `COGNITO_REGION`                                     | yes              |           | also the S3 client region                               |
| `DOCS_BUCKET`                                        | yes              |           | S3 bucket for snapshots                                 |
| `DOCS_PREFIX`                                        |                  | ``        | key prefix, e.g. `docs/`                                |
| `WEB_ORIGIN`                                         | yes              |           | exact SPA origin; CORS and the WebSocket `Origin` check |
| `SNAPSHOT_EVERY_UPDATES`                             |                  | `500`     | compact after this many persisted updates               |
| `SNAPSHOT_IDLE_MS`                                   |                  | `300000`  | …or after this long idle                                |
| `ROOM_IDLE_MS`                                       |                  | `600000`  | evict a room this long after its last socket leaves     |
| `GEDE_VERSION`                                       |                  | build     | reported by `/healthz`                                  |

There is no auth bypass in any environment. Tests inject a fake verifier through `buildServer` deps.

## Local run

Start a Postgres (any 16+; `createdb gede`), then:

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gede PGPASSWORD=gede PGDATABASE=gede PGSSLMODE=disable
export COGNITO_USER_POOL_ID=… COGNITO_CLIENT_ID=… COGNITO_REGION=ap-southeast-1
export DOCS_BUCKET=… WEB_ORIGIN=http://localhost:5173
npm run dev -w services/sync        # tsx watch src/main.ts; migrations apply on boot
curl -i localhost:3000/healthz
```

`apps/web`'s Vite dev server proxies `/api` and `/ws` to `:3000`.

## Endpoints

- `GET /healthz` — `{ ok, version }`; 503 when `SELECT 1` fails.
- `GET /api/me`
- `GET /api/documents[?view=deleted]`, `POST /api/documents { title? }`,
  `GET|PATCH|DELETE /api/documents/:id`
- `GET /ws/:docId?token=<access JWT>` — y-websocket protocol. Close codes: 4401 unauthenticated,
  4403 not a participant / wrong origin, 4404 unknown or deleted document, 1001 on shutdown.

Errors are `{ error: { code, message, ref } }`; `ref` is also sent as `x-request-id`.

## Build and image

```bash
npm run build -w services/sync      # tsc -b + esbuild → dist/main.js, dist/migrations/*.sql
docker build --platform linux/arm64 -f services/sync/Dockerfile -t gede-sync:local .
```

## Tests

```bash
npx vitest run services/sync        # no Postgres or S3 needed: fakes are injected
npm run db:parity -w packages/db    # applies migrations to a throwaway postgres:17 (needs Docker)
```
