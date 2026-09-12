# Digest: GeDe Architecture C4, Sign-in Options, Error Pages

Source files (read-only, unmodified):
- `/Users/jrkphani/Projects/GeDe/handover/specs/GeDe Architecture C4.dc.html` (single `<doc-page>` flowing document, 7 numbered sections)
- `/Users/jrkphani/Projects/GeDe/handover/specs/GeDe Sign-in Options.dc.html` (one canvas section, "turn 1", three options 1a/1b/1c)
- `/Users/jrkphani/Projects/GeDe/handover/specs/GeDe Error Pages.dc.html` (one canvas section, "turn 2"; page data lives in an inline `<script type="text/x-dc">` `renderVals()` array, not in the markup)

Extraction note: all three files are plain HTML prose (no JSON blob) except the error-page copy, which is a JS array of `p(code, name, when, kicker, title, body, cta, alt, meta, ref, behaviour, sev)` tuples rendered through an `<sc-for>` template. Everything below is captured from the full files.

---

## 1. ARCHITECTURE C4

Header: "GeDe — System Architecture. C4 model · initial data model · storage · capacity for 9 users, built to grow." Described as a *companion to the PRD (§20–22)*. Framing sentence: "All compute is AArch64 on AWS; the pipeline is CodeBuild on ARM. The design is sized for nine named users on day one and changes shape, not architecture, at each growth step."

### 1.1 Level 1 — System Context

"GeDe is one system; everything else is a person or an external service."

Actors (persons):
- **Editor** — Desktop or tablet. Authors tables, formulas, graphs. Shares documents.
- **Viewer** — Invited view-only, or *any editor on a phone*. Reads, follows references, never writes. (Phone = read-only, this is restated in the Sync Client component.)
- **Operator** — 1Cloudhub engineer. Ships via the pipeline, watches dashboards, manages the user pool.

Actors reach GeDe over **HTTPS · WebSocket**.

Software system: **GeDe** — "Text-oriented spreadsheet on an infinite lattice: tables, rich text, formulas, cross-table references, context graphs, real-time sharing."

External systems GeDe "uses":
- **Amazon Cognito** — User pool. Passkeys (WebAuthn), email one-time codes, Apple ID federation. Issues JWTs.
- **Sign in with Apple** — OIDC identity provider registered in the Cognito pool.
- **Amazon SES** — Delivers one-time codes and share invitations.

### 1.2 Level 2 — Containers

"Four containers, one of them static. The collaborative document (Yjs CRDT) is the unit of state; PostgreSQL holds its update log and the relational projection; S3 holds snapshots."

| Container | Type | Technology | Responsibility |
|---|---|---|---|
| **GeDe Web** | web SPA (static) | React + TypeScript | Owns rendering, the formula engine, the text-transform algebra, and the local Yjs replica. Served from S3 through CloudFront. |
| **Sync & API Service** | service | Node 20 on `linux/arm64`, ECS Fargate (Graviton) | WebSocket document rooms (y-websocket protocol), REST for documents, shares, invites. Verifies Cognito JWTs; enforces permissions on every message. |
| **PostgreSQL 16** | database | Amazon RDS on Graviton (`db.t4g.micro` to start) | Users, documents, shares, the Yjs update log, and a relational projection of tables and cells for search and audit. |
| **Amazon S3** | object store | Two buckets: `web` (immutable, content-hashed bundle) and `docs` (compacted Yjs snapshots, versioned, lifecycle to Glacier IR after 90 days). | |

Communication table (verbatim):

| From | To | Protocol · purpose |
|---|---|---|
| Browser | CloudFront → S3 `web` | HTTPS · loads the SPA; long-cache hashed assets |
| Browser | Cognito | HTTPS · WebAuthn ceremony, OTP, Apple OIDC; receives ID + access tokens |
| Browser | Sync & API (ALB) | WSS · Yjs sync + awareness per document room; HTTPS · REST for list, create, share |
| Sync & API | PostgreSQL | TLS · appends Yjs updates, reads permissions, writes projection |
| Sync & API | S3 `docs` | HTTPS (VPC endpoint) · snapshot every 500 updates or 5 min idle; load on cold open |
| Sync & API | SES | HTTPS · share invitations |

