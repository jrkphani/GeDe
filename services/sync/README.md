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
| `PROJECTION_DEBOUNCE_MS`                             |                  | `1000`    | wait after a compaction before writing the projection   |
| `GEDE_VERSION`                                       |                  | build     | reported by `/healthz`; the short git sha in the image  |

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
- `POST /api/documents { title? }` → 201 `{ document }`. The room's initial state is written here
  (DOC-03): a Y.Doc seeded by `seedNewDocument` in `@gede/core` (`meta.title`, `meta.createdAt`,
  one sheet "Sheet 1" tagged `seeded`) goes to S3 as snapshot seq 1, and the `documents` row
  (`snapshot_key`/`snapshot_seq`), the `snapshots` row and the `document.create` audit row are
  inserted in one transaction. A new document therefore never opens empty and no client seeds
  one; the first client update is seq 2. If the insert fails after the object was written, the
  request answers 500 and the log names the orphaned key.
- `GET /api/documents/:id` → `{ document }` with the same fields as a library row.
  `PATCH /api/documents/:id { title }` (owner or editor). `DELETE /api/documents/:id` (owner) →
  204; moves the document to Recently Deleted and closes its room with 4404.
- `POST /api/documents/:id/recover` (owner) → `{ document }`; 409 when it is not deleted, 404 when
  its deletion is older than 30 days (it is no longer in Recently Deleted).
- `POST /api/documents/recover-all` (caller's documents deleted within 30 days) → `{ recovered }`.
- `POST /api/documents/delete-all` (every soft-deleted document the caller owns, retention or not)
  → `{ deleted }`. Rows in `documents`, `doc_updates`, `snapshots`, `shares`, `invites` go in one
  transaction with a `document.purge` audit row each; the S3 objects under `${DOCS_PREFIX}${docId}/`
  are deleted best-effort afterwards (a failure is logged with the document id).
- `GET /api/documents/:id/shares` (any participant) →
  `{ owner: { id, name, email }, participants: [{ userId, name, email, permission, invitedBy }], linkAccess }`.
  Email fields are populated for the owner and `edit` participants; a `view` participant receives
  `null` in every email field. Share and invite writes are Wave 3.
- `GET /api/documents/:id/search?q=<phrase>` (any participant) → `{ results: [{ sheetId, tableId,
rowId, columnId, snippet }] }`, at most 50, in sheet / table / row / column order. Every word of
  `q` must match a cell's `text_plain` (`to_tsvector('simple', text_plain) @@ plainto_tsquery('simple', q)`,
  the GIN index from migration 0000); `snippet` is a window of the cell text around the first match.
  It reads the projection (below), so a cell is findable once the room has compacted — within
  five minutes of the last edit, or on close. `q` is 1–200 characters; 400 otherwise.
- `GET /ws/:docId` — y-websocket protocol plus one server-to-client message, type 4
  `{ "code": "read-only" }`, sent once per view-only connection on its first rejected write (see
  `src/ws/protocol.ts`). The access token is offered as a subprotocol: `Sec-WebSocket-Protocol:
gede.v1, bearer.<access JWT>` (`new WebSocket(url, ['gede.v1', 'bearer.' + token])`); the server
  selects `gede.v1` and never echoes the bearer entry. `?token=<access JWT>` is still accepted for
  one release and logs a deprecation warning (never the token; the request log redacts the
  parameter) — it goes in the release after this one. Close codes: 4401 unauthenticated, 4403 not
  a participant / wrong origin, 4404 unknown or deleted document, 1001 on shutdown.

Errors are `{ error: { code, message, ref } }`; `ref` is also sent as `x-request-id`. A
non-participant gets 403 (never the title); a participant of a deleted document gets 404, the
"may have been deleted" page — only the owner can still read it, in Recently Deleted.

Audit rows (`audit_log.action`): `document.create`, `document.rename`, `document.delete`,
`document.recover`, `document.purge` (target = the title; the row outlives the document).
`user_id` is null on a `document.purge` written by the nightly job (the system actor); Delete All
writes the owner's id.

## Projection

The Projection Worker (`src/projection/`) materialises a document into the relational projection
tables — `sheets`, `tables`, `columns`, `rows`, `cells(text_plain, rich, formula)` — for search and
audit. It runs `PROJECTION_DEBOUNCE_MS` after every compaction (500 updates, 5 min idle, room
close) and once when a document is created, from the snapshot's own bytes, replacing the
document's rows in one transaction. `text_plain` is the text the editor shows (formula source or
flattened rich text), `rich` is the ProseMirror JSON of the cell's `Y.XmlFragment`, `formula` the
source of a formula cell. The projection is rebuildable and never read to reconstruct a document;
`--job reproject` (below) rebuilds it. Graphs are not projected yet (the CRDT slot has no
`pair_id`/`kind`/`table_id`).

## Jobs

The image runs one-off jobs with the same config, pool and migrations as the server:

```bash
node main.js --job purge                    # LIB-08: delete documents soft-deleted > 30 days ago
node main.js --job reproject <docId>|all    # rebuild the projection from snapshot + log
```

`purge` removes rows (one transaction per batch of 100, a `document.purge` audit row each with
`user_id` null), then the S3 objects under `${DOCS_PREFIX}${docId}/`; it exits 1 when any prefix
could not be removed (the rows are gone, the log names the prefix). EventBridge Scheduler runs it
nightly (`infra/lib/stacks/ops-stack.ts`); a non-zero exit alerts. `reproject all` skips deleted
documents and exits 1 if any document failed (its log line says which). See `docs/RUNBOOK.md`.

## Runbook

- **Recently Deleted retention.** Documents deleted more than 30 days ago drop out of the
  `deleted` view; the nightly purge job (`--job purge`, 02:30 Asia/Singapore) removes them for good,
  as Delete All does for an owner. `docs/RUNBOOK.md` "Nightly purge" has the commands.
- **Initial room state.** Written by `POST /api/documents` as snapshot seq 1 (above). Documents
  created before this shipped may still hold a client-seeded sheet; `ensureFirstSheet` and
  `dedupeSeededSheets` in `@gede/core` remain for them and are no-ops on a seeded replica.
- **Orphaned snapshot objects.** A `snapshot objects not purged` log line (level error) names the
  document id and prefix; delete `s3://$DOCS_BUCKET/$DOCS_PREFIX<docId>/` by hand or rerun
  Delete All as the owner (a second run finds no rows and touches nothing). The same line from the
  purge job makes it exit 1, which alerts. A `document insert failed after its seed snapshot`
  line names one orphaned `<docId>/1.yjs` object.

## Build and image

```bash
npm run build -w services/sync      # tsc -b + esbuild → dist/main.js, dist/migrations/*.sql
docker build --platform linux/arm64 -f services/sync/Dockerfile -t gede-sync:local .
```

## Tests

```bash
npx vitest run services/sync        # no Postgres or S3 needed: fakes are injected
DATABASE_URL=postgres://gede:gede@127.0.0.1:5432/postgres npx vitest run services/sync/src/repo
                                    # src/repo/pg.live.test.ts: the SQL against a throwaway database
                                    # (created and dropped per run); skipped when DATABASE_URL is unset
npm run db:parity -w packages/db    # applies migrations to a throwaway postgres:17 (needs Docker)
```

The pipeline's Synth step runs `db:parity` with `CI=true` (privileged CodeBuild, Docker available)
right after `npm run verify`, so every migration has run against a real PostgreSQL 17 before it
runs against production. Locally without Docker the script skips; with `CI=true` it fails.
