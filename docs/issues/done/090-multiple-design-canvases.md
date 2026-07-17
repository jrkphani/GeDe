# 090: Multiple design canvases per project — canvas becomes a first-class entity

- **Status**: DONE ✅ — VERIFIED LIVE (2026-07-17). Phases 1-4 merged + deployed; migration 0017 live-verified clean via CloudWatch AND the 049 debug API on prod: `canvases=32` (25 root = one per project incl. empty ones + 7 child canvases for drill-in contexts), **zero dangling `canvas_id`** (`null_dim=0`, `null_ctx=0`), and `app_user` GRANT = `DELETE,INSERT,SELECT,UPDATE` (the GRANT bug the RLS test caught, confirmed fixed on prod). Owner UI smoke PASSED: the `Canvas ⌄` switcher creates/switches, two canvases hold independent dimensions, and cascade-delete + status-bar Undo restores. Schema-bearing vertical slice. Surfaced during the 089 unified-canvas design cycle; **separable from** and **sequences before** the React-Flow canvas merge (land the model + a switcher in the current shell, then 089 renders N canvases as N clusters). See `## What shipped (implementation notes)` below for the corrections discovered during build.
- **Milestone**: M8-ish (sync/schema) for the data slice; the lane UX rides M7 (089). This slice can ship in the **current route UI** (a canvas switcher) with zero dependency on the infinite-canvas work.
- **Related**: **089** (unified canvas — renders each canvas as a cluster; recursion drill-in already modelled as child-canvas clusters), **011** (recursion/drilldown — the implicit child-canvas model this formalizes), **012** (coverage — already per-canvas, unaffected), **088** (FK apply-order — a new parent FK to reason about), **075/077/072/079** (the deferred-FK / retry-drain / ensure-stub machinery a new synced parent touches).

> **This doc has been verified line-by-line against the code.** Every claim below carries a `file:line` citation. Several claims in the original draft were **wrong or incomplete** and are corrected inline (see the "Corrections to the original hypothesis" callouts). The biggest correction: adding a synced table is a **~13-registry** change, not a 3-line one, and `RETRY_APPLY_ORDER` is *derived*, not edited directly.

---

## User story

As a designer, I want **more than one design canvas (ring + register pair) per project**, stacked in the Design lane, so I can explore several independent system designs (or alternatives/versions) side by side within one project — the same way the Foundation and Architecture lanes already hold many tables. Today a project has exactly **one** root canvas, and it is not even a row.

---

## Current state — the root canvas is an implicit composite key (verified)

A canvas has **no row of its own today**. It is a derived composite key `(project_id, context_id/parent_id)`:

- **Dimensions** are canvas-scoped by `(project_id, context_id)`. `context_id IS NULL` ⇒ root canvas; set ⇒ that context's child canvas. The exact selection seam is `canvasScope()` — `src/db/mutations.ts:157-163`:
  > `contextId === null ? isNull(dimensions.contextId) : eq(dimensions.contextId, contextId)`
  `listDimensions(db, projectId, contextId = null)` defaults to root (`mutations.ts:165-170`). Schema: `dimensions.contextId` is nullable (`src/db/schema.ts:212`; migration `0001_dimensions.sql:4` `"context_id" text`).
- **Contexts** are canvas-scoped by `(project_id, parent_id)`, an exact analog — `contextCanvasScope()` at `src/db/mutations.ts:523-529`:
  > `parentId === null ? isNull(contexts.parentId) : eq(contexts.parentId, parentId)`
  `contexts.parentId` nullable self-FK (`schema.ts:259`; `0003_contexts_bindings.sql:14,28`).
- **The UI derives the current canvas from the URL**: `AppRoute.contextPath: string[]` (`src/shell/routes.ts:12`), parsed as `segments.slice(3)` (`routes.ts:46`). `DesignSurface.tsx:39` picks the last segment:
  > `const contextId = contextPath.length > 0 ? contextPath[contextPath.length - 1] : null`
  Then loads the two stores keyed on `(projectId, contextId)` (`DesignSurface.tsx:84-91`), with a render-gate `if (loadedFor !== projectId || loadedContextId !== contextId) return null` (`DesignSurface.tsx:433`). `Canvas.tsx` is **fully prop-driven** — it owns no canvas selection.
