# Issues

One markdown file per issue: `NNN-short-slug.md`. Each issue is a **vertical slice** — schema → store → UI — sized for TDD: the *Test-first plan* section lists the red tests to write before any implementation, and the acceptance criteria are those tests passing plus the standing gates (`npx tsc --noEmit`, `npx eslint . --quiet`).

## Working agreement (TDD)

1. Pick the lowest-numbered OPEN issue whose blockers are SHIPPED.
2. Write the issue's *Test-first plan* tests; watch them fail.
3. Implement until green; refactor; run `npm run verify`.
4. Update the issue status; commit with the issue number in the message.

## Index

| # | Slice | Milestone | Blocked by |
| --- | --- | --- | --- |
| [000](done/000-walking-skeleton.md) ✅ | Walking skeleton & TDD harness | M1 | — |
| [001](done/001-projects-crud-persistence.md) ✅ | Projects CRUD + reload durability | M1 | 000 |
| [016](done/016-app-shell-navigation.md) ✅ | App shell — routes, header, tabs, status bar | M1 | 001 |
| [002](done/002-dimension-management.md) ✅ | Dimension management (n ≥ 2) | M1 | 001 |
| [003](done/003-parameters-on-dimensions.md) ✅ | Parameters on dimensions | M1 | 002 |
| [004](done/004-context-register-editable-grid.md) ✅ | Context register + EditableGrid core | M1 | 003, 016 |
| [005](done/005-justification-documented-duplicates.md) ✅ | Justification, documented, duplicates | M1 | 004 |
| [006](done/006-undo-redo-command-log.md) ✅ | Undo/redo command log | M1 | 004 |
| [007](done/007-dimension-mutability-demotion.md) ✅ | Dimension mutability + demotion | M1 | 005, 006 |
| [008](done/008-canvas-readonly-deterministic-layout.md) ✅ | Canvas read-only + deterministic layout | M2 | 004 |
| [009](done/009-canvas-selection-composer-sync.md) ✅ | Selection, spokes, composer, sync | M2 | 008 |
| [010](done/010-compose-bind-from-canvas.md) ✅ | Compose & bind from canvas | M2 | 009 |
| [011](done/011-recursion-drilldown-breadcrumbs.md) ✅ | Recursion, drill-down, breadcrumbs | M3 | 010 |
| [012](done/012-coverage-matrix.md) ✅ | Coverage matrix | M4 | 010 |
| [013](done/013-tier1-foundation.md) ✅ | Tier 1 Foundation | M5 | 004, 016 |
| [014](done/014-tier2-architecture-promote.md) ✅ | Tier 2 Architecture + promote | M5 | 013 |
| [015](done/015-export-import-json.md) ✅ | Export/import JSON | M6 | 011, 014 |
| [017](done/017-command-palette.md) ✅ | Command palette (⌘K) | M2 | 016, 004 |
| [018](done/018-shadcn-tailwind-foundation.md) ✅ | shadcn/ui + Tailwind v4 foundation | M1 (pre-work) | — |
| [019](done/019-shared-primitive-migration.md) ✅ | Shared UI primitives + migration | M1 (pre-work) | 018 |
| [020](done/020-enforcement-guardrails.md) ✅ | Enforcement guardrails (types/tokens/components) | M1 (pre-work) | 019 |
| [021](done/021-editable-grid-accessible-names.md) ✅ | Accessible names & grid semantics (EditableGrid) | M6 | 004 |
| [022](done/022-grid-keyboard-editing-grammar.md) ✅ | Grid keyboard editing grammar (Tab/Enter) | M6 | 004 |
| [023](done/023-canvas-parameter-dots-labels.md) ✅ | Canvas parameter dots + labels (invisible params) | M2/M6 | 008 |
| [024](done/024-grid-column-separators.md) ✅ | Table legibility — zebra rows + column hairlines | M6 | 004 |
| [025](done/025-architecture-selection-bar-placement.md) ✅ | Architecture selection/promote bar placement | M6 | 014 |
| [026](done/026-standalone-button-affordance.md) ✅ | Standalone button affordance (no-fill buttons) | M6 | 019 |
| [027](done/027-design-tier-layout-navigation.md) ✅ | Design tier layout cleanup + navigation clarity | M6 | 009, 011 |
| [028](done/028-canvas-focus-adjacency.md) ✅ | Canvas focus + adjacency (phase a; splines deferred) | M6 | 008, 009 |
| [039](done/039-canvas-spline-bundling.md) ✅ | Canvas spline bundling (028 phase b) | M6 | 028 |
| [040](done/040-cdk-aws-deployment.md) ✅ | CDK AWS deployment — network → hosting → DNS (test env) | M7 | — |
| [029](done/029-deploy-oidc-static-pwa.md) ✅ | Deploy pipeline — GitHub Actions OIDC → `cdk deploy` | M7 | 040 |
| [041](done/041-cdk-hosting-snapshot-dist-sensitivity.md) ✅ | CDK hosting snapshot env-sensitivity (local `dist/` breaks CI) | M7 | 040 |
| [042](done/042-command-palette-semantic-search.md) ✅ | Command palette — semantic search (client-side embeddings, $0 AWS) | M6 | 017 |
| [030](done/030-v2-server-postgres-compose.md) ✅ | v2 server — CDK VPC + RDS + Fargate (Electric-sync stub; auth → Cognito, ADR-0009) | M8 | 029, 040 |
| [031](done/031-sync-engine-decision.md) ✅ | Sync-engine decision — **ElectricSQL** (T6, decided → ADR-0008) | M8 | — |
| [032](done/032-sync-integration-row-delta.md) ✅ | Sync — Electric **read-path** → PGlite + client optimistic-write queue (read-only collab; LWW server-side in 043) | M8 | 030, 031 |
| [043](done/043-write-path-api-server-authority.md) ✅ | **Write-path API** — server write authority + invariant enforcement (Tier 2, serverless) | M8 | 030, 032, 033, 034 |
| [033](done/033-auth-account.md) ✅ | Authentication + account — **Cognito** (email/pw) + hero + login screen | M9 | 030 |
| [034](done/034-workspaces-rls-tenancy.md) ✅ | Workspaces + Postgres RLS multi-tenancy | M9 | 032, 033 |
| [035](done/035-sharing-roles-invitations.md) ✅ | Sharing — roles & invitations | M9 | 034, 033 |
| [036](done/036-sync-state-offline-ui.md) ✅ | Sync state + offline reconciliation UI | M8 | 032 |
| [037](done/037-local-to-cloud-migration.md) ✅ | Local → cloud project migration (on-ramp) | M10 | 033, 034, 032 |
| [038](done/038-presence-live-collaboration.md) ✅ | Presence + live collaboration (speculative; cross-tab slice) | M10 | 032, 034, 035 |
| [044](done/044-frontend-cognito-config-live-signin.md) ✅ | Frontend Cognito config — enable live sign-in in the deployed build | M11 | 033 |
| [045](done/045-apply-migrations-to-rds.md) ✅ | Apply the Drizzle migration history to the deployed RDS | M11 | 030 |
| [046](done/046-deploy-real-write-lambda-and-issuer.md) ✅ | Deploy the real write-path Lambda + wire the Cognito issuer | M11 | 043, 045, 044 |
| [047](done/047-api-tls-https-endpoint.md) ✅ | HTTPS for the write API — end the mixed-content block | M11 | 030 |
| [048](done/048-client-write-queue-flush.md) ✅ | Flush the client write-queue to `/write` — close the loop | M11 | 044, 045, 046, 047, 032 |
| [049](done/049-db-inspection-api.md) ✅ | Database inspection API — read-only diagnostic queries against the cloud RDS | M11 | 045, 046, 047 |
| [050](done/050-workspace-provisioning-sync-enablement.md) ✅ | Auto-provision workspace on sign-in + enable sync (write loop last mile) | M11 | 034, 043, 048, 049 |
| [051](done/051-sync-read-path-crash-on-empty-url.md) ✅ | Bug: enabling sync crashed the signed-in app (read-path Electric on an empty URL) | M11 | 050 |
| [052](done/052-write-api-missing-claims-workspace-id.md) ✅ | Bug: write API rejected every signed-in write with 401 missing_claims | M11 | 050 |
| [053](done/053-pgwritestore-duplicate-id-column.md) ✅ | Bug: PgWriteStore INSERT duplicated the `id` column (Postgres 42701) | M11 | 043, 050 |
| [054](done/054-pgwritestore-camelcase-column-mismatch.md) ✅ | Bug: PgWriteStore used camelCase payload keys as snake_case SQL columns (Postgres 42703) | M11 | 043, 050, 053 |
| [055](055-share-invitations-never-reach-invitees.md) ◐ partial | Bug: sharing a project never reaches invitees. **Write-path fixed & verified live** (056/057/058 shipped; invite reaches RDS, Electric streaming). **Invitee delivery still open**: no accept UI (060) ⇒ no seat ⇒ read-path can't deliver; no invitee notification (061) | M9/M8 | 035, 043, 048, 050 |
| [056](done/056-mutation-protocol-invitations-workspace-members.md) ✅ | 055 fix (1/3): extend mutation protocol + write-path to carry `invitations`/`workspace_members` writes | M9/M8 | 043, 048, 050 |
| [057](done/057-shared-workspace-accept-seat-model.md) ✅ | 055 fix (2/3): shared-workspace accept/seat model — breaks the 1-user↔1-workspace invariant | M9 | 056, 034 |
| [058](done/058-electric-read-path-shared-workspace-delivery.md) ✅ | 055 fix (3/3): ElectricSQL read-path **deployed & streaming live** (Electric 1.7.7 replicating; shape-proxy auth-gated + membership-scoped). Delivery to a *seated* invitee is unverified end-to-end — blocked by 060 (no accept UI ⇒ no seat) | M8 | 057, 032 |
| [059](059-share-ux-honest-guard.md) ⊘ superseded | 055 interim mitigation (NOT shipped — 056–058 make sharing actually work, so the "unavailable" guard is moot; kept as fallback if the live read-path is found not to stream) | M9 | — |
| [060](done/060-invitee-accept-flow-unwired.md) ✅ | 055 fix, invitee half: `PendingInvitations` UI wires `acceptInvitation`/new `declineInvitation` — invitees can now see + accept/decline invites; accept restarts the read-path so the shared project streams in. Live two-identity smoke deferred to the orchestrator | M9 | 056, 057, 058 |
| [061](done/061-invitation-notification-to-invitee.md) ✅ | Invitee notification: in-app via 060 + honest "Extend" relabel; email deferred (blocked on SES prod access). Tester request | M9 | 060, 035 |
| [062](done/062-invitee-cannot-discover-pending-invitation.md) ✅ | Bug (#8 real blocker) fixed: `invitations` now streams via the shape proxy, scoped to membership OR the caller's own verified email (Option B — no new CDK resources), so a fresh invitee's badge now appears without a manual reload | M9 | 056, 057, 058, 060 |
| [063](done/063-no-protected-routes-signed-out-access.md) ✅ | Bug fixed: signed-out users could still access project data in the same browser. **Clear-on-sign-out** — `signOut()` wipes local PGlite data + resets projects/workspace/sync stores, then redirects to the 064 hero (keeps local-first; no hard route gate) | M9/M10 | 033, 064 |
| [064](done/064-hero-landing-page-auth-login-05.md) ✅ | Hero/landing page (`HeroLanding`, shadcn `login-05`) with sign up + sign in, product brief, STYLE_GUIDE; the canonical signed-out + sign-out destination (replaces Hero/LoginScreen) | M9 | 033 |
| [065](done/065-project-list-clickable-affordance.md) ✅ | UX: project-list rows now open on click/Enter/Space with hover/focus highlight + chevron cue; rename moved to a revealed pencil/F2 (click no longer renames) | M6 | 001 |
| [066](done/066-sync-invitation-revoke-decline-resend.md) ✅ | Bug fixed: invitation revoke/decline/resend now enqueue to the sync queue (an already-tombstoned/updated row would otherwise stay live server-side after 062 started streaming invitations) | M9 | 056, 062 |
| [067](done/067-stream-workspace-members-to-clients.md) ✅ | `workspace_members` now streams (membership-scoped, fail-closed; `membersAppliedAt` refresh; migration 0014) so the shared Members list stays consistent across users | M9 | 062, 057 |
| [068](068-read-path-auth-and-signin-rehydration.md) ✅ code-complete, smoke pending | **Keystone bug fix**, fixes #8 + #11: the Electric read-path was never authenticated (`sync.start()` defaulted to `noAuth` ⇒ shape proxy 401s for every real client) and sign-in/hydrate never rehydrated projects (`refreshProjects()` never called; its own restart was also gated on `sync.enabled`, which 063's sign-out reset leaves false). All three now fixed + covered by red-first tests; `verify:fast` green (1058 tests). Live cross-session + cross-identity smoke still owed | M9/M8 | 063, 050 |
| [069](done/069-duplicate-project-entry-on-create.md) ✅ | Bug fixed (#10): `createProject`'s bespoke optimistic prepend was the one store mutation not re-entrancy-safe — two overlapping calls each ran their own `dbCreate` insert, landing two real duplicated DB rows for the same name. Now keyed in-flight-locked (joins an existing same-name create instead of inserting twice) and re-reads via `dbList` like every sibling mutation; `ProjectsList` dedupes by id (defense-in-depth); `PhantomInput` ignores a second Enter while a promise-returning `onSubmit` is still pending. `verify:fast` green (1061 tests) | M6 | 068 |
| [070](done/070-archived-projects-view-and-restore.md) ✅ | Bug fixed (#9): archiving is a durable soft-delete, but nothing ever surfaced archived rows beyond the single-slot, session-scoped command-log undo — a project archived more than once ago was unreachable. Added `listArchivedProjects` (read path, most-recently-archived first), `archivedProjects`/`loadArchivedProjects`/`restoreArchivedProject` in the projects store (durable, undoable, additive), and an "Archived projects" toggle in `ProjectsList`'s toolbar surfacing a per-row Restore control. `verify:fast` green (1068 tests) | M6 | 069 |
| [071](071-write-path-self-heal-workspace-provisioning.md) IMPLEMENTED, deploy+smoke pending | **Severity Critical** — every `POST /write` 502ed: the caller's workspace row was never provisioned in RDS (provisioning is a one-shot Cognito PostConfirmation trigger, no self-heal), so the first `INSERT INTO projects` hit a Postgres FK violation (23503), uncaught → ALB 502; nothing persisted server-side. Fixed by self-healing the CALLER's own workspace (`ensureOwnWorkspace`, keyed on the server-verified sub only — never a mutation's declared workspaceId) before every write's mutation loop, reusing `provisionWorkspace`'s idempotent inserts (no duplicated SQL, no migration). `writeApi/albAdapter.ts` also now catches a thrown write-path error into a logged, diagnosable 500 instead of an opaque 502. `verify:fast` green (1072 tests, 4 new) | M11 | — |

Issue numbers are identity, not order — pick by the dependency graph (016 comes right after 001). Parallelizable tracks after 004: canvas (008→010), tiers (013→014), palette (017), and 005/006 can proceed independently.

**v1 milestones** M1–M6 are shipped (000–028; 028 is phase (a) — hover/focus adjacency emphasis — with spline bundling deferred). **v2 (collaboration)** is milestones **M7–M10**, all OPEN and grounded in TECH_STACK §6.3 + SPEC §1/§3:

- **M7 · Deploy** — 040 (CDK infra: network → hosting → DNS, `GeDe`/`test`/`quadnomics` tags, default CloudFront domain) → 029 (OIDC CI that `cdk deploy`s it). The foundation everything else ships onto.
- **M8 · Server & sync** — 030 (server Postgres) · 031 (T6 engine decision → ADR) · 032 (row-delta LWW sync) · 036 (sync-state UI). The critical path: **029 → 030/031 → 032**.
- **M9 · Identity & tenancy** — 033 (auth) · 034 (workspaces + RLS) · 035 (sharing/roles). **Sharing-completion track (055→056→057→058, +059)**: 035 shipped the schema/RLS/local-CRUD/UI, but a live tester found invitations never reach the invitee (055) — 056 wires the protocol + write-path, 057 breaks the 1-user↔1-workspace invariant so an invitee can join the inviter's workspace, 058 deploys the ElectricSQL read-path so they can see it; 059 is an independent, immediately-shippable UX-honesty mitigation.
- **M10 · Collaboration polish** — 037 (local→cloud on-ramp) · 038 (presence, speculative — validate demand first).
- **M11 · Close the cloud write loop (production wiring)** — 044 (inject Cognito config into the deployed build) · 045 (apply migrations to the RDS) · 046 (deploy the real write Lambda + issuer) · 047 (HTTPS for the API) · 048 (flush the client queue to `/write`). Critical path: **044 → 045 → 046 → 047 → 048**. **All 5 SHIPPED** (code complete + combined-verify green, integrated on `m11-close-write-loop`); the loop is closed *in code* — **live AWS rollout is pending CI deploy** on merge to `main` (deploy order 045→046→047; the live-smoke acceptance items verify then).

> **Reality check (verified against live AWS, 2026-07-07).** M7–M10 shipped the v2 *code* and the CDK *infrastructure* (all 6 stacks `*_COMPLETE`, RDS `available`, Cognito pool live, ALB active), but the **end-to-end cloud write loop is not closed in production** — every server-side hop is a documented seam that was never joined: the deployed build has no Cognito ids (live sign-in is disabled), the `/write` Lambda is a `503` inline stub with a placeholder issuer, the RDS has no schema applied (no runner targets it), the ALB is HTTP-only (mixed-content-blocked from the HTTPS frontend), and the client never POSTs to `/write`. What is genuinely live end-to-end is the **local-first app** (browser ↔ PGlite) plus the auth/palette UI shells. **M11 (044–048) closes the loop**, each issue grounded in a specific verified AWS fact. See `DEPLOYMENT.md §9` ("Deployment reality").

The whole v2 bet rests on invariants v1 already satisfies: one Postgres dialect + one migration history (PGlite→server verbatim), UUIDv7 + `created_at/updated_at/deleted_at` on every row, and the single mutation layer that emits row-granular changes (the sync seam). The v2-kickoff decisions are now **made** and the backend is **shipped & live** (ADR-0008): **AWS-native CDK — VPC + NAT + RDS + Fargate** (T5 → RDS, superseding the Lightsail/Compose sketch), sync is **ElectricSQL** (T6), **auth is Amazon Cognito** (ADR-0009, superseding better-auth), RLS authored directly in Postgres. 032/033/034 inherit these; see ADR-0008/0009 and `DEPLOYMENT.md §9`.

Every issue carries a **Design brief** (grounded in STYLE_GUIDE/SITEMAP tokens and patterns) and a **References** line pinning the SPEC/STYLE_GUIDE/SITEMAP/TECH_STACK/ADR sections it implements — deviation from a referenced section is a spec change to discuss, not an implementation choice.

Statuses: `OPEN | IN PROGRESS | SHIPPED | ARCHIVED`. **SHIPPED issues move to `done/`** (index links follow them; the row stays as the permanent record). Issues graduate to GitHub Issues if/when collaboration warrants it.