Note: the browser talks to Cognito directly (no auth proxy in the service); the service only verifies JWTs. Snapshot cadence: **every 500 updates or 5 min idle**.

### 1.3 Level 3 — Components

"The line between them is deliberate: the browser computes, the service coordinates and persists."

**3.1 GeDe Web (browser) components:**
- **Document Store** — Yjs doc: sheets, tables, columns, rows, cells, graphs, shares. Undo manager. IndexedDB persistence for offline.
- **Dependency Graph** — Incremental reactive graph keyed by cell id; dirty marking, topological batches, cycle detection.
- **Formula Engine** — Grammar, parser, `Concat`, `Sum`, address and `@` resolution, reference highlighting.
- **Text Algebra** — Mark-preserving Split / Extract / Replace / Format on ProseMirror-schema text. Smart Chips as RE2 patterns in a Worker.
- **Lattice & Renderer** — Sparse row/column index, A1 projection, viewport culling, semantic zoom bands, canvas layer for gridlines and edges.
- **Graphs** — Ring and coverage derived from a bound table; orbit layout; write-back through the Document Store.
- **Sync Client** — y-websocket provider, awareness (presence), reconnect with exponential backoff, read-only mode on phone or view permission.
- **Auth Client** — Amplify Auth / Cognito SDK: passkey ceremony, OTP, Apple OIDC, silent refresh; **tokens in memory only**.
- **Inspector & Chrome** — Format / Organize / Graph panels, context menus, share sheet, responsive shell.

**3.2 Sync & API Service components:**
- **Auth Middleware** — Verifies Cognito JWT signature and claims on the WebSocket upgrade and every REST call; maps `sub` to `users`.
- **Room Manager** — One in-memory Yjs doc per open document; fan-out of updates and awareness to connected sockets; idle eviction.
- **Permission Guard** — Reads `shares`; drops update messages from view-only sockets; link access honours the document's access mode.
- **Persistence Writer** — Appends each update to `doc_updates`; compacts to an S3 snapshot on threshold; prunes the log after snapshot.
- **Projection Worker** — Debounced: materialises tables, columns and cell text into relational tables for search, audit and future reporting.
- **Documents & Sharing API** — REST: list, create, rename, delete; invite, change permission, revoke, link mode; sends SES invitations.

### 1.4 Deployment — AWS, single region (ap-southeast-1)

Named services and settings (verbatim where stated):
- **Route 53** — domain `gede.1cloudhub.com`
- **CloudFront** — SPA origin S3 · `/api` and `/ws` origin ALB · WAF managed rules
- **Cognito** — user pool · Apple IdP · SES sender
- **VPC** — 2 AZs · public + private subnets
- **ALB** — HTTPS + WebSocket, idle timeout 3600 s, sticky by document id (path)
- **ECS Fargate · ARM64** — Sync & API · 1 task 0.5 vCPU / 1 GiB · min 1, max 4
- **RDS PostgreSQL 16** — db.t4g.micro · 20 GB gp3 · single-AZ, 7-day PITR
- **S3** — web · docs (versioned) · via gateway endpoint
- **Secrets Manager · SSM** — DB credentials, Cognito ids, feature flags
- **CloudWatch** — logs, RUM, alarms → SNS email

> **As built (not in the handover; see `DECISIONS.md` ADR-018–021).** `/api` goes through CloudFront only: CloudFront adds a secret `X-Origin-Verify` header and the ALB's HTTPS listener answers 403 to anything but `/ws/*` (direct, JWT-checked on upgrade) and `/api/*` + `/healthz` carrying the header. The WAF runs a per-IP rate rule plus three AWS managed groups. SPA deep links are served by a viewer-request CloudFront Function on the shell behaviour, so API status codes pass through untouched. SPA responses carry a Content-Security-Policy. Cognito account recovery is off (nothing to recover in an OTP/passkey pool); refresh tokens rotate. The `api.<domain>` record exists only as the CloudFront origin hostname.