- **Recursion (011)** materializes a "child canvas" as *rows*, not a table: `openChildCanvas(db, parentContextId)` (`src/db/mutations.ts:742-823`) seeds one dimension per parent binding, stamping `contextId: parentContextId` and `sourceParamId` (`mutations.ts:777-786`), idempotent on re-open. So `dimensions.context_id` on a child dimension = **the parent context whose child canvas it lives on**.
- **11 synced tables** (`src/domain/syncScope.ts:39-51`), each carrying `workspace_id` directly (migration 0015), each with a `WORKSPACE_SCOPE_SQL` literal predicate (`syncScope.ts:74-96`). Latest migration **0016** (`src/db/migrations/0016_tier1_existing_scenario.sql`); next is **0017**.

> **Correction 1 (creation seeds nothing).** The draft implied a project "has one implicit root canvas". In fact `createProject` (`src/db/mutations.ts:77-87`) inserts **only** the `projects` row — it seeds **no** dimension, context, or canvas. A fresh project has an *empty* root canvas (zero dimension rows). So making canvas first-class means: (a) `createProject` should now **seed one root canvas row**, and (b) the backfill must create a root canvas even for projects that have zero dimensions today.

> **Correction 2 (`parent_id` is NOT an orthogonal tree).** The draft said `contexts.parent_id` "stays (context tree within a canvas is orthogonal)". Verified false: today every context on a child canvas has the **same** `parent_id` = the owning parent context, i.e. `parent_id` currently *is* the canvas-membership pointer, equal to what `canvases.parent_context_id` will hold. There is no intra-canvas context tree. `parent_id` becomes **redundant** once `canvas_id` exists — keep it transitionally, do **not** frame it as orthogonal. (See "Transition strategy" below.)

---

## The change — a `canvases` table (also formalizes recursion)

