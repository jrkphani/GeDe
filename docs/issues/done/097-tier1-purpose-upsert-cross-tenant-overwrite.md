# 097: (SECURITY) `tier1_purpose` natural-key upsert could overwrite / re-tenant another workspace's row

- **Status**: ✅ SHIPPED & archived — **ADVERSARIAL REVIEW PASSED (real-Postgres verified)**, deployed (`0fede3b`; on `main` and live since the 2026-07-18 write-path deploys). Introduced and fixed in the same session (2026-07-18) as a follow-up of 095. **Review verdict: the `WHERE` guard is correct and safe to ship** — it fully closes the described cross-tenant overwrite (verified live: `EXCLUDED.workspace_id` is server-stamped + tenancy-gated, `NOT NULL`, no bypass). It ALSO surfaced a deeper *pre-existing* root gap → filed as **098** (the insert path never verifies an FK-referenced `projectId` belongs to the caller's workspace; combined with this guard, an attacker's pre-planted row turns a victim's later legit first-write into a silent permanent drop). 097's guard is still the right call (the overwrite it closes is the worse vuln); **098 closes the root** and should be a fast-follow.
- **Milestone**: M9 (tenancy) / write-path security.
- **Severity**: **Medium-High** — authenticated cross-tenant data-integrity/takeover of a single row (`tier1_purpose` = a project's Purpose + Existing-Scenario prose). Requires a valid JWT + a known victim `project_id` + a crafted `/write` (bypassing the client). The API is the sole authz boundary in prod (RLS is a no-op — gede_admin owner, per DEPLOYMENT/ADR-0010).
- **Related**: **095** (introduced this — the natural-key upsert), **091** (the `update`-path twin, still open), **057/080** (the membership/authz model), **034** (RLS backstop, no-op in prod).

## The hole (introduced by 095)

095 changed the `tier1_purpose` server insert from `INSERT … ON CONFLICT (id) DO NOTHING` to `ON CONFLICT (project_id) DO UPDATE SET …EXCLUDED…` (so a cold-mirror client's fresh `id` reconciles onto the existing row). But `checkTenancy` (`tenancy.ts`) for an **`insert`** op only authorizes the caller for the **declared** `workspaceId` — it never resolves/verifies the *target row's* (or project's) workspace (that entity-scope check runs only for `update`/`delete`). So the `DO UPDATE`, reconciling onto an **existing** row by `project_id`, let an attacker declaring their OWN workspace + a VICTIM's `project_id` **overwrite the victim's `tier1_purpose` body and flip its `workspace_id` to the attacker's** — a cross-tenant clobber + takeover. Pre-095 this was impossible: a colliding `project_id` (different id) hit `ON CONFLICT (id) DO NOTHING` → no overwrite (or a 23505, issue 095's original symptom).

## Fix

`store.ts` — the natural-key insert branch's `DO UPDATE` now ends with **`WHERE ${table}.workspace_id = EXCLUDED.workspace_id`**. A cross-tenant collision (existing row's workspace ≠ the declared/`EXCLUDED` workspace) makes the `DO UPDATE` affect **0 rows** (silent no-op, no error) — so `workspace_id` can never be flipped and no other tenant's singleton can be clobbered. Same-tenant edits are unaffected (predicate holds); a first-ever insert never conflicts so the guard isn't evaluated. The plain `ON CONFLICT (id) DO NOTHING` path (every other table) never had this exposure.

## Tests (red-first)
- `pgWriteStore.contract.test.ts` — asserts the `WHERE tier1_purpose.workspace_id = EXCLUDED.workspace_id` clause is present in the upsert SQL.
- `pgWriteStore.live.test.ts` (real Postgres, guard-skips without a DB) — seeds a victim workspace/project/row, has an attacker workspace upsert the same `project_id`, asserts the victim row is **untouched** (same id, body, workspace_id — not "HACKED", not re-tenanted).
- `verify:fast` green (1504).

## Notes / follow-ups
- The complementary **091** fix (resolve `tier1_purpose` by `project_id` for the `update` branch + `checkTenancy`) is still open; that path currently rejects a client-minted id with `unknown_entity` (and drops the edit). A fuller design should consider eliminating the client/server **id divergence** at the source (so `tier1_purpose` has one identity — its `project_id`) across write tenancy + write upsert + the **client read-apply** (a streamed server row with a different id but the same `project_id` can also collide on the client's local `tier1_purpose_project_idx`).
- Audit `bindings` (unique on `context_id,dimension_id`) / `workspace_members` / `canvases` if/when they gain a natural-key upsert — same guard applies.

## References
`src/server/writeApi/store.ts` (natural-key insert branch + `NATURAL_KEY_CONFLICT`), `src/server/writeApi/tenancy.ts` (`checkTenancy`), `src/server/writeApi/pgWriteStore.{contract,live}.test.ts`, `src/db/schema.ts:126` (`tier1_purpose_project_idx`) · `done/095-…` (the upsert this guards), `091-…` (the update-path twin).
