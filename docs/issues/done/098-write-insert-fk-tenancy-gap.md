# 098: (SECURITY) write-path `insert` never verifies FK-referenced rows belong to the caller's workspace

- **Status**: ✅ FIX LANDED + **ADVERSARIAL REVIEW PASSED** (real-Postgres verified) — 2026-07-18. Approach (A): a new `resolveForeignKeyTenancy` (`store.ts`) resolves every present FK target's workspace and rejects `cross_tenant` when it differs from the mutation's declared (already-authorized) workspace; wired into `handler.ts` for insert+update, before `checkInvariants`, with a `[writeApi][098]` diagnostic (identifiers only, never the FK values). **The adversarial review found + closed one further gap of the same class** (mirroring how 097's review found 098): `projects.adoptedIntoProjectId` (a real self-ref FK, `schema.ts:95`) was absent from `FK_SCHEMA.projects` (`{}`), so it was checked by NEITHER existence NOR tenancy — a crafted `/write` insert could plant a cross-tenant `adoptedIntoProjectId` (+ a minor existence oracle). Closed by adding `projects: { adoptedIntoProjectId: 'projects' }` to `FK_SCHEMA` (consistent with the other self-ref FKs). Red-first; `verify:fast` 1513 green; real-Postgres live suite 7/7. **Pre-existing gap (predates 095).** Pending deploy.
- **Milestone**: M9 (tenancy) / write-path security.
- **Severity**: **Medium-High** — authenticated cross-tenant write: a caller can create rows that reference ANOTHER workspace's parent entities (starting with `project_id`). Requires a valid JWT + a known victim parent id + a crafted `/write`. The API is the sole authz boundary in prod (RLS is a no-op).
- **Related**: **097** (the natural-key upsert guard whose silent-no-op makes this gap's impact worse for `tier1_purpose`), **095**, **043/057/080** (the authz model), **034** (RLS backstop, no-op in prod).

## The gap

On an `insert`, `checkTenancy` (`tenancy.ts:82-84`) short-circuits to `ok` after only authorizing the **declared** `mutation.workspaceId` — it never resolves the workspace of the row's FK **targets**. The FK pre-check (`resolveForeignKeys` / `FK_SCHEMA`, `store.ts:124-146`) checks only **existence** (`rowExists`/`workspaceExists`), never **tenancy**. So a caller authorized only for their own workspace A can `insert` a row (e.g. `tier1_purpose`, `dimensions`, `contexts`, `canvases`, `tier1_props`, `tier2_tables`) whose `projectId` points at a **victim's** project in workspace V, stamping `workspace_id = A`. The FK is satisfied (the project exists) and no tenancy check ever asks *whose* project it is.

## Reproduced (real Postgres, via the review's standalone repro of the `checkTenancy → resolveForeignKeys → applyIfNew` chain)

1. Attacker (workspace A) `insert`s `tier1Purpose` with `payload.projectId = <victim project in V>`, `workspaceId = A`. `checkTenancy` ok (own workspace); FK pre-check ok (project exists); no conflict (victim has no purpose row) → plain `INSERT` lands `workspace_id = A` on the victim's project's purpose.
2. The real owner (workspace V) later makes their first purpose edit for that project → `ON CONFLICT (project_id) DO UPDATE … WHERE workspace_id = EXCLUDED.workspace_id` (097 guard): existing row is A ≠ V → **0 rows** → the owner's edit is **silently, permanently dropped** (`applyIfNew` returns `true`, so the client believes it saved).

Before 097's guard, step 2 would instead have *overwritten + re-tenanted* the squatted row back to V (accidental self-heal) — which is the very clobber vuln 097 closes. So 097 is correct; this issue is the **root** the guard exposes.

## Approach (to design)

The insert path must verify every FK target's tenancy, not just its existence. Options:
- **(A)** Extend `resolveForeignKeys` (or add a tenancy step in `checkTenancy`'s insert branch) so that for each FK whose target table carries a `workspace_id` (or reachable via `project_id → projects.workspace_id`), the target's workspace **equals** the mutation's declared workspace — else reject `cross_tenant`. Start with `project_id` (the broadest blast radius: `canvases`, `tier1Purpose`, `tier1Props`, `tier2Tables`, `dimensions`, `contexts`); then the other FKs (`context_id`, `dimension_id`, `table_id`, `parent_id`, …).
- **(B)** Enforce via RLS — but RLS is a no-op in prod (ADR-0010), so the API-layer check (A) is required regardless.
- Recommended: **A**, red-first, with a real-Postgres live test per FK class (the fake-`pg` contract test cannot catch a tenancy-of-FK-target bug, same lesson as 053/054/095).

## Test-first plan
1. Red (real-PGlite/Postgres): attacker workspace A inserts a row referencing a victim project in V → assert it is REJECTED (`cross_tenant`), not accepted.
2. Implement per-FK tenancy resolution; assert legit same-workspace + 057-shared-member inserts still pass.
3. Add an observability log (mirror `handler.ts:99` `[writeApi][091]`) so a rejected/absorbed cross-tenant write is visible in CloudWatch.
4. `verify:fast` + the live suite.

## Operational follow-up (from the review, not code)
- **One-time backfill audit**: the fix necessarily trusts each row's already-persisted denormalized `workspace_id`. Any row planted by the *pre-098* bug before this ships would still resolve as "same-tenant" to a chained FK check. Worth running a one-time audit once deployed — join each `projectId`-FK-bearing table back through `projects.workspace_id` and flag divergence. (Low expected yield — the bug required a crafted `/write` bypassing the client — but cheap insurance.)
- The `workspaces`-target FK branch (`invitations`/`workspaceMembers`) is effectively vestigial: `applyIfNew` already server-stamps `workspace_id = mutation.workspaceId` (SERVER_STAMPED), so those two never trust the payload column. Harmless, kept for uniformity/defense-in-depth.

## Notes / also-found
- **Observability gap**: when 097's guard no-ops (0 rows) the mutation is still ledgered `applied` (`true`) with no signal — worth a server log when the natural-key `DO UPDATE`'s `RETURNING` is empty, so a silently-absorbed write is at least visible in CloudWatch.
- **Separate pre-existing test breakage (not this issue, worth its own ticket):** `pgWriteStore.live.test.ts`'s `insert: parameters/bindings/tier2_entries…` fails against current migrations — 090 added `NOT NULL canvas_id` to `dimensions` after that fixture was written, so the **live suite doesn't pass end-to-end**. (The 095/097 live tests pass.)

## References
`src/server/writeApi/tenancy.ts` (`checkTenancy` insert branch `:82-84`), `src/server/writeApi/store.ts` (`resolveForeignKeys`/`FK_SCHEMA` `:124-146`), `src/server/writeApi/handler.ts` (the call chain + the `091` diagnostic pattern) · `097-…` (the guard that exposes this), `done/095-…`.