Delivery pipeline (verbatim): "GitHub source → CodeBuild (`ARM_CONTAINER`) verify → build `linux/arm64` image to ECR and bundle to S3 → CodePipeline deploy to staging, manual approval, production → smoke test → automatic rollback on failure. Everything above is one CDK app (TypeScript) with two stages."

So: environments are **staging** and **production** (two CDK stages); no separate dev environment is named. CodeBuild uses the ARM_CONTAINER environment type. Container images go to **ECR**; the SPA bundle goes to S3. No Lambda or EC2 is named — compute is ECS Fargate on Graviton only.

### 1.5 Initial Data Model

Two layers: the **document layer** is the CRDT (authoritative, append-only updates plus snapshots); the **relational layer** is "what the CRDT cannot do well: identity, access control, listing, and a searchable projection. Nothing in the relational projection is written by users directly."

**5.1 Relational — authoritative** (verbatim):

| Table | Columns | Notes |
|---|---|---|
| `users` | id uuid pk · cognito_sub text unique · email citext unique · display_name text · locale text null · created_at · last_seen_at | Created on first sign-in from the JWT. No credentials stored. `locale` added by migration 0001 (I18N-05). |
| `documents` | id uuid pk · owner_id → users · title text · link_access enum(none, view, edit) · link_token text unique null · snapshot_key text null · snapshot_seq bigint · created_at · updated_at · deleted_at null · archived_at null · ever_shared boolean · sample boolean | One row per workbook. `snapshot_key` points into S3 `docs`. `created_at` added by migration 0002 (LIB-02 shows and sorts by it; the C4 listed only `updated_at`). Migration 0008 (LIB-D): `archived_at` (Archive, no expiry; never set with `deleted_at` — a CHECK enforces it), `ever_shared` (maintained by the service in the share transactions; Delete is refused while true), `sample` (the guided sample, exempt from Delete and Archive). |
| `shares` | document_id → documents · user_id → users · permission enum(view, edit) · invited_by → users · created_at · source enum(invite, link) · pk(document_id, user_id) | The participant list in the share sheet. Owner is implicit edit. `source` (migration 0007): `link` shares came from "anyone with the link" and go when the link is switched off or re-minted. |
| `invites` | id uuid pk · document_id · email citext · permission · token text unique · expires_at · accepted_at null · invited_by → users null · created_at | For emails without an account yet; converts to a share on first sign-in (the share's `invited_by` is the invitation's, else the owner). `invited_by` and `created_at` added by migration 0006 with an index on `email` for the conversion; migration 0007 adds `invites_pending_key`, one pending invitation per address per document. |
| `doc_updates` | document_id · seq bigint · update bytea · author_id → users null · created_at · pk(document_id, seq) | Yjs update log since the last snapshot. Pruned after compaction. Typical update 50–500 bytes. |
| `snapshots` | document_id · seq bigint · s3_key text · size_bytes int · created_at · pk(document_id, seq) | History of compactions; enables point-in-time restore of a document. |

**5.2 Relational — projection (rebuildable)** (verbatim):

| Table | Columns | Notes |
|---|---|---|
| `sheets` | id text pk (CRDT id) · document_id · ordinal · label · parent_context text null | Child sheets record the graph context they were opened from. |
| `tables` | id text pk · sheet_id · title · grid_col int · grid_row int · outline · options jsonb | Lattice origin, so A1 addresses can be reconstructed server-side. |
| `columns` | id text pk · table_id · ordinal · label · width_units int · format enum(auto, text, number, currency, date) · format_opts jsonb · derived jsonb null · hidden bool | `derived` holds the method and arguments of a pipeline step. |
| `rows` | id text pk · table_id · ordinal · depth smallint · collapsed bool | Hierarchy depth per §4 of the PRD. |
| `cells` | row_id · column_id · text_plain text · rich jsonb · formula text null · ref_target text null · style jsonb · pk(row_id, column_id) · gin(to_tsvector(text_plain)) | Search and audit only; the CRDT remains the source of truth. |
| `graphs` | id text pk · sheet_id · pair_id · kind enum(ring, coverage) · table_id · dimension_columns text[] · grid_col · grid_row · width_units · height_units · slice jsonb | One row per half of a pair; `slice` stores row/column axes and pins. |
| `audit_log` | id bigserial · document_id (no foreign key) · user_id · action text · target text · at timestamptz | Share changes, deletes, restores, purges. `document_id` is not a foreign key (migration 0003) so a `document.purge` row outlives the document it describes. Partitioned monthly once volume warrants. |

