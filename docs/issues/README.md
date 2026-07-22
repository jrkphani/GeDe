# Issues

One markdown file per issue: `NNN-short-slug.md`. Each issue is a **vertical slice** — schema → store → UI — sized for TDD: the *Test-first plan* lists the red tests to write first, and acceptance = those tests passing plus the standing gates (`npx tsc --noEmit`, `npx eslint . --quiet`).

## Working agreement (TDD)

1. Pick the lowest-numbered OPEN issue whose blockers are SHIPPED.
2. Write the issue's *Test-first plan* tests; watch them fail.
3. Implement until green; refactor; run `npm run verify`.
4. Update the issue status; commit with the issue number in the message.

> Rows below are the navigation index — one line each. The full history/postmortem for a SHIPPED issue lives in its own file under `done/` (the link follows it there). OPEN issues keep more detail.

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
| [042](done/042-command-palette-semantic-search.md) ✅ | Command palette — client-side semantic search ($0 AWS) | M6 | 017 |
| [030](done/030-v2-server-postgres-compose.md) ✅ | v2 server — CDK VPC + RDS + Fargate (Electric-sync stub) | M8 | 029, 040 |
| [031](done/031-sync-engine-decision.md) ✅ | Sync-engine decision — **ElectricSQL** (ADR-0008) | M8 | — |
| [032](done/032-sync-integration-row-delta.md) ✅ | Sync — Electric read-path → PGlite + client optimistic-write queue | M8 | 030, 031 |
| [043](done/043-write-path-api-server-authority.md) ✅ | **Write-path API** — server write authority + invariant enforcement | M8 | 030, 032, 033, 034 |
| [033](done/033-auth-account.md) ✅ | Authentication + account — **Cognito** (email/pw) + hero/login | M9 | 030 |
| [034](done/034-workspaces-rls-tenancy.md) ✅ | Workspaces + Postgres RLS multi-tenancy | M9 | 032, 033 |
| [035](done/035-sharing-roles-invitations.md) ✅ | Sharing — roles & invitations | M9 | 034, 033 |
| [036](done/036-sync-state-offline-ui.md) ✅ | Sync state + offline reconciliation UI | M8 | 032 |
| [037](done/037-local-to-cloud-migration.md) ✅ | Local → cloud project migration (on-ramp) | M10 | 033, 034, 032 |
| [038](done/038-presence-live-collaboration.md) ✅ | Presence + live collaboration (cross-tab slice) | M10 | 032, 034, 035 |
| [044](done/044-frontend-cognito-config-live-signin.md) ✅ | Frontend Cognito config — enable live sign-in in the deployed build | M11 | 033 |
| [045](done/045-apply-migrations-to-rds.md) ✅ | Apply the Drizzle migration history to the deployed RDS | M11 | 030 |
| [046](done/046-deploy-real-write-lambda-and-issuer.md) ✅ | Deploy the real write-path Lambda + wire the Cognito issuer | M11 | 043, 045, 044 |
| [047](done/047-api-tls-https-endpoint.md) ✅ | HTTPS for the write API — end the mixed-content block | M11 | 030 |
| [048](done/048-client-write-queue-flush.md) ✅ | Flush the client write-queue to `/write` — close the loop | M11 | 044, 045, 046, 047, 032 |
| [049](done/049-db-inspection-api.md) ✅ | Database inspection API — read-only diagnostic queries vs cloud RDS | M11 | 045, 046, 047 |
| [050](done/050-workspace-provisioning-sync-enablement.md) ✅ | Auto-provision workspace on sign-in + enable sync (write-loop last mile) | M11 | 034, 043, 048, 049 |
| [051](done/051-sync-read-path-crash-on-empty-url.md) ✅ | Bug: enabling sync crashed the app (read-path Electric on empty URL) | M11 | 050 |
| [052](done/052-write-api-missing-claims-workspace-id.md) ✅ | Bug: write API rejected every signed-in write with 401 missing_claims | M11 | 050 |
| [053](done/053-pgwritestore-duplicate-id-column.md) ✅ | Bug: PgWriteStore INSERT duplicated the `id` column (Postgres 42701) | M11 | 043, 050 |
| [054](done/054-pgwritestore-camelcase-column-mismatch.md) ✅ | Bug: PgWriteStore used camelCase keys as snake_case columns (42703) | M11 | 043, 050, 053 |
| [055](done/055-share-invitations-never-reach-invitees.md) ✅ | Bug #8: sharing never reached invitees — fixed end-to-end (invite→accept→join→see→persist); spanned 056–067 + 068→072→073→075→078→079→080 | M9/M8 | 035, 080 |
| [056](done/056-mutation-protocol-invitations-workspace-members.md) ✅ | 055 fix 1/3: protocol + write-path carry `invitations`/`workspace_members` | M9/M8 | 043, 048, 050 |
| [057](done/057-shared-workspace-accept-seat-model.md) ✅ | 055 fix 2/3: shared-workspace accept/seat model (breaks 1-user↔1-workspace) | M9 | 056, 034 |
| [058](done/058-electric-read-path-shared-workspace-delivery.md) ✅ | 055 fix 3/3: ElectricSQL read-path deployed & streaming (auth-gated, membership-scoped) | M8 | 057, 032 |
| [059](done/059-share-ux-honest-guard.md) ⊘ CLOSED (superseded) | 055 interim honesty guard — never implemented; 056–058 made sharing work | M9 | — |
| [060](done/060-invitee-accept-flow-unwired.md) ✅ | 055 invitee half: PendingInvitations UI wires accept/decline; accept restarts read-path | M9 | 056, 057, 058 |
| [061](done/061-invitation-notification-to-invitee.md) ✅ | Invitee notification: in-app via 060; email deferred (SES prod access) | M9 | 060, 035 |
| [062](done/062-invitee-cannot-discover-pending-invitation.md) ✅ | Bug #8 blocker: invitations stream via shape proxy, membership/email-scoped (Option B) | M9 | 056, 057, 058, 060 |
| [063](done/063-no-protected-routes-signed-out-access.md) ✅ | Bug: signed-out users still saw data — clear-on-sign-out wipes local PGlite + resets stores → hero | M9/M10 | 033, 064 |
| [064](done/064-hero-landing-page-auth-login-05.md) ✅ | Hero/landing page (sign up/in, product brief); canonical signed-out destination | M9 | 033 |
| [065](done/065-project-list-clickable-affordance.md) ✅ | UX: project-list rows open on click/Enter/Space; rename → pencil/F2 | M6 | 001 |
| [066](done/066-sync-invitation-revoke-decline-resend.md) ✅ | Bug: invitation revoke/decline/resend now enqueue to the sync queue | M9 | 056, 062 |
| [067](done/067-stream-workspace-members-to-clients.md) ✅ | `workspace_members` streams (membership-scoped, fail-closed; migration 0014) | M9 | 062, 057 |
| [068](done/068-read-path-auth-and-signin-rehydration.md) ✅ | Keystone fix #8+#11: authenticate the Electric read-path + rehydrate projects on sign-in | M9/M8 | 063, 050 |
| [069](done/069-duplicate-project-entry-on-create.md) ✅ | Bug #10: duplicate project on create — in-flight-lock createProject + dedupe + PhantomInput guard | M6 | 068 |
| [070](done/070-archived-projects-view-and-restore.md) ✅ | Bug #9: archived projects unreachable — listArchivedProjects + Archived view + restore | M6 | 069 |
| [071](done/071-write-path-self-heal-workspace-provisioning.md) ✅ | Critical: every POST /write 502'd — self-heal caller's workspace before writes (ensureOwnWorkspace) | M11 | — |
| [072](done/072-streamed-projects-dropped-local-fk-and-no-refresh.md) ✅ | Critical: streamed project never rendered — ensure workspace in apply tx + projectsAppliedAt refresh | M8/M11 | — |
| [073](done/073-domain-content-mutations-never-reach-write-outbox.md) ✅ | Critical: domain content never enqueued — one `enqueueIfSyncing` choke point, all mutating sites wired | M11 | — |
| [075](done/075-design-tier-inbound-deltas-not-materialized.md) ✅ | Critical: Design tier never materialized — parent-before-child retry drain + per-store `*AppliedAt` subscriptions | M8/M11 | — |
| [076](done/076-shapeproxy-lambda-timeout-severs-electric-longpoll.md) ✅ | Critical: read-path 502s — ShapeProxy Lambda timeout (15s) < Electric long-poll (~20s); raised to 30s | M8/M11 | — |
| [077](done/077-retry-drain-whole-batch-rollback-poisons-materialization.md) ✅ | 075A drain rollback poisoned the batch — deferred FK for `dimensions.contextId` + drain-resilient retry | M8 | — |
| [078](done/078-electric-serves-stale-empty-shapes.md) ✅ | Critical: Electric served stale/empty shapes — pin `:1.7.7` + migration 0015 denormalize `workspace_id` (drop `allow_subqueries`) | M8 | 073 |
| [079](done/079-invitations-dropped-on-local-workspace-fk.md) ✅ | Critical: invitations dropped on client apply — `ensureWorkspaceStub` self-heal in all 3 apply cases | M8 | 072 |
| [080](done/080-accept-invite-rejected-cross-tenant.md) ✅ | Critical: accept-invite rejected `cross_tenant` — dedicated server-authoritative `/accept` endpoint (atomic seat) | M9/M8 | 057, 079 |
| [081](done/081-tier1-existing-scenario-rich-text.md) ✅ | Tier 1 "Existing Scenario" rich-text (Lexical, migration 0016, envelope v3→v4) | M5/M6 | 013 |
| [082](done/082-design-route-ux.md) ✅ | Design route Phase 1 (soft-hint floor + keyboard rail + append dots); Phase 2 superseded by 085 | M6 | 081 |
| [083](done/083-tier-editing-lockout-role-gate.md) ✅ | Tier editing lockout — fail-open role gate on the self-membership streaming race | M6/M9 | — |
| [084](done/084-tier2-architecture-ux.md) ✅ | Tier 2 Architecture grid-grammar unification (P0–P6): threaded EditableGrids, typed add-child, listbox promote a11y, indent. Unblocks 089 D3 | M6 | 083 |
| [085](done/085-design-route-consolidated-editing.md) ✅ | Design route — one keyboard-continuous rail+register, canvas-as-visual, even-fill ring; supersedes 082 P2 | M6 | 082 |
| [086](done/086-sync-status-miscalibration.md) ✅ | Sync status over-sensitivity — ignore transient/boot-race, debounce genuine errors 5s; delivery error → 088 | M8 | — |
| [087](done/087-surface-silent-write-failures.md) ✅ | Surface a sustained WRITE-outbox stall calmly (split from 086) | M8 | — |
| [088](done/088-genuine-sync-error-on-fresh-load.md) ✅ | Fresh-load false "Sync error" — per-row fallback drain + single-flight guard | M8 | — |
| [089](done/089-unified-canvas-workspace.md) ✅ | Unified canvas workspace — `?d3rf` React Flow canvas is the capability-gated DEFAULT; recursion/coverage as satellite/twin nodes (P0–P7 + 093). Follow-ups: 099, 100 | M7 | 090, 084 |
| [090](done/090-multiple-design-canvases.md) ✅ | Canvas a first-class entity (N root canvases/project; migration 0017) | M8 | — |
| [091](done/091-editing-item-no-longer-exists-note.md) ✅ | Bug: "item no longer exists" — resolve `tier1_purpose` by `project_id` for update + checkTenancy | M8 | — |
| [092](done/092-undo-redo-cross-lane-staleness.md) ✅ | undo/redo of cross-tier ops didn't refresh the co-mounted Design lane (089-D2) | 089-D2 | — |
| [093](done/093-d3-context-register-extend-right.md) ✅ | D3 canvas — context register extends RIGHT (capped+LOD); top "New context" removed | M6 | 089-D3 |
| [094](done/094-undo-redo-mutations-not-persisted-to-sync-outbox.md) ✅ | undo/redo not enqueued to sync outbox — new server `revive` op; also fixes restore-from-archive cloud bug | M8 | — |
| [095](done/095-tier1-purpose-upsert-23505-on-secondary-unique.md) ✅ | `tier1_purpose` upsert 23505 — upsert on natural key; residual id-divergence → 091 | M8/M11 | — |
| [096](done/096-d3-canvas-e2e-flakes-blocked-deploys.md) ✅ | Flaky `?d3rf` viewport tests silently blocked deploys — hardened + `@dev-flag` guard (later graduated into `verify`; tag kept as rollback lever) | CI/deploy | — |
| [097](done/097-tier1-purpose-upsert-cross-tenant-overwrite.md) ✅ (SECURITY) | 095's natural-key upsert could re-tenant another workspace's row — guarded `WHERE workspace_id = EXCLUDED` | M9 | — |
| [098](done/098-write-insert-fk-tenancy-gap.md) ✅ (SECURITY) | write-path insert/update didn't verify FK targets belong to caller's workspace — `resolveForeignKeyTenancy` | M9 | — |
| [099](099-canvas-default-coverage-and-a11y-followups.md) **OPEN** — manual-only remainder | Canvas-default coverage/a11y follow-ups (089-P7). DONE: canvas-side hover-mute + dual-empty-state e2e (`8cc03d2`); 2b/2c (CoverageMatrix ARIA grid; screen-space dot hit target); per-lane axe scans (Foundation/Architecture) + landmark/focus-order + deterministic cross-node-Tab focus-settle (`expect.poll`) + label-tier-stable-across-zoom lock (`6434752`). REMAINING: **only** touch/tablet pan-zoom + node-drag on a real coarse-pointer device (MANUAL — cannot automate) | M7 | 089-P7 |
| [100](done/100-canvas-live-child-core.md) ✅ | Recursion satellite stub → LIVE child {register+ring} core beside its independent parent (client store-lifetime refactor A–E). Refinements → 106 | M7 | 089-P3, 090 |
| [101](done/101-canvas-click-should-not-pan.md) ✅ | Canvas click wrongly panned — focus-pan now keyboard-only (input-modality ref) | M7 | 089-P7 |
| [102](done/102-add-child-swallowed-while-editing-description.md) ✅ | "Add child" swallowed while a description cell mid-edit — suppress `editing` while add-child armed | M7 | 084, 089-D1-P5 |
| [103](done/103-foundation-value-proposition-authoring-ux.md) ✅ | Foundation value-prop authoring — labels/heading/empty-state + Name-cell append-symmetry; append fork deferred | M7 | 013, 081, 084, 089-D1-P5 |
| [104](done/104-add-child-row-presentation-and-keyboard.md) ✅ | Add-child row presentation/keyboard (72px floor, spacing, tab-rotate); empty-space fork decided leave-as-is | M7 | 102, 084 |
| [105](done/105-architecture-tree-promote-demote-keyboard.md) ✅ | Architecture tree keyboard tree-building (P0–P5 + both LOW nits): **P0** kill sub-child (Tab intercept) · **P1** Enter=sibling · **P2** ⌘]/⌘[ promote/demote · **P3** ⌥⇧↑/↓ move · **P4** tree ARIA + KeyHints · **P5** ⋯ row-action menu (pointer twin of the chords via shared target-computers; disabled = keyboard no-op). Sibling logic deduped into `domain/entryTree`; chords exclude `ctrlKey`. Residuals RESOLVED: P1 phantom-anchor polish shipped (`f72596c`); PGlite-txn-wrapping Phase 1 (`moveTier2Entry`) shipped (`dc51894`) — remaining multi-write mutations tracked as issue 107 | M7 | 084, 102, 104 |
| [106](done/106-canvas-live-child-core-refinements.md) ✅ | Canvas live-child-core refinements (all 3 SHIPPED): **③** presence + palette reach child-core selections (`c90d787`); **②** nested-drill grandchild positioning — parent-anchored column + edge (`d132bb7`); **①** zoom-LOD auto-culling of off-screen/deep child cores → stubs (edit-aware, keep-store; `3dfe87c`). Follow-ups (non-blocking, tracked): grandchild breadcrumb depth; e2e for the LOD/positioning render wiring | M7 | 100 |
| [107](107-transaction-wrap-multi-step-mutations.md) **OPEN** — non-blocking (from 105) | Transaction-wrap the remaining ~20 multi-step DB mutations for atomicity (Phase 1 `moveTier2Entry` shipped `dc51894`); Phases 2–5 are mechanical repeats of the proven, reviewed pattern | M8/M11 | — |

Issue numbers are identity, not order — pick by the dependency graph. Parallelizable tracks after 004: canvas (008→010), tiers (013→014), palette (017); 005/006 independent.

## Milestones

- **M1–M6 (v1)** — shipped (000–028; 028 = phase a, splines deferred to 039).
- **M7 · Deploy** — 040 (CDK infra) → 029 (OIDC CI). Shipped.
- **M8 · Server & sync** — 030 · 031 (ElectricSQL, ADR-0008) · 032 · 036. Critical path 029 → 030/031 → 032. Shipped.
- **M9 · Identity & tenancy** — 033 · 034 (RLS) · 035 (sharing); sharing-completion track 055→056→057→058 (+059). Shipped.
- **M10 · Collaboration polish** — 037 (on-ramp) · 038 (presence). Shipped.
- **M11 · Close the cloud write loop** — 044 → 045 → 046 → 047 → 048 (+049/050). **Shipped & live** — the end-to-end cloud write loop is closed in production (browser ↔ PGlite ↔ Electric read-path ↔ `/write` Lambda ↔ RDS). See `DEPLOYMENT.md §9`, ADR-0008/0009.

The v2 bet rests on invariants v1 already satisfies: one Postgres dialect + one migration history (PGlite→server verbatim), UUIDv7 + `created_at/updated_at/deleted_at` on every row, and the single mutation layer emitting row-granular changes (the sync seam).

Every issue carries a **Design brief** (STYLE_GUIDE/SITEMAP tokens + patterns) and a **References** line pinning the SPEC/STYLE_GUIDE/SITEMAP/TECH_STACK/ADR sections it implements — deviation from a referenced section is a spec change to discuss, not an implementation choice.

Statuses: `OPEN | IN PROGRESS | SHIPPED | ARCHIVED`. **SHIPPED issues move to `done/`** (index links follow them; the row stays as the permanent record). Issues graduate to GitHub Issues if/when collaboration warrants it.