Add migration **0017**: a synced `canvases` table. Drizzle-kit generates the `CREATE TABLE` + FK DDL; the RLS policies, `ENABLE ROW LEVEL SECURITY`, and `REPLICA IDENTITY FULL` are **hand-appended** to the same file (the established pattern — `0008_workspaces_rls.sql` and `0012_electric_replica_identity.sql` are hand-authored SQL with no drizzle counterpart; see `0012`'s header at lines 11-15).

```
canvases
  id                text PK NOT NULL
  project_id        text NOT NULL  → projects(id)
  workspace_id      text NOT NULL  → workspaces(id)   -- sync/RLS scope (0015 convention)
  parent_context_id text NULL      → contexts(id)     -- NULL = ROOT canvas (many per project);
                                                       -- set = the child canvas of that context (1 per context)
  name              text NULL                          -- user-named for root canvases; child derives from context symbol
  sort              integer NOT NULL                   -- ordinal of root canvases within the Design lane
  created_at/updated_at/deleted_at                     -- standard tombstone (SPEC §3)
```

Then add an explicit membership FK to the two child tables:
- `dimensions` gains **`canvas_id text NOT NULL → canvases(id)`** (schema `src/db/schema.ts:204-220`). `context_id` is superseded but **kept transitionally** (see below).
- `contexts` gains **`canvas_id text NOT NULL → canvases(id)`** (schema `src/db/schema.ts:251-267`). `parent_id` kept transitionally.

**This unifies root and child canvases as rows**: a root canvas is `parent_context_id IS NULL` (now *multiple* per project); a child canvas is `parent_context_id = <ctx>` (exactly one per context — enforce with a **partial unique index** `WHERE deleted_at IS NULL AND parent_context_id IS NOT NULL`). The 089 drill-in cluster now hangs off a real row.

### Transition strategy (do NOT drop columns in 0017)

`context_id` (dimensions) and `parent_id` (contexts) are **not** dropped in this slice, for three reasons:
1. Dropping a `NOT NULL`-adjacent column while flipping the read path over is two risky changes at once; keep them nullable and in place.
2. The **server-side dimension floor** query still keys on `context_id` (`src/server/writeApi/store.ts:442-449`, `countLiveDimensions`: `... WHERE project_id = $1 AND context_id IS NULL ...`). Keeping `context_id` means this stays correct with zero server change in Phase 1-3.
3. The 088/075 deferred-FK machinery already knows `dimensions.contextId` and `contexts.parentId` as deferred columns (`src/db/sync.ts:46-51`). Keeping them means the only *new* deferred column is `canvases.parentContextId`.

Drop `context_id` / `parent_id` in a **later cleanup migration (0018+)**, after the read path is fully on `canvas_id` and the server floor query is repointed. Recorded as Open Question 5.

### Migration 0017 backfill (idempotent, lossless)

Inside 0017, after the DDL, hand-authored SQL (mirrors `0008`/`0015` backfill style — `ADD COLUMN` nullable → backfill → `SET NOT NULL`):

1. **Root canvas per project**: `INSERT INTO canvases (id, project_id, workspace_id, parent_context_id, name, sort, ...) SELECT <uuid>, p.id, p.workspace_id, NULL, 'Canvas 1', 0, now(), now() FROM projects p`. (Every project, even ones with zero dimensions — Correction 1.)
2. **Child canvas per distinct child context**: enumerate the **union** of `SELECT DISTINCT context_id FROM dimensions WHERE context_id IS NOT NULL` **and** `SELECT DISTINCT parent_id FROM contexts WHERE parent_id IS NOT NULL` (a child canvas can hold contexts but no seeded dimensions, or vice-versa — must not miss either), and insert one child canvas `parent_context_id = <that context>` per distinct value, `workspace_id` from the owning context row.
3. **Repoint dimensions**: `UPDATE dimensions SET canvas_id = <root canvas of project>` where `context_id IS NULL`; `UPDATE dimensions SET canvas_id = <child canvas whose parent_context_id = context_id>` where `context_id IS NOT NULL`.
4. **Repoint contexts**: same shape keyed on `parent_id` (root context → root canvas; child context → the child canvas of its `parent_id`).
5. `ALTER TABLE dimensions ALTER COLUMN canvas_id SET NOT NULL`; same for `contexts`. Add the FK constraints after backfill (0008/0015 ordering).
6. Guard: assert zero dangling `canvas_id` (DB test).

Idempotency at the migration-runner level is by `__migrations` bookkeeping (`src/db/migrate.ts:22-28`) — a migration runs once. The backfill SQL itself need not be re-runnable, but it must be **deterministic** given the current data.

---

## Sync & FK-apply-order impact (the 088-class part)

> **Correction 3 (a synced table is ~13 registries, and `RETRY_APPLY_ORDER` is derived).** The draft said "add `canvases` to `SYNCED_TABLES`, give it a `WORKSPACE_SCOPE_SQL` entry, a shape, and slot it into `RETRY_APPLY_ORDER`." That understates it by an order of magnitude. `RETRY_APPLY_ORDER` is **`[...ENVELOPE_TABLE_NAMES, 'invitations', 'workspace_members']`** (`src/sync/syncEngine.ts:33`) — it is *computed* from `ENVELOPE_TABLE_NAMES`, so you edit **`ENVELOPE_TABLE_NAMES`**, not `RETRY_APPLY_ORDER`. And because `canvases` is real project content, it joins the **project export/import envelope**, which fans out into ~13 registries (`projectIO.test.ts` cross-checks `ENVELOPE_TABLE_NAMES` against the live drizzle schema, so the build *forces* you to add it everywhere).

### Exact registry checklist to add a synced `canvases` table

Schema / DDL:
1. `src/db/schema.ts` — new `canvases = pgTable('canvases', {...})`; add `canvasId` to `dimensions` (`schema.ts:204-220`) and `contexts` (`schema.ts:251-267`).
2. `src/db/migrations/0017_canvases.sql` — DDL (drizzle-kit) + hand-appended backfill + RLS + `ENABLE ROW LEVEL SECURITY` + `ALTER TABLE canvases REPLICA IDENTITY FULL` (0012 pattern).

Read-path / merge / protocol:
3. `src/domain/projectEnvelope.ts` — add `canvasRow` zod schema; add `'canvases'` to `rowSchemas` (`:191-201`) → this defines `TableName`; add to `ENVELOPE_TABLE_NAMES` (`:205-215`) **positioned after `projects`, before `dimensions`/`contexts`** (drives `RETRY_APPLY_ORDER`); add to `ID_FIELDS` (`:219-229`), `FK_TARGETS` (`:235-245`, with `canvases: { projectId: 'projects', parentContextId: 'contexts' }` plus `canvasId: 'canvases'` on the `dimensions`/`contexts` entries), and `WORKSPACE_SCOPED_TABLES` (via a new `V3_...` list or extend, `:283-286`).
4. `src/domain/syncDelta.ts` — add `'canvases'` to `emptySyncState()` (`:114-128`). (`TableName` here is `EnvelopeTableName | SyncOnlyTableName`, so #3 already extends it — canvases is an **envelope** table, NOT a `SyncOnlyTableName`.)
5. `src/sync/electricProtocol.ts` — add a `canvases` entry to `SQL_TO_JS_COLUMNS` (`:51`), and add `canvas_id: 'canvasId'` to the `dimensions` (`:112`) and `contexts` maps. (An unmapped column is silently dropped — see the `0016` cautionary comment at `electricProtocol.ts:66-71`.)
6. `src/domain/syncScope.ts` — add `'canvases'` to `SYNCED_TABLES` (`:39-51`) and `canvases: 'workspace_id = ANY($1::text[])'` to `WORKSPACE_SCOPE_SQL` (`:74-96`). This also allow-lists the shape param at the shape-proxy (`src/server/shapeProxy/handler.ts` imports `SYNCED_TABLES`). No per-table shape code exists — subscription is generic (`syncEngine.ts:140-157`, `params: { table }`).

Apply layer (the 088 machinery):
7. `src/db/sync.ts` — add `canvases: ['parentContextId']` to `DEFERRED_FK_COLUMN` (`:46-51`); add a `case 'canvases'` to `upsertGuarded` (`:91-247`) and to `restoreDeferredColumn` (`:250-289`). **No `ensureWorkspaceStub`** needed for canvases: its `project_id` FK guarantees the project row (and therefore that project's `ensureWorkspaceStub`, `sync.ts:83-86`) has already committed — canvases follows the `dimensions`/`contexts` pattern, not the `projects`/`invitations` outward-workspace pattern.

Write path (client → server):
8. `src/domain/mutationProtocol.ts` — add `'canvases'` to `MutationTable` (`:37-49`).
9. `src/sync/writeTransport.ts` — add `canvases: 'canvases'` to `TABLE_TO_MUTATION_TABLE` (`:37-51`).
10. `src/server/writeApi/store.ts` — add `canvases: 'canvases'` to `SQL_TABLE_NAMES` (`:290-302`); add a `canvases` entry to `FK_SCHEMA` (`:46-60`) **and** `canvasId: 'canvases'` on the `dimensions` (`:52`) and `contexts` (`:54`) entries. `tenancy.ts` needs **no** change (generic — `store.ts:361` reads `row.workspace_id`, which canvases carries; `checkTenancy` has no per-table switch, `tenancy.ts:70-90`).

Export/import (envelope is now a superset):
11. `src/db/projectIO.ts` — `exportProject` gathers `canvases` for the project; `importProject`'s two-pass insert (`projectIO.ts:106-197`) inserts `canvases` after `projects` with `parent_context_id` nulled, passes `canvas_id` through on contexts/dimensions inserts, then restores `parent_context_id` in the second pass (exactly the `parentId`/`sourceParamId` treatment at `projectIO.ts:147,169,181-196`). `projectIO.test.ts` cross-checks `ENVELOPE_TABLE_NAMES` against live schema, so this is build-forced.

Mutation/store layer:
12. `src/db/mutations.ts` — `createCanvas`/`archiveCanvas`/`restoreCanvas`/`listCanvases` + `CanvasRow` type + a `canvasWorkspaceId` helper (mirror `projectWorkspaceId`, `:38-44`); stamp `canvasId` in `addDimension` (`:191-200`), `createContext` (`:559-567`), and `openChildCanvas` (`:777-786`); repoint `canvasScope`/`contextCanvasScope` to filter by `canvas_id`.
13. `src/store/dimensions.ts` / `src/store/contexts.ts` — thread `canvasId` (currently `contextId`/`parentId`, `dimensions.ts:31`, `contexts.ts:78`); new `src/store/canvases.ts` with command-log `push` blocks for create/delete (pattern: `contexts.ts:273-288`).

### FK-cycle analysis (against 088/075/077)

New forward FKs and the cycle:
- `dimensions.canvas_id → canvases` (NOT NULL), `contexts.canvas_id → canvases` (NOT NULL) — forward FKs to `canvases`.
- `canvases.parent_context_id → contexts` (**nullable**) — forward FK to `contexts`.
- Cycle: `canvases → contexts (parent_context_id) → canvases (canvas_id)`.

Break it exactly like the existing recursion cycles:
- **Deferred column**: only `canvases.parent_context_id` (nullable ⇒ safe to null-then-restore). `canvas_id` on dimensions/contexts is **NOT NULL** ⇒ **not** deferrable (nulling then failing to restore would leave a permanent dangling FK — the exact hazard `sync.ts:226-229` warns about). It is satisfied by **apply order** instead: `canvases` sits before `dimensions` and `contexts` in `RETRY_APPLY_ORDER`, so a canvas row commits before any child that references it.
- **Apply order**: adding `'canvases'` to `ENVELOPE_TABLE_NAMES` right after `projects` yields `projects → canvases → tier1_* → tier2_* → dimensions → parameters → contexts → bindings → ...`. Worked example for a batch containing root canvas R, child context X (on R), child canvas C (parent_context_id = X): pass 1 inserts R and C (C's `parent_context_id` forced NULL), then X (its `canvas_id = R` resolves — R already in); pass 2 restores `C.parent_context_id = X` (X now exists). Converges regardless of arrival order — same guarantee as `dimensions.contextId` today (`sync.ts:36-45`, `syncEngine.ts:36-46` `byRetryApplyOrder`; genuine cross-shape races self-heal through the retry-drain buffer, `syncEngine.ts:198-280`).
- **Materialization test (088 harness)**: add an interleave to `src/sync/materialization.integration.test.ts` (real PGlite) that streams `canvases`/`contexts`/`dimensions` in adverse orders — child canvas before parent context, dimension before its canvas — and asserts convergence with real FK values and **no false orphan** surfaced (guards the 088 drain-first fix against the new cycle).

### RLS

> **Correction 4.** The draft cited "0008/0015 policies". `0015` adds *columns only* and explicitly leaves RLS unchanged (`0015...sql:17-22`). All policies live in `0008_workspaces_rls.sql`. Because `canvases` carries its own `workspace_id`, its policies mirror the **direct workspace_id** pattern (the `dimensions` policies at `0008:265-273`), **not** the nested FK-chain pattern (`tier2_entries`/`parameters`/`bindings` at `0008:288+`).

Hand-append to 0017:
```sql
ALTER TABLE "canvases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY canvases_select ON "canvases" FOR SELECT
  USING ("workspace_id" IN (SELECT app_member_workspace_ids()));
CREATE POLICY canvases_insert ON "canvases" FOR INSERT
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY canvases_update ON "canvases" FOR UPDATE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()))
  WITH CHECK ("workspace_id" IN (SELECT app_writable_workspace_ids()));
CREATE POLICY canvases_delete ON "canvases" FOR DELETE
  USING ("workspace_id" IN (SELECT app_writable_workspace_ids()));
```
(`app_member_workspace_ids()` / `app_writable_workspace_ids()` are defined in 0008; PGlite stays permissive as table owner, server Postgres enforces via the granted `app_user` role — `schema.ts:11-16`.)

### Migration-count test bump

> **Correction 5 (exact number).** The single hard-coded assertion is `deploy/cdk/test/migration-stack.test.ts:85`:
> `expect(resource.Properties.MigrationFileCount).toBe(17); // 0000-0016`
> Adding `0017` makes it **18** — change `17 → 18` and the comment to `0000-0017`. The CDK **snapshot** also pins it: `deploy/cdk/test/__snapshots__/migration-stack.test.ts.snap:359` `"MigrationFileCount": 17` → regenerate (the snapshot test is `migration-stack.test.ts:124-127`). `src/db/db.test.ts:16,30` use `migrationCount()` **relatively** (`> 0`, `=== applied.length`) — no edit needed there.

---

## UX (current shell — no infinite canvas required)

- A **canvas switcher / "＋ new canvas"** in the Design context bar or lane header: create, **name**, delete, reorder (`sort`) root canvases. The route already carries a per-canvas identity implicitly via `contextPath` (`routes.ts:12,46`) — a root-canvas switcher selects among `parent_context_id IS NULL` canvases; child canvases are still entered by drilling into a context (011), now backed by a `canvases` row.
- Deleting a root canvas soft-deletes it and cascades (soft) its dimensions/contexts/bindings — confirm-gated (destructive). Undo/redo needs no structural change: the `Command` closure shape (`src/store/commandLog.ts:10-14`) already accommodates any create/delete pair; the new `canvases` store action pushes a `Command` whose `undo`/`redo` call `archiveCanvas`/`restoreCanvas` and re-enqueue the inverse sync op (issue 073 op-selection rule).
- In **089** each canvas renders as its own `{register-over-ring}` cluster; root canvases stack down the Design lane, child canvases hang off their context by an edge (already decided).

---

## Phased implementation plan (TDD, red-first, ≤5 files per phase)

**Phase 1 — migration + schema (DB truth).** Files: `src/db/schema.ts`, `src/db/migrations/0017_canvases.sql` (+ generated `meta/`), `src/db/mutations.ts` (canvas CRUD + `canvasScope`/`contextCanvasScope` repoint + stamp `canvas_id` in `addDimension`/`createContext`/`openChildCanvas`), a new `src/db/canvases.test.ts`.
- Red: DB test asserts `canvases` exists with the FKs + partial-unique index; backfill yields exactly one root canvas per existing project and one child canvas per distinct child context (union of dims + contexts); zero dangling `canvas_id`; `REPLICA IDENTITY FULL` set.
- Bump `migration-stack.test.ts:85` (17→18) + regenerate the CDK snapshot.

**Phase 2 — sync wiring + 088 harness test.** Files: `src/domain/projectEnvelope.ts`, `src/domain/syncDelta.ts`, `src/sync/electricProtocol.ts`, `src/db/sync.ts`, `src/sync/materialization.integration.test.ts`. (`src/domain/syncScope.ts` + `SYNCED_TABLES` change rides here too — count it as part of the projectEnvelope/scope edit; if it pushes past 5 files, split scope+config into a Phase 2a.)
- Red: the new materialization interleave (canvases/contexts/dimensions, adverse order) must converge with real FK values and surface **no false orphan**. Existing `db/sync.test.ts` "cross-table forward-FK race" and `syncScope.test.ts` guards stay green.

**Phase 3 — write path + stores.** Files: `src/domain/mutationProtocol.ts`, `src/sync/writeTransport.ts`, `src/server/writeApi/store.ts`, `src/store/canvases.ts` (new) + `src/store/dimensions.ts`/`src/store/contexts.ts` (thread `canvasId`). Also `src/db/projectIO.ts` (export/import) — likely its own Phase 3a to respect the ≤5 cap.
- Red: a create-canvas mutation round-trips client→server (contract test, `pgWriteStore.contract.test.ts` shape); FK pre-check accepts `canvas_id`; export/import round-trips a multi-canvas project losslessly (`projectIO.test.ts`).

**Phase 4 — UI switcher.** Files: `src/components/DesignSurface.tsx` (canvas selection from a switcher, not just `contextPath`), a new canvas-switcher component, `src/shell/routes.ts` (if root-canvas id joins the URL), plus wiring. Optionally register a "create canvas" palette verb (`src/store/commandRegistry.ts` / `src/shell/coreCommands.ts`).
- Red: switcher creates/names/reorders/deletes; delete cascades soft-delete + is confirm-gated; two canvases show independent dimension/context sets.

Standing gate each phase: `npm run verify:fast` green; `npx tsc --noEmit`; `npx eslint . --quiet`.

---

## Test-first plan (red first)

1. **Migration 0017** (Phase 1) — see above.
2. **Domain/store** (Phase 3) — creating a second root canvas yields an independent dimension/context set; the two canvases don't leak rows into each other (coverage/register scoped by `canvas_id`).
3. **Sync** (Phase 2) — `canvases` delivered/scoped by workspace; the `canvases→contexts→dimensions` interleave converges with real FK values and surfaces **no** false orphan (088 harness).
4. **UX** (Phase 4) — switcher creates/names/reorders/deletes; delete cascades soft-delete + is confirm-gated.
5. **Coverage/recursion unaffected** — `coverage.ts`/`canvasLayout.ts`/`canvasAdjacency.ts` are canvas-agnostic (scoped only by the arrays passed in — verified, they contain no `context_id`/`parent_id` filter), and `Canvas.tsx` is prop-driven; existing 011/012 flows stay green against the new backing rows.

---

## What shipped (implementation notes)

Phases 1-4 merged to `main` and pushed (data-slice migration `0017` live-verified clean on prod; switcher-UI deploy in flight). Four corrections the original plan above did **not** foresee — captured here for the record:

1. **Missing `GRANT` on `canvases`.** 0017 also needed `GRANT SELECT, INSERT, UPDATE, DELETE ON "canvases" TO app_user` (the 0008/0009 pattern). A new table is **not** covered by 0008's existing grant list, so without it the server's non-owning `app_user` role is `42501`-denied on every write and **cloud project creation breaks** (RLS policies only filter rows a role may already touch — they do not grant the table). Caught by the workspaceRls test, not the original plan. Now hand-appended in `0017_canvases.sql:91`.
2. **`FORMAT_VERSION` 4→5 + `upgradeV4ToV5`.** Adding `canvasId` to the `dimensions`/`contexts` envelope row schemas made a legacy **v4** export unparseable (no `canvases` array; a null `canvas_id` would strand every row). Required a version bump (`projectEnvelope.ts:54`) plus an upgrade shim that **synthesizes the canvas layer at import time** — replicating 0017's backfill (one root canvas per project, one child canvas per distinct child context via the `dimensions.contextId ∪ contexts.parentId` union, then repointing every `canvasId`) — so a pre-090 file still imports losslessly.
3. **Read-path repoint (phase 4a) — the load-bearing correctness change.** The original Phase 4 plan omitted that `canvasScope` / `contextCanvasScope` had to repoint from `context_id IS NULL` to the **explicit `canvas_id`**. Without it, two root canvases (both `context_id NULL`) would leak each other's dimensions/contexts — the entire point of the feature would silently fail. Split into its own phase (4a) because it is the change everything else rests on.
4. **`canvasId` arg on dimension reorder/remove/restore (phase 4c step 0).** Those ops keyed on the implicit root scope; they gained a `canvasId` argument so reorder/remove/restore are **canvas-correct on a non-default root canvas** (not just the first one).

Still deferred to **cleanup migration 0018+** (Open Question 5): dropping `dimensions.context_id` / `contexts.parent_id` and repointing the server dimension-floor query (`countLiveDimensions`, `src/server/writeApi/store.ts:442-449`) off `context_id` onto `canvas_id`. The read path is on `canvas_id`; these transitional columns are kept until that cleanup lands.

## Acceptance criteria
- [x] A project can hold **N root canvases**; each has independent dimensions/contexts/bindings.
- [x] `createProject` seeds one root canvas (Correction 1); migration 0017 backfills existing projects losslessly (one root canvas each — even empty ones; child canvases per distinct child context via the dims∪contexts union); no dangling FKs. **Live-verified clean on prod RDS.**
- [x] `canvases` syncs (workspace-scoped, `REPLICA IDENTITY FULL`) and its forward-FK cycle is handled via `DEFERRED_FK_COLUMN['canvases'] = ['parentContextId']` + `ENVELOPE_TABLE_NAMES` positioning (which drives `RETRY_APPLY_ORDER`), with a green 088-harness materialization test (no false orphan). **Plus the GRANT the plan missed — see What shipped #1.**
- [x] All ~13 registries updated; `projectIO.test.ts` schema cross-check green; export/import round-trips a multi-canvas project (`FORMAT_VERSION` 4→5 + `upgradeV4ToV5` — see What shipped #2).
- [x] `migration-stack.test.ts` bumped 17→18 and snapshot regenerated.
- [x] Create / name / reorder / (confirm-gated, cascading) delete of root canvases.
- [x] SPEC §4.5-4.6 + glossary updated (canvas is a first-class entity; "one root canvas" invariant dropped; note `context_id`/`parent_id` are transitional).
- [x] 011 recursion + 012 coverage unaffected.
- [ ] **Owner live-smoke** (the only item left): signed-in UI smoke on the heavy account — switcher create/switch/delete-Undo, two independent canvases — + the debug-API DB checks (see HANDOFF).

---

## Open questions (owner decisions)
1. **Naming** — ✅ RESOLVED (shipped): root canvases are **user-named with an ordinal fallback** — `name` NULL ⇒ `canvasLabel()` renders "Canvas 1/2/3" (`CanvasSwitcher.tsx:21-25`); child canvases keep `name` NULL and derive from the context symbol. 0017 backfills the first root canvas as `'Canvas 1'` and child canvases as NULL.
2. **Delete semantics** — ✅ RESOLVED (shipped): **soft-delete + cascade** to dimensions/contexts/bindings (`archiveCanvasCascade`), confirm-gated via the no-modal status-line + inline Undo idiom; a `RootCanvasFloorError` blocks deleting the **last** live root canvas (`store/canvases.ts:178-226`).
3. **Child-canvas uniqueness** — ✅ RESOLVED (shipped): enforced as the **partial unique index** `canvases_parent_context_idx ON parent_context_id WHERE deleted_at IS NULL AND parent_context_id IS NOT NULL` (`0017_canvases.sql:37`).
4. **Cross-canvas references** — ✅ RESOLVED (shipped): canvases are **fully independent** — each dimension/context belongs to exactly one canvas via `canvas_id`; the phase-4a read-path repoint (What shipped #3) guarantees no leakage across root canvases.
5. **Dropping `dimensions.context_id` / `contexts.parent_id`** — ⏳ STILL DEFERRED to a **cleanup migration 0018+** after the server floor query (`countLiveDimensions`, `store.ts:442-449`) is repointed off `context_id` onto `canvas_id`. The read path is already on `canvas_id`; these columns remain transitional. Not dropped in 0017.
6. **Does `createProject` seed the first canvas client-side, server-side, or both?** — ✅ RESOLVED (shipped): seeded in `createProject` so the one path covers local + cloud, enqueued like any other create; the seed row syncs.

---

## References
- Schema: `src/db/schema.ts` (`dimensions:204-220`, `contexts:251-267`, `projects:87-98`), migrations `0001_dimensions.sql`, `0003_contexts_bindings.sql`, `0008_workspaces_rls.sql:265-284` (RLS pattern), `0012_electric_replica_identity.sql` (replica identity pattern), `0015_child_workspace_scoping.sql` (backfill pattern), runner `src/db/migrate.ts`.
- Canvas selection: `src/db/mutations.ts:157-163,523-529` (`canvasScope`/`contextCanvasScope`), `:742-823` (`openChildCanvas`), `src/store/dimensions.ts:31,69-93`, `src/store/contexts.ts:49-65,78`, `src/shell/routes.ts:12,46`, `src/components/DesignSurface.tsx:39,84-91,433`.
- Sync/FK: `src/domain/projectEnvelope.ts:191-286`, `src/domain/syncDelta.ts:34-35,114-128`, `src/domain/syncScope.ts:39-96`, `src/db/sync.ts:46-51,250-289`, `src/sync/syncEngine.ts:33-46,198-280`, `src/sync/electricProtocol.ts:51,112`, `src/sync/materialization.integration.test.ts` (088 harness).
- Write path: `src/domain/mutationProtocol.ts:37-49`, `src/sync/writeTransport.ts:37-51`, `src/server/writeApi/store.ts:46-60,290-302,442-449`, `src/server/writeApi/tenancy.ts:70-90`.
- Undo: `src/store/commandLog.ts:10-14`. Import/export: `src/db/projectIO.ts:106-197`. Count test: `deploy/cdk/test/migration-stack.test.ts:85` (+ snapshot `.snap:359`).
- Issues: **089** (unified canvas), **011** (recursion), **012** (coverage), **088** (FK apply-order / false-orphan), **075/077** (retry-drain + dual deferred column), **072/079** (ensure-workspace-stub).