**5.3 Document layer (Yjs)** (verbatim):
- `Y.Map` per document: `sheets` (Y.Array of sheet maps), `tables`, `graphs`, `meta`.
- Each table: `columns` Y.Array, `rows` Y.Array of row ids, `cells` Y.Map keyed `rowId:colId` → Y.XmlFragment (ProseMirror-compatible rich text) or a formula string.
- Ids are ULIDs generated client-side; A1 addresses are never stored. Awareness carries user id, name, colour, selected cell, and sheet.

### 1.6 Storage Options (decision record)

| Option | Fit | Day-one cost | Decision |
|---|---|---|---|
| RDS PostgreSQL · db.t4g.micro (Graviton) | Relational + bytea update log + jsonb projection in one engine. 2 vCPU burst, 1 GiB. Ample for 9 users and a few hundred documents. | ≈ US$13–16 / mo | **Chosen** |
| Aurora Serverless v2 (Graviton) | Same schema, scales ACUs with load, Multi-AZ, fast clones. Minimum 0.5 ACU always billed. | ≈ US$45–60 / mo | Growth step 2 — migrate by snapshot restore; no schema change. |
| DynamoDB for updates + snapshots | Excellent for the append-only update log; poor for the relational projection and search. Splits the data across two stores from day one. | ≈ US$1–3 / mo | Not now. Revisit if the update log outgrows Postgres. |
| S3 for snapshots | Compacted Yjs state per document, versioned. Cheapest durable store; loads in one GET on cold open. | < US$1 / mo | **Chosen** |
| ElastiCache Redis (Graviton) | Pub/sub between Sync tasks once a document can be open on more than one task. Not needed while one task serves all rooms. | ≈ US$12 / mo | Growth step 1. |
| OpenSearch | Full-text and fuzzy search across documents. Postgres `tsvector` + `pg_trgm` covers 9 users comfortably. | ≈ US$25+ / mo | Not planned. |

### 1.7 Capacity Plan

**7.1 Day one — 9 users** (verbatim):
- **Load.** At most 9 concurrent WebSocket connections, realistically 2–4 documents open at once. A Yjs update is 50–500 bytes; an active editor emits a few per second. Peak service traffic is under 10 KB/s. One Fargate task at 0.5 vCPU / 1 GiB idles below 5 % CPU.
- **Data.** A workbook the size of the Workscape demo is ≈ 200–400 KB as a Yjs snapshot. Ten thousand documents would be 4 GB of S3 and a few hundred MB of Postgres. The 20 GB gp3 volume is generous.
- **Availability.** Single task and single-AZ database are accepted for nine internal users; ECS restarts a failed task in under a minute and PITR covers the database. CloudFront keeps the SPA reachable regardless.
- **Cost.** Fargate ARM ≈ US$15, RDS ≈ US$15, ALB ≈ US$18, CloudFront + S3 + Route 53 ≈ US$3, Cognito free under 50 k MAU, CodeBuild ARM ≈ US$2 at a few builds a day, CloudWatch ≈ US$3. **About US$55–60 per month**, of which the ALB is the largest fixed line.

No explicit latency targets (ms) are stated in this document.

**7.2 Growth steps — no re-architecture** (verbatim):

| Trigger | Change | Why it is safe |
|---|---|---|
| ≈ 50 users, or any task > 60 % CPU | **Step 1.** ECS service to 2+ tasks; add ElastiCache Redis for room pub/sub (y-redis pattern) so a document may be open on any task; task size to 1 vCPU / 2 GiB. | Room Manager already treats the process as one of many; only the fan-out transport changes. |
| ≈ 200 users, or Postgres > 70 % CPU sustained | **Step 2.** Snapshot-restore into Aurora Serverless v2 (0.5–8 ACU), Multi-AZ; move the Projection Worker to its own ECS service. | Same PostgreSQL wire protocol and schema. |
| Update log > 50 GB, or compaction lag | **Step 3.** Move `doc_updates` to DynamoDB (pk document_id, sk seq, TTL after snapshot). | The Persistence Writer is the only component that touches the log. |
| Users outside SE Asia | **Step 4.** Second region for the Sync service with Aurora Global Database read replica; documents pinned to a home region. | CRDT merges tolerate the latency; permissions read from the local replica. |

