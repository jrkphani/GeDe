# services/sync

Sync & API service: Fastify 5 REST under `/api`, y-websocket document rooms under
`/ws/:docId`, Cognito JWT verification, persistence to Postgres (`doc_updates`) and S3
(snapshots). Migrations from `packages/db/migrations` run at boot under an advisory lock.

## Environment

| Variable                                             | Required         | Default    | Notes                                                                                                                   |
| ---------------------------------------------------- | ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                               |                  | `3000`     |                                                                                                                         |
| `LOG_LEVEL`                                          |                  | `info`     | pino level                                                                                                              |
| `PGHOST` `PGPORT` `PGUSER` `PGPASSWORD` `PGDATABASE` | yes              |            | libpq names; the master user, injected from Secrets Manager in ECS; boot (migrations) only                              |
| `PGAPPUSER` `PGAPPPASSWORD`                          | in production    |            | least-privilege role the runtime pool uses (#36); created by the boot; unset = master user                              |
| `PGSSLMODE`                                          |                  | `disable`  | `verify-full` in production                                                                                             |
| `PGSSLROOTCERT`                                      | with verify-full |            | `/app/rds-global-bundle.pem` in the image                                                                               |
| `COGNITO_USER_POOL_ID`                               | yes              |            |                                                                                                                         |
| `COGNITO_CLIENT_IDS`                                 | yes              |            | comma-separated app client ids a token may carry (the SPA's, the pipeline's `gede-e2e`)                                 |
| `COGNITO_REGION`                                     | yes              |            | also the S3 client region                                                                                               |
| `COGNITO_ERASE_IDENTITY`                             |                  | `false`    | `true` once the task role may `cognito-idp:AdminDeleteUser`; `DELETE /api/me` then deletes the pool user (#111)         |
| `DOCS_BUCKET`                                        | yes              |            | S3 bucket for snapshots                                                                                                 |
| `DOCS_PREFIX`                                        |                  | ``         | key prefix, e.g. `docs/`                                                                                                |
| `WEB_ORIGIN`                                         | yes              |            | exact SPA origin; CORS and the WebSocket `Origin` check                                                                 |
| `SNAPSHOT_EVERY_UPDATES`                             |                  | `500`      | compact after this many persisted updates                                                                               |
| `SNAPSHOT_IDLE_MS`                                   |                  | `300000`   | …or after this long idle                                                                                                |
| `ROOM_IDLE_MS`                                       |                  | `600000`   | evict a room this long after its last socket leaves                                                                     |
| `PROJECTION_DEBOUNCE_MS`                             |                  | `1000`     | wait after a compaction before writing the projection                                                                   |
| `RATE_LIMIT_PER_MINUTE`                              |                  | `300`      | `/api` requests per verified user per minute → 429                                                                      |
| `RATE_LIMIT_PER_IP_PER_MINUTE`                       |                  | `3000`     | requests per address per minute, every route → 429                                                                      |
| `RATE_LIMIT_INVITES_PER_HOUR`                        |                  | `30`       | invitations per verified user per hour (each is an outbound mail) → 429                                                 |
| `RATE_LIMIT_RESEND_COOLDOWN_SECONDS`                 |                  | `600`      | one Resend of a given invitation per window, whoever asks (0 disables) → 429                                            |
| `WS_MAX_UPDATE_BYTES`                                |                  | `2 MiB`    | largest client → server frame; `ws` closes 1009 on the declared length (#99)                                            |
| `WS_MAX_BUFFERED_BYTES`                              |                  | `2 MiB`    | unread bytes a socket may hold (plus its join step 2 while it is being written) before it is closed 1013 and terminated |
| `WS_UPDATES_PER_SEC` `WS_UPDATES_BURST`              |                  | `200/400`  | sync messages (step 1/2, updates, awareness queries) per connection; over the burst → 4429                              |
| `WS_BYTES_PER_SEC` `WS_BYTES_BURST`                  |                  | `1/4 MiB`  | sync payload bytes per connection; over the burst → 4429 (#99)                                                          |
| `WS_AWARENESS_PER_SEC` `WS_AWARENESS_BURST`          |                  | `20/40`    | awareness per connection; excess dropped                                                                                |
| `WS_MAX_ROOMS` `WS_MAX_SOCKETS`                      |                  | `500/2000` | open rooms / sockets one task serves; a join past either → 1013 (#99)                                                   |
| `WS_MAX_SOCKETS_PER_USER`                            |                  | `16`       | sockets one verified user may hold on one task; the next → 4429 (#99)                                                   |
| `WS_PERMISSION_RECHECK_MS`                           |                  | `60000`    | every connection's permission and token expiry re-resolved on this cadence (#104)                                       |
| `DOC_LOG_MAX_BYTES`                                  |                  | `8 MiB`    | `doc_updates` bytes since the last snapshot before the room compacts early (#99)                                        |
| `DOC_MAX_BYTES`                                      |                  | `64 MiB`   | ceiling on one document's state; an update that would pass it → 4413 (#99, ADR-037)                                     |
| `SES_EVENTS_QUEUE_URL`                               |                  |            | the SQS queue SES bounce/complaint/reject events arrive on (ADR-046); unset = no poller, nothing is ever suppressed     |
| `SES_EVENTS_WAIT_SECONDS`                            |                  | `20`       | the poller's long-poll wait per `ReceiveMessage` (1–20)                                                                 |
| `GEDE_VERSION`                                       |                  | build      | reported by `GET /api/version`; the short git sha                                                                       |

There is no auth bypass in any environment. Tests inject a fake verifier through `buildServer` deps.

## Local run

Start a Postgres (any 16+; `createdb gede`), then:

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gede PGPASSWORD=gede PGDATABASE=gede PGSSLMODE=disable
export COGNITO_USER_POOL_ID=… COGNITO_CLIENT_IDS=… COGNITO_REGION=ap-southeast-1
export DOCS_BUCKET=… WEB_ORIGIN=http://localhost:5173
npm run dev -w services/sync        # tsx watch src/main.ts; migrations apply on boot
curl -i localhost:3000/healthz
```

`apps/web`'s Vite dev server proxies `/api` and `/ws` to `:3000`.

## Endpoints

Every `/api` route except `/api/health` needs `Authorization: Bearer <Cognito access token>`.
Two rate limits, both in memory per task, health checks exempt (#37): every route counts against
the client address (`RATE_LIMIT_PER_IP_PER_MINUTE`, 3000) — that includes WebSocket upgrades, which
are address-keyed only since their token travels in a subprotocol — and every `/api` route also
counts against the verified user (`RATE_LIMIT_PER_MINUTE`, 300, keyed by the user id: a rotating
token is the same user, an invalid one never reaches it). Over either budget the answer is 429
`{ error: { code: 'too_many_requests', … } }` (`retry-after` on the per-user one). The address is
one hop of `X-Forwarded-For` (the ALB's entry): the real client on the direct `/ws` path, the
**CloudFront edge** on `/api/*` — every user behind one POP shares that bucket, so it is generous
and the per-user limit is the precise one.

- `GET /healthz`, `GET /api/health` — `{ ok }`; 503 when `SELECT 1` fails. No auth, and no
  version: an unauthenticated caller learns only that the service is up (#42).
- `GET /api/version` → `{ version }` (the short git sha baked into the image).
- `GET /api/me` → `{ id, sub, email, displayName, locale, tourDoneAt, librarySort, sampleDocumentId }`.
  `tourDoneAt` (ONB-03) is the ISO time the account completed or skipped the guided tour, null
  while the tour is due; `librarySort` (LIB-05, #133) is the Browse / Shared sort the account
  chose, `name` | `date` | null; `sampleDocumentId` (ONB-01) is the account's guided sample
  workscape, seeded by the account's first request (see below).
  `PATCH /api/me { displayName?, locale?, idToken?, tourDone?, librarySort? }` — display name
  1–80 characters after trimming; locale one of `en-US en-GB en-IN ta-IN hi-IN te-IN`;
  `tourDone: true` stamps `tourDoneAt` now and `false` clears it (Replay, ONB-08);
  `librarySort` is `name` or `date`; at least one field (I18N-05, AUTH-09).
  `idToken` is the caller's Cognito **ID** token (SHARE-02): the service verifies it (`tokenUse:
'id'`, same pool and client), requires its `sub` to be the caller's and `email_verified`, binds
  the address to `users.email` and converts every pending, unexpired invitation for it into a
  share in the same transaction. 400 for an invalid token or one without a verified email, 403
  for another account's token, 409 `conflict` when the address already belongs to another
  account, 409 `email_bound` when this account already carries a different address. The SPA
  sends it once, right after sign-in, when `GET /api/me` answers `email: null`.
  `DELETE /api/me` → `{ erased: true, identity: 'deleted'|'skipped'|'failed', documentsTransferred,
documentsDeleted }` — account erasure (#111, ADR-038). In one transaction: every share the caller
  holds goes (`share.remove`), every pending invitation they sent is withdrawn, every invitation
  row addressed to them is deleted, each owned live document goes to its earliest editor
  (`document.transfer`) or — with no editor, or the guided sample — loses its shares and link and
  is soft-deleted (`document.delete`), `doc_updates.author_id` is nulled, the address is scrubbed
  from `audit_log.target`, and the `users` row becomes a tombstone (`display_name` `Deleted user`,
  everything else null, `deleted_at` set, `cognito_sub` kept). Audit rows keep the actor id. Then
  the caller's sockets close 4403 everywhere, rooms of trashed documents close 4404, the new
  owners' sockets close 1001, and the Cognito user is deleted when `COGNITO_ERASE_IDENTITY` is on
  (`identity: 'skipped'` otherwise; `'failed'` when Cognito refused — logged as a
  `GeDe/Sync UserErasureIdentityFailures` datapoint, see the runbook). A token that outlives the
  erasure answers 403 `account_deleted` on every route; a second `DELETE` does the same.
- `GET /api/documents?view=recents|browse|shared|deleted|archived` (default `recents`) →
  `{ documents: [{ id, title, kind: 'workscape', sizeBytes, createdAt, updatedAt, ownerId, ownerName,
sharedBy?: { id, name }, sharedWithOthers, permission: 'owner'|'edit'|'view', linkAccess, deletedAt,
archivedAt, everShared, sample }] }`.
  The caller's own guided sample (`sample: true`) is pinned above every other row in every view it
  appears in (ONB-01); someone else's sample shared with the caller lists as an ordinary shared row
  with `sample: false`. After it, `recents` = owned + shared with me, live, newest `updatedAt` first; `browse` = owned, live;
  `shared` = shared with me plus my own documents that are shared (`sharedWithOthers: true`: a share row or the link on — a pending invitation is not a participant, #139);
  `deleted` = owned, deleted within 30 days; `archived` = owned, live, `archivedAt` set (LIB-D6,
  no expiry). The owner's archived documents are absent from `recents`, `browse` and `shared`; a
  participant still sees them there (LIB-D3). `sizeBytes` is the latest snapshot plus every update
  logged since it, computed in the same query. `ownerName` / `sharedBy.name` are display names;
  for the owner and editors they fall back to the person's email, for a viewer (or anyone who
  redeemed a view link) they are `null` when no display name is set — the share sheet's rule,
  #102: a viewer is never handed an address. `everShared` (LIB-D2/D4) is true while the
  document has a participant or its link is on (once it had either); `sample` marks the guided
  sample (LIB-D10).
- `POST /api/documents { title? }` → 201 `{ document }`. The room's initial state is written here
  (DOC-03): a Y.Doc seeded by `seedNewDocument` in `@gede/core` (`meta.title`, `meta.createdAt`,
  one sheet "Sheet 1" tagged `seeded`) goes to S3 as snapshot seq 1, and the `documents` row
  (`snapshot_key`/`snapshot_seq`), the `snapshots` row and the `document.create` audit row are
  inserted in one transaction. A new document therefore never opens empty and no client seeds
  one; the first client update is seq 2. If the insert fails after the object was written, the
  request answers 500 and the log names the orphaned key.
- The guided sample (ONB-01, `Q3 Delivery — Guided sample`) is created the same way — S3 object
  first, then row + `snapshots` + audit (`document.create`, target `sample`) in one transaction —
  by `SampleSeeder` from the auth hook, the first time an account is seen, whatever its first
  request is (a shared link counts, ONB-02). `sample = true`, at most one per owner
  (`documents_owner_sample_key`, migration 0009). The transaction holds a per-owner advisory
  lock (`pg_advisory_xact_lock(hashtext('gede_sample:<owner>'))`) and writes the object only
  when no sample exists, so seeders racing across tasks write one object and adopt one row —
  nothing is orphaned. A seed that fails (S3 down) never fails the request: `/api/me` answers
  `sampleDocumentId: null`, the line `guided sample seed failed` is logged (alarm
  `gede-<env>-sample-seed-failed`), the answer is not cached and the next request retries. It is
  named by ONB-01, so `PATCH /api/documents/:id { title }` answers 409 `sample` for it, as
  Delete and Archive do. Content is `seedSampleWorkscape` in `@gede/core`: `Deliverables`
  (Owner, Status, Due dates, Days) and `Team`, an id-bound `=Sum` and a cross-table
  `=@Team.Priya.Role` reference — what the five tour steps refer to.
- `GET /api/documents/:id` → `{ document }` with the same fields as a library row.
  `PATCH /api/documents/:id { title }` (owner or editor; 409 `sample` for the guided sample).
  `DELETE /api/documents/:id` (owner) →
  204; moves the document to Recently Deleted (clearing `archivedAt`) and closes its room with 4404. 409 `shared` while `everShared` is true — a workscape someone was given access to is
  archived, never deleted (LIB-D2); 409 `sample` for the guided sample (LIB-D10).
- `POST /api/documents/:id/archive` (owner) → `{ document }`; sets `archivedAt` and nothing else:
  every share, the link and the open room stay (LIB-D3). 409 `conflict` when already archived,
  409 `sample` for the guided sample, 404 when deleted. `POST /api/documents/:id/unarchive`
  (owner) → `{ document }`; 409 `conflict` when not archived. Audit `document.archive` /
  `document.unarchive`.
- `POST /api/documents/:id/recover` (owner) → `{ document }`; 409 when it is not deleted, 404 when
  its deletion is older than 30 days (it is no longer in Recently Deleted; the database enforces
  the window, not only the route).
- `POST /api/documents/recover-all` (caller's documents deleted within 30 days) →
  `{ recovered, ids }`, one `document.recover` audit row per document in the same transaction;
  `ids` lets the client's Undo delete each again (LIB-D9).
- `POST /api/documents/delete-all` (every soft-deleted document the caller owns, retention or not)
  → `{ deleted }`. Rows in `documents`, `doc_updates`, `snapshots`, `shares`, `invites` go in one
  transaction with a `document.purge` audit row each; the S3 objects under `${DOCS_PREFIX}${docId}/`
  are deleted best-effort afterwards (a failure is logged with the document id).
- `GET /api/documents/:id/shares` (any participant) →
  `{ owner: { id, name, email }, participants: [{ userId, name, email, permission, invitedBy,
source }], invites: [{ id, email, permission, invitedBy, expiresAt, mailSentAt }], linkAccess, linkToken,
permission, callerId }`. Emails, pending invitations and the link token are for the owner and
  `edit` participants; a `view` participant receives `null` emails, `invites: []` and
  `linkToken: null`. `permission` is the caller's, `callerId` their `users.id` (for "(you)").
  `source` is `invite` or `link` — a `link` share came through "anyone with the link" and goes
  with it.
- Sharing writes (`src/routes/share.ts`, SHARE-01..03). Every one is checked server-side;
  each writes its `audit_log` row (`share.*`) in the same transaction as the change.
  - `POST /api/documents/:id/invites { email, permission: view|edit }` (owner or editor) → 201
    `{ kind: 'share' | 'invite', created: true, delivery: 'sent' | 'failed', shares }`. An
    address with an account gets a share now and a `share.member` mail; one without gets an
    `invites` row valid 14 days and a `share.invite` mail whose link is
    `/d/:id?invite=<token>`. The row is the grant and the mail its notification (#121): the
    row is written first and stands whatever the send did — a refused send (SES in the
    sandbox: unverified recipient; a throttle; an outage) answers `delivery: 'failed'` on the
    201, is logged with the failure class (never the address) and counted on the
    `GeDe/Sync InviteMailFailures` metric (EMF, dimension `Reason` = template). An accepted
    send is recorded as `invites.mail_sent_at` (migration 0011) and answered as the
    invitation's `mailSentAt`; null means never mailed, and the SPA shows "Invitation saved —
    the email could not be sent" with Resend, after a reload as well. Idempotent per (document,
    address): while a pending invitation stands, a repeated POST answers 200
    `{ kind: 'invite', created: false, delivery: 'skipped', shares }` — no row, no mail
    (`invites_pending_key`, migration 0007, decides a race). 409 when the address already has
    access or is the owner's. 409 `address_suppressed` ("This address cannot receive email from
    GeDe") when the address has no account and is on `mail_suppressions` — SES bounced it
    hard, or three times within 30 days, or it complained (ADR-046; `mail/events.ts`) —
    checked before any budget is spent. An address with an account is shared with as ever
    (the row is the grant); a suppressed one gets `delivery: 'skipped'` and no mail. Its own
    budget: `RATE_LIMIT_INVITES_PER_HOUR` per user, counted after validation and the
    permission check, only when a mail would go.
  - `POST /api/documents/:id/invites/:inviteId/resend` (owner or editor) → 200
    `{ delivery: 'sent' | 'failed', shares }`. Sends the pending invitation's mail again — same
    token, same expiry, only `mail_sent_at` moves on an accepted send, no audit row — and
    spends the same per-user budget;
    one resend of a given invitation per `RATE_LIMIT_RESEND_COOLDOWN_SECONDS` (429 with the wait
    inside it, whoever asks, so an address is never mailed the same invitation repeatedly);
    404 when the invitation is not pending on this document; 409 `address_suppressed` as above.
  - `DELETE /api/documents/:id/invites/:inviteId` (owner) → 204; 404 when not pending here.
  - `POST /api/documents/:id/invites/accept { token }` (signed in) → `{ permission }`. Converts
    only for the account holding the invitation's address (409 `Finish signing in` while none is
    bound, 403 for another address, 409 when already used, 410 `expired`, 404 otherwise — also
    when the inviter no longer stands, see below).
  - `PATCH /api/documents/:id/shares/:userId { permission }` (owner) → the sheet; the person's
    sockets close 1001 so the provider reconnects and resolves the new permission.
  - `DELETE /api/documents/:id/shares/:userId` (owner) → 204; their sockets close 4403.
  - `PATCH /api/documents/:id/link { access: none|view|edit }` (owner) → the sheet. Every
    change to `view` or `edit` — from `none` or from the other level — mints a fresh
    `link_token`: a link handed out as "view" never becomes "edit", and one switched off stays
    dead. Switching off or re-minting revokes every `source: link` share (`share.link_revoke`
    names them; their sockets close 4403); invited shares are untouched. The SPA's Copy link is
    `/d/:id?k=<token>` while on, else the plain address.
  - `POST /api/documents/:id/link/redeem { token }` (signed in) → `{ permission }`: the link's
    level becomes a `link` share for the caller (an explicit share is never lowered); 404 for a
    wrong token or link access off — the document's existence is not confirmed.
  - `POST /api/documents/:id/stop-sharing` (owner) → the sheet: every share and pending
    invitation gone, link access `none`, every participant's sockets closed 4403; the
    `share.stop` row's target is `{ users: [...ids], invites: [...addresses] }`.
  - Conversion on first sign-in (SHARE-02) runs wherever `users.email` becomes known:
    `PATCH /api/me { idToken }` above, and `upsertFromToken` for a token that carries a verified
    address (not this pool's access tokens). Both call the same `convertInvites` in `repo/pg.ts`.
    An invitation is only as good as its inviter: it converts while the inviter is the owner or
    still holds at least what it grants (`edit` for an edit invitation, any share for a view
    one); otherwise it is withdrawn at that moment with a `share.invite_withdraw` row
    (`target = <address>:<inviter id>`) and grants nothing — on the sign-in path and the mail
    link alike.
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
  selects `gede.v1` and never echoes the bearer entry. A `?token=` query parameter is not read
  (#63; the request log still redacts it). Close codes: 4401 unauthenticated, 4403 not
  a participant / wrong origin / access removed / account erased, 4404 unknown or deleted
  document, 4429 more sync messages per second than `WS_UPDATES_BURST` allows — step 1 and
  awareness queries count too, since each makes the server encode and send — or more bytes than
  `WS_BYTES_BURST`, or more sockets than `WS_MAX_SOCKETS_PER_USER` (the client treats 44xx as
  terminal), 4413 the update would take the document past `DOC_MAX_BYTES` (terminal; edits stay on
  the device, ADR-037), 1009 a frame over `WS_MAX_UPDATE_BYTES` (terminal on the client too: a
  reconnect would send it again), 1007 a frame that is not the protocol or an update that does not
  decode (#105: refused whole, nothing half-applied, counted, never a stack trace on stderr), 1013
  the socket stopped reading and `WS_MAX_BUFFERED_BYTES` piled up (closed and terminated at once,
  the client reconnects with backoff) or the task is full (`WS_MAX_ROOMS` / `WS_MAX_SOCKETS`), 1001
  on shutdown, on a permission change and on token expiry (the client reconnects and resolves
  afresh). Every refusal is a `GeDe/Sync WsRefusals` datapoint dimensioned by `Reason` (embedded
  metric format in the log line; `src/metrics.ts`). Awareness over `WS_AWARENESS_BURST` is dropped,
  not fanned out (#37). A permission resolved at upgrade is re-resolved every
  `WS_PERMISSION_RECHECK_MS` (#104), so a share change made on another task or by hand closes the
  socket within a minute; the in-process share routes still close it at once.

Errors are `{ error: { code, message, ref } }`; `ref` is also sent as `x-request-id`. A
non-participant gets 403 (never the title); a participant of a deleted document gets 404, the
"may have been deleted" page — only the owner can still read it, in Recently Deleted.

Audit rows (`audit_log.action`): `document.create`, `document.rename`, `document.delete`,
`document.archive`, `document.unarchive`, `document.recover`, `document.purge` (target = the
title; the row outlives the document), `document.transfer` (erasure handed the document to the
editor named in `target`).
`user_id` is null on a `document.purge` written by the nightly job (the system actor); Delete All
writes the owner's id. Audit rows are kept when an account is erased (ADR-038): the actor id
still points at the tombstone row, addresses in `target` are replaced by `[erased]`.

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

`purge` works in batches of 50 (#109): it reads the expired documents (no transaction held),
removes each one's S3 objects under `${DOCS_PREFIX}${docId}/` outside any transaction — a slow
or retried S3 call can no longer hit the pool's 30 s idle-in-transaction timeout — and then
deletes the rows of the documents whose objects went in one short transaction (a `document.purge`
audit row each with `user_id` null), re-checking under the lock that each is still past the
window and not a sample. A document whose objects could not be removed keeps its rows and is
retried next run, so an S3 failure never orphans an object; a batch whose row delete fails is
logged with its ids and left for the next run (which finds nothing to remove in S3 and deletes
them); either makes the job exit 1, which alerts. EventBridge Scheduler runs it nightly
(`infra/lib/stacks/ops-stack.ts`). `reproject all` skips deleted documents and exits 1 if any
document failed (its log line says which). See `docs/RUNBOOK.md`.

## Runbook

- **Recently Deleted retention.** Documents deleted more than 30 days ago drop out of the
  `deleted` view; the nightly purge job (`--job purge`, 02:30 Asia/Singapore) removes them for good,
  as Delete All does for an owner. `docs/RUNBOOK.md` "Nightly purge" has the commands.
- **Initial room state.** Written by `POST /api/documents` as snapshot seq 1 (above). Documents
  created before this shipped may still hold a client-seeded sheet; `ensureFirstSheet` and
  `dedupeSeededSheets` in `@gede/core` remain for them and are no-ops on a seeded replica.
- **Orphaned snapshot objects.** A `snapshot objects not purged` log line (level error) names the
  document id and prefix; delete `s3://$DOCS_BUCKET/$DOCS_PREFIX<docId>/` by hand or rerun
  Delete All as the owner (a second run finds no rows and touches nothing). The nightly purge
  cannot produce that line: it removes objects before rows and keeps a document whose objects
  failed for the next run. A `document insert failed after its seed snapshot` line names one
  orphaned `<docId>/1.yjs` object.

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
