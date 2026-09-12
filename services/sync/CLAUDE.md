# services/sync — conventions

Fastify 5 + `ws`. One process serves the y-websocket document rooms and the REST API.
Runs on ECS Fargate ARM64 behind an ALB; `/api/*` arrives via CloudFront, `wss://ws.gede.work` arrives directly.
Read the root `CLAUDE.md` first.

## Authentication and permission (SHARE-03)

- Every REST route under `/api` and every WebSocket upgrade verifies the Cognito **access** JWT (signature, issuer, client id, expiry) with `aws-jwt-verify`, then resolves the caller's permission on the target document server-side from `documents` + `shares` (+ `link_access`).
- REST carries the token as `Authorization: Bearer`. The WebSocket upgrade carries it as a subprotocol, `Sec-WebSocket-Protocol: gede.v1, bearer.<token>` (issue #32); the server selects `gede.v1` and never echoes the bearer entry. `?token=` is accepted for one more release with a deprecation warning; the request serializer in `logger.ts` redacts it, and no log line may ever carry a token.
- The only unauthenticated routes are `GET /healthz` and `GET /api/health`, and they answer `{ ok }` only. There is no allowlist, no debug token, no `NODE_ENV` bypass.
- Two rate limits (#37, #42). Per address, on every route at `onRequest` (`ip-limit.ts`, `RATE_LIMIT_PER_IP_PER_MINUTE`): the only bound on callers with no, an invalid or a rotating token, including WebSocket upgrades (which carry the token in a subprotocol, so they are address-keyed only). Per verified user, on `/api` at `preHandler` after the auth hook (`@fastify/rate-limit`, `RATE_LIMIT_PER_MINUTE`, key `user:<id>` — never the bearer string). Both in memory, per task.
- `request.ip` is what one hop of `X-Forwarded-For` yields (`trustProxy` trusts the ALB and nothing further, so a forged leftmost entry never counts): on the direct `/ws/*` path that is the **real client**; on `/api/*`, which arrives CloudFront → ALB, it is the **CloudFront edge** — every user behind one POP shares that address bucket, which is why it is generous and the per-user limit is the precise one. Do not key anything else on `request.ip` for `/api` without reading this.
- `users.email` is never bound from a token in this pool: the SPA sends access tokens, which carry no `email`, and `username` is a Cognito-generated UUID (`signInAliases: { email: true }` makes email a username _attribute_, not the username). `emailFromClaims` keeps its guards (`email_verified`, an email-shaped `username`) for a pool configured otherwise and returns `null` in production; the address arrives through `PATCH /api/me` (#42 tracks the binding path).
- A socket with `view` permission receives the document stream; its update messages are dropped and counted. Awareness from view-only sockets is accepted.
- `sub` maps to `users.cognito_sub`; the row is created on first sight from the JWT claims (email, name). Nothing else about identity is stored.

## Wire protocol

- y-websocket: message type 0 = sync (step 1, step 2, update), type 1 = awareness. Encoded with `lib0` and `y-protocols`. The browser uses the stock `y-websocket` provider. The one GeDe addition is type 4, a server-to-client notice (`{ "code": "read-only" }`, sent once per view-only connection); it is documented in `src/ws/protocol.ts` and the SPA reads it through `provider.messageHandlers[4]`. Do not add others.
- One room per open document (`/ws/:docId`). One in-memory `Y.Doc` per room, evicted after idle. The process assumes it is one of many (fan-out is behind an interface) even though production runs one task today.
- Per-connection limits (#37): sync updates and awareness each have a token bucket (`WS_UPDATES_*`, `WS_AWARENESS_*`); over the update burst the socket is closed 4429, excess awareness is dropped. A socket whose `bufferedAmount` exceeds `WS_MAX_BUFFERED_BYTES` is closed 1013 before the next send. An awareness frame over `AWARENESS_MAX_BYTES` is refused on its length before it is decoded.

## Persistence contract

1. Every incoming update is appended to `doc_updates(document_id, seq, update, author_id)` before it is fanned out.
2. Every 500 updates, or after 5 minutes idle, the room encodes `Y.encodeStateAsUpdate` to S3 `<DOCS_PREFIX><documentId>/<seq>.yjs`, writes a `snapshots` row, updates `documents.snapshot_key/snapshot_seq`, then prunes `doc_updates` up to that seq — under the document row lock and only when `seq` is greater than the committed `snapshot_seq`, no other task has committed since this writer loaded (or last committed), and every logged row in `(coversFrom, seq]` was appended by this writer (#39): the pointer never moves back and never past rows the snapshot does not contain. A refused commit marks the room superseded; the manager drops it (sockets get 1001, reconnect, resync) and the next join loads from storage. Two tasks writing one document stays unsafe until growth step 1 adds cross-task fan-out; this only bounds the damage.
3. Cold open = load the snapshot (if any) then replay `doc_updates` after `snapshot_seq`.
4. A new document's initial state (`seedNewDocument` in `@gede/core`: meta + one sheet) is written by `POST /api/documents` as snapshot seq 1, in the same transaction as the row. Clients never seed.
5. Projection tables are written by the Projection Worker (`src/projection/`), debounced after every compaction, from the snapshot's bytes, replacing the document's rows in one transaction; they are never read to reconstruct a document. `--job reproject` rebuilds them.
6. The nightly purge (`--job purge`, EventBridge Scheduler → the jobs task definition) deletes documents soft-deleted for more than 30 days, one transaction per batch, audit row with `user_id` null, then their S3 prefix.

## Migrations

`@gede/db` migrations run on boot under `pg_advisory_lock`, as the master user (`PG*`) on a one-connection pool that is closed before the server listens. The same step bootstraps the least-privilege role the runtime pool then connects as (`PGAPPUSER`/`PGAPPPASSWORD`, #36, ADR-022): DML only, no DDL, no `TRUNCATE`, read-only on `__migrations`. A query that needs more than DML belongs in the bootstrap's grants, never in a master-user pool; `pg.live.test.ts` runs the whole repository as the app role so it fails there first. A failed migration or bootstrap exits non-zero; ECS restarts the task and the previous task definition stays live (circuit breaker). In production a missing `PGAPPUSER`/`PGAPPPASSWORD` is fatal; there is no fallback to the master user.

## Environment

Set by `infra/lib/stacks/service-stack.ts` (the names are the contract; change both sides in one PR):

| Variable                                                    | Purpose                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `PORT`                                                      | Listen port (3000)                                                         |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE`        | Injected from the RDS master secret by ECS; migrations and bootstrap only  |
| `PGAPPUSER` `PGAPPPASSWORD`                                 | Injected from `gede/prod/db-app`; the runtime pool. Required in production |
| `PGSSLMODE` `PGSSLROOTCERT`                                 | `verify-full` with `/app/rds-global-bundle.pem` (copied by the Dockerfile) |
| `COGNITO_USER_POOL_ID` `COGNITO_CLIENT_ID` `COGNITO_REGION` | JWT issuer, expected `client_id`, JWKS region                              |
| `DOCS_BUCKET` `DOCS_PREFIX`                                 | Snapshot bucket and key prefix (`docs/`); the task role is scoped to it    |
| `WEB_ORIGIN`                                                | CORS origin (`https://gede.work`)                                          |
| `NODE_ENV`                                                  | `production` in the task                                                   |
| `LOG_LEVEL`                                                 | Optional; pino level, default `info`                                       |
| `PROJECTION_DEBOUNCE_MS`                                    | Optional; wait after a compaction before the projection write (1 s)        |
| `RATE_LIMIT_PER_MINUTE` `WS_*`                              | Optional; the limits above (README has the defaults)                       |
| `GEDE_VERSION`                                              | Baked into the image by the `GEDE_VERSION` build arg (short git sha)       |

Locally, `PG*` point at a local PostgreSQL 17, `PGSSLMODE=disable`, and `PGAPPUSER` is unset (the runtime is the master user; the boot log says which). Read everything once in `config.ts` with `zod`; nothing else touches `process.env`. The SES sender is `no-reply@<WEB_ORIGIN host>`.

## Errors and logging

- Every error response is `{ error: { code, message, ref } }`. `code` is a stable snake_case string, `message` is plain English for the client, `ref` is the request id the client shows as `ref …` on error pages. Never leak stack traces or SQL.
- Logging is `pino` through `fastify.log` / `request.log`. No `console.*` (ESLint enforces it). Log the `ref`, never a token or an update payload.
- Graceful shutdown: on `SIGTERM` stop accepting connections, snapshot every dirty room, close sockets with code 1001, close the pool, exit within 25 s (ECS gives 30).

## Tests

- `buildServer(deps)` takes every external dependency (db pool, S3 client, SES client, JWT verifier, clock) so tests inject fakes. No live AWS in unit tests; no network in `vitest`.
- `src/repo/pg.live.test.ts` runs the real SQL against a throwaway database when `DATABASE_URL` is set and is skipped otherwise. Add a case there whenever `pg.ts` gains a query the fake mirrors.
- Test names start with the requirement id: `test('SHARE-03 view-only socket updates are dropped', …)`.
- WebSocket tests use a real `ws` client against an ephemeral port.

## Container

`Dockerfile` targets `linux/arm64` on `node:22-alpine` and is built by CodePipeline. Never `docker push` an image by hand; the pipeline tags and deploys. `docker build --platform linux/arm64 -f services/sync/Dockerfile .` is a valid local check.