**7.3 Operational guardrails from day one** (verbatim):
- Alarms: task CPU > 60 % for 10 min, ALB 5xx > 1 %, WebSocket reconnect rate, RDS free storage < 25 %, snapshot lag > 15 min.
- Budgets: AWS Budget at US$100 / month with an alert at 80 %.
- Backups: RDS 7-day PITR; S3 `docs` versioning with 90-day noncurrent retention; nightly `pg_dump` to S3 as a belt-and-braces export.
- Least privilege: the task role can read and write only the `docs` bucket prefix and its own secrets; the database user for the projection is read/write on projection tables only.

### 1.8 Non-goals / open items (as implied by the document)
- Not planned: OpenSearch; DynamoDB (deferred to Step 3); Redis (deferred to Step 1); Multi-AZ RDS (deferred to Step 2); multi-region (Step 4).
- Not stated / open: a dev environment (only staging + production stages are named), explicit latency SLOs, session/token lifetimes (see Sign-in), rate-limit numbers beyond the 403 "one request per day" in error pages, the CDK stack naming, and what "smoke test" runs post-deploy.
- The document repeatedly asserts the design "changes shape, not architecture" — each growth step swaps one transport or store behind an existing component boundary (Room Manager, Persistence Writer, Projection Worker).

---

## 2. SIGN-IN OPTIONS ("turn 1 — Sign in and sign out — three directions")

Intro (verbatim): "Each option shows the sign-in screen and the state you land on after signing out. All three use the compliant Apple button, lead with passkeys, and carry no password field. Pick by id — 1a, 1b, 1c."

### Option 1a — "Quiet card" — One centred card, nothing else on screen
Screen content, top to bottom:
- GeDe logo mark (square with cross-hair lines and a filled circle, forest green `#14532d`)
- Title: **Sign in to GeDe**
- Subtitle: "No password. A passkey on this device, or a code by email."
- Button (passkey icon): **Continue with a passkey**
- Button (Apple logo, black): **Sign in with Apple**
- Divider: "or"
- Input, placeholder `Email`
- Button: **Email me a code**
- Footer line: "New here? Entering your email creates an account."

Sign out → "returns to this exact screen with the email pre-filled and a single line: 'Signed out. Your work is saved.'"

Rationale: "Least ceremony, fastest to read. No marketing, no split. Good if most sign-ins are returning users on known devices."

### Option 1b — "Lattice canvas" — The product's own surface as the backdrop
The sign-in is rendered as a table cell on the lattice grid (rulers visible). Content:
- Header row: logo mark, **GeDe**, `A1 · sign in`
- Field label: "who are you"
- Input, placeholder `you@company.com`
- Button: **Continue** (email → code path)
- Divider: "or"
- Button (passkey icon): **Passkey**
- Button (Apple, black): **Sign in with Apple**
- Footer strip: `cognito · passwordless` and `arm · ap-southeast-1`

Sign out → "the card empties to a single cell reading 'Signed out' with a Sign in button, still on the lattice — the workspace persists behind you."

Rationale: "The sign-in is itself a table on the grid, rulers and all. Distinctive and on-message; slightly more chrome to read before acting."

Note: 1b is the visual style the Error Pages doc adopts ("In the lattice style of 1b").

### Option 1c — "Forest field" — Full-bleed brand, form floating on it  (the README says **1c shipped**)
Full-bleed dark forest-green background with a large white ring motif (outer ring r=200, inner ring r=130, three nodes with spokes from centre — an orbit/ring-graph preview). Content:
- Top-left: white logo mark + **GeDe**
- Left brand copy: headline "Text is the data. / The canvas is the grid." and sub-line "Tables, formulas and context graphs on one shared sheet."
- Right floating form card:
  - Heading: **Sign in**
  - Button (passkey icon): **Passkey**
  - Button (Apple, black): **Sign in with Apple**
  - Input, placeholder `Email`
  - Button: **Email me a code**

