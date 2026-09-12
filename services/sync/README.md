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

Every `/api` route except `/api/health` needs `Authorization: Bearer <Cognito access token>`.

- `GET /healthz`, `GET /api/health` — `{ ok, version }`; 503 when `SELECT 1` fails. No auth.
- `GET /api/me` → `{ id, sub, email, displayName, locale }`.
  `PATCH /api/me { displayName?, locale? }` — display name 1–80 characters after trimming;
  locale one of `en-US en-GB en-IN ta-IN hi-IN te-IN`; at least one field (I18N-05, AUTH-09).
- `GET /api/documents?view=recents|browse|shared|deleted` (default `recents`) →
  `{ documents: [{ id, title, kind: 'workscape', sizeBytes, createdAt, updatedAt, ownerId, ownerName,
sharedBy?: { id, name }, sharedWithOthers, permission: 'owner'|'edit'|'view', linkAccess, deletedAt }] }`.
  `recents` = owned + shared with me, live, newest `updatedAt` first; `browse` = owned, live;
  `shared` = shared with me plus my own documents that have shares (`sharedWithOthers: true`);
  `deleted` = owned, deleted within 30 days. `sizeBytes` is the latest snapshot plus every update
  logged since it, computed in the same query. `ownerName` / `sharedBy.name` fall back to the
  person's email and are `null` when neither is known.
- `POST /api/documents { title? }` → 201 `{ document }`.
- `GET /api/documents/:id` → `{ document }` with the same fields as a library row.
  `PATCH /api/documents/:id { title }` (owner or editor). `DELETE /api/documents/:id` (owner) →
  204; moves the document to Recently Deleted and closes its room with 4404.
- `POST /api/documents/:id/recover` (owner) → `{ document }`; 409 when it is not deleted.
- `POST /api/documents/recover-all` (caller's documents deleted within 30 days) → `{ recovered }`.
- `POST /api/documents/delete-all` (every soft-deleted document the caller owns, retention or not)
  → `{ deleted }`. Rows in `documents`, `doc_updates`, `snapshots`, `shares`, `invites` go in one
  transaction with a `document.purge` audit row each; the S3 objects under `${DOCS_PREFIX}${docId}/`
  are deleted best-effort afterwards (a failure is logged with the document id).
- `GET /api/documents/:id/shares` (any participant) →
  `{ owner: { id, name, email }, participants: [{ userId, name, email, permission, invitedBy }], linkAccess }`.
  Share and invite writes are Wave 3.
- `GET /ws/:docId?token=<access JWT>` — y-websocket protocol plus one server-to-client message,
  type 4 `{ "code": "read-only" }`, sent once per view-only connection on its first rejected write
  (see `src/ws/protocol.ts`). Close codes: 4401 unauthenticated, 4403 not a participant / wrong
  origin, 4404 unknown or deleted document, 1001 on shutdown.

Errors are `{ error: { code, message, ref } }`; `ref` is also sent as `x-request-id`. A 403 never
carries the document's title.

Audit rows (`audit_log.action`): `document.create`, `document.rename`, `document.delete`,
`document.recover`, `document.purge` (target = the title; the row outlives the document).

## Runbook

- **Recently Deleted retention.** Documents deleted more than 30 days ago drop out of the
  `deleted` view but stay in the database (and their snapshots in S3) until their owner runs
  Delete All. TODO(LIB-08): a nightly purge of `documents.deleted_at < now() - 30 days` — same
  transaction shape as `purgeDeleted` in `src/repo/pg.ts`, then `deletePrefix` per document — is
  not built yet; it needs a scheduler (EventBridge → one-off ECS task or an in-process cron guarded
  by an advisory lock) and is tracked for a later wave.
- **Orphaned snapshot objects.** A `snapshot objects not purged` log line (level error) names the
  document id and prefix; delete `s3://$DOCS_BUCKET/$DOCS_PREFIX<docId>/` by hand or rerun
  Delete All as the owner (a second run finds no rows and touches nothing).

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