Sign out → "a confirmation on the forest field: 'Signed out of GeDe', the last document named, **Sign back in**, and **Switch account**."

Rationale: "Most branded, best for a first-time visitor arriving from an invitation. The ring motif previews what the product does."

### Common to all three (verbatim)
"passkey above Apple above email code; no password field anywhere; 44 px targets; Apple's button unrestyled in its black variant; and the sign-out state says what happened and what to do next rather than dumping you on a blank form."

### Cognito configuration implied (cross-referencing the C4 doc)
- Cognito **user pool**, passwordless: **passkeys (WebAuthn)** as primary, **email one-time codes** (OTP via SES) as fallback, **Sign in with Apple** as an OIDC federated IdP registered in the pool. No SMS OTP is mentioned anywhere. No password authentication.
- Account creation is implicit: "Entering your email creates an account" (1a) — i.e. sign-up == sign-in via email OTP; `users` row is "created on first sign-in from the JWT. No credentials stored."
- Client: Amplify Auth / Cognito SDK in the browser; passkey ceremony, OTP, Apple OIDC, **silent refresh**; **tokens held in memory only** (no localStorage).
- Service side: JWT signature + claims verified on WS upgrade and every REST call; `sub` → `users.cognito_sub`.
- Session lifetime: **not numerically specified** in either document. The Error Pages doc says a 401 arises when "You were signed out after a period of inactivity, or from another device" (implies an inactivity timeout and remote sign-out/revocation), and 401 handling remembers the document path so sign-in returns to "the same cell, not the library."
- Sign-out behaviour per option as listed above; 1c additionally exposes **Switch account** and names the last document.
- Error states: the sign-in doc itself defines none; auth-related error states are covered by the 401 (session ended) and 403 (no access) pages below. Invites for unknown emails convert to shares on first sign-in (`invites` table).

---

## 3. ERROR PAGES ("turn 2 — Error pages")

Intro (verbatim): "In the lattice style of 1b: the error is a cell on the grid. The status code sits in the ruler where a row number would be, so the page reads as part of the product rather than a browser default. Every page names what happened, what it means for your work, and the one thing to do next."

Card layout (from the template): a mini lattice with column ruler `A B C` and row ruler `1 2 {code} 4 5` (the status code replaces row 3). Inside the cell: header `GeDe · {code}`; then `kicker` (small mono label), `title`, `body`, two buttons (`cta` primary, `alt` secondary), and a footer strip with `meta` (left) and `ref` (right, copyable reference). Severity: sev 4 → amber (`#b45309`, tint `#fdf6ec`); sev 5 → red (`#b42318`, tint `#fdeceb`); the card's top rule carries that colour.

### Page catalogue (all fields verbatim from the data array)

**400 · Bad request · "Malformed link or payload"** (amber)
- kicker: `request`
- title: **That link is not a workscape**
- body: "The address is incomplete or has been altered. If you followed it from an email, the link may have been broken across two lines."
- cta: **Go to my workscapes** · alt: **Paste the link again**
- meta: `no request sent` · ref: `ref 4a19c2`
- behaviour: "Full page. Nothing was opened, so nothing is at risk. The pasted-link field validates before it re-navigates."

**401 · Unauthenticated · "Session expired or token revoked"** (amber)
- kicker: `session`
- title: **Your session ended**
- body: "You were signed out after a period of inactivity, or from another device. Any edits you had made are held on this device and will sync once you are back."
- cta: **Sign in** · alt: **Switch account**
- meta: `edits held locally` · ref: `ref 401·sess`
- behaviour: "Full page, but the document path is remembered — signing in returns you to the same cell, not the library."

**403 · No access · "Signed in, but not a participant"** (amber)
- kicker: `permission`
- title: **You do not have access to this workscape**
- body: "It exists, but you are not on its participant list. The owner can add you; requesting access sends them a single message."
- cta: **Request access** · alt: **Back to my workscapes**
- meta: `owner · Meenarapan D` · ref: `ref 403·wsp`
- behaviour: "Full page. The document name is never shown to a non-participant — only that it exists. Requesting access is rate-limited to one per day."

**404 · Not found · "Deleted, moved, or never existed"** (amber)
- kicker: `address`
- title: **Nothing at this address**
- body: "The workscape may have been deleted by its owner. Anything deleted in the last 30 days can still be recovered from Recently Deleted."
- cta: **Open Recently Deleted** · alt: **Go to my workscapes**
- meta: `checked 3 shards` · ref: `ref 404·nf`
- behaviour: "Full page. A 404 on a sheet or table within an open document is a placed card on the canvas instead, so the rest of the document stays usable."

**429 · Too many requests · "Rate limit reached"** (amber)
- kicker: `throttled`
- title: **Slow down for a moment**
- body: "This document received an unusual number of changes in a short time. Editing resumes automatically in a few seconds; nothing has been lost."
- cta: **Retry now** · alt: **Work offline**
- meta: `retrying in 4s` · ref: `ref 429·rl`
- behaviour: "Banner, not a full page — the document stays on screen and editable against the local replica. The countdown is live."

**500 · Server error · "Unhandled failure in the API"** (red)
- kicker: `server`
- title: **Something failed on our side**
- body: "Your edits are safe on this device and will sync when the service recovers. The failure has been reported automatically with the reference below."
- cta: **Retry** · alt: **Go to my workscapes**
- meta: `attempt 3 of 4` · ref: `ref 500·7fd1e9`
- behaviour: "Full page only if the document never rendered; otherwise a banner. Retries run automatically with backoff before this page appears."

**503 · Unavailable · "Deployment or capacity event"** (red)
- kicker: `maintenance`
- title: **GeDe is updating**
- body: "A new version is rolling out. This usually takes under two minutes. This page checks for you and will continue on its own."
- cta: **Check now** · alt: **Go to status page**
- meta: `polling · 15s` · ref: `ref 503·dep`
- behaviour: "Full page with automatic polling every 15 s. No manual refresh needed; the button only shortcuts the next poll."

**504 · Timeout · "Upstream took too long"** (red)
- kicker: `timeout`
- title: **This is taking longer than expected**
- body: "The document is large or the service is busy. The request is still being attempted in the background; you can keep working offline in the meantime."
- cta: **Keep waiting** · alt: **Work offline**
- meta: `elapsed 31s` · ref: `ref 504·tmo`
- behaviour: "Banner over a skeleton, not a hard failure page — a slow document is not a broken one, and the skeleton keeps the final geometry."

### Rules (verbatim)
- Never lose work: unsaved edits stay in the local replica through every error state.
- Say what happened in the title, what it means in the body, one action in the button.
- Reference code in the footer, copyable, so support can find the request.
- No apology theatre, no "Oops", no illustrations of broken robots.
- 4xx is amber, 5xx is red, and the top rule of the card carries that colour.

### Placement (routing rules, verbatim)
- Full page only when the document cannot render at all.
- Inside the canvas as a placed card when one table fails to load.
- As a banner when the document works but a background operation failed.
- As a toast when the failure is transient and retried automatically.

### Retry policy (verbatim)
- 5xx and 429 retry automatically with exponential backoff, four attempts, jittered.
- 4xx never auto-retries — the request was wrong, repeating it will not help.
- 503 during deployment shows the maintenance page and polls every 15 s.
- After exhausted retries the state becomes an explicit error with a manual Retry.

### Implied product/system requirements surfaced by the error pages
- "Workscape" is the user-facing name for a document/workbook; "my workscapes" is the library route.
- A **Recently Deleted** view with **30-day** recovery (consistent with `documents.deleted_at` soft delete in the data model).
- A **Request access** flow (owner notification, rate-limited to one per day per requester) — not present in the C4 REST list, so it is an addition to the Documents & Sharing API.
- A **status page** link target for 503.
- Local replica (IndexedDB) must survive 401/429/500/504 and resync — matches Document Store's IndexedDB persistence and the Sync Client's backoff reconnect.
- 401 must preserve deep-link (document + cell) through the sign-in round trip.
- Copyable reference ids in the format `ref <code>·<tag>` or hex, tied to server request ids for support lookup.
