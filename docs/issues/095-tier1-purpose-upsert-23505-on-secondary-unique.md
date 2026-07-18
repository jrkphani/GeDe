# 095: `tier1_purpose` upsert 23505s — INSERT `ON CONFLICT (id)` doesn't cover the `project_id` unique index (silent write data-loss)

- **Status**: OPEN — discovered 2026-07-18 while live-verifying 087 (087's write-stall footer surfaced this genuine failure in the wild). Not started. **Owner priority decision pending.**
- **Milestone**: M8/M11 (write path). Server + a client-op nuance.
- **Severity**: **High** — silent data-loss for Foundation **purpose** / **existing-scenario** edits under a common condition (the signed-in client's local mirror lacks the `tier1_purpose` row). The user's edit 500s and never persists. Now *surfaced* (not silent) thanks to 087's "Changes not saving", but still lost.
- **Related**: **087** (revealed it live), **053/054** (the prior PgWriteStore INSERT bugs — same family), **081** (`tier1_purpose` shared row + upsert/update subtlety in `setPurpose`), **091** (a different write-API rejection — `unknown_entity` — but the same "client op vs. server state" fragility class).

## Evidence (live CloudWatch, `…WriteApiFunction…`, 2026-07-18)

Repeated, on `project_id = 019f69a0-8c86-7388-ad75-d93234aba022`:
```
writeApi: handleWriteRequest failed unexpectedly error: duplicate key value
violates unique constraint "tier1_purpose_project_idx"
code: '23505'  detail: Key (project_id)=(019f69a0-…) already exists.
table: 'tier1_purpose'  constraint: 'tier1_purpose_project_idx'  routine: '_bt_check_unique'
```
The uncaught throw becomes an ALB 500 (issue 071's diagnosable-500 path). Client `flush()` treats the 500 as a failure, retries forever, and 087 surfaces "Changes not saving".

## Root cause (confirmed against the code)

1. `tier1_purpose` has **two** unique constraints: the `id` PK **and** `tier1_purpose_project_idx` (unique on `project_id` — one purpose row per project).
2. Client: `setPurpose` (`src/store/tier1.ts:99-116`) picks the op from the **local** mirror — `enqueueIfSyncing('tier1_purpose', row.id, rowExistedBefore ? 'update' : 'upsert', row)`. When the local PGlite has **no** `tier1_purpose` row (empty purpose, or the read-path hasn't delivered it — e.g. the account was in a read "Sync error"), it enqueues **`'upsert'`** with a **freshly generated `id`**.
3. Server: `applyIfNew` (`src/server/writeApi/store.ts:537-543`) maps that to
   ```sql
   INSERT INTO tier1_purpose (id, updated_at, workspace_id, …) VALUES (…)
   ON CONFLICT (id) DO NOTHING
   ```
   `ON CONFLICT (id)` guards only the PK. The row's **`project_id` already exists** server-side (with a *different* `id`), so the insert violates `tier1_purpose_project_idx` → **23505** (not swallowed by the id-conflict clause) → uncaught → 500.

So the natural key of `tier1_purpose` is `project_id`, but the write path reconciles on `id`. A client that invents a new `id` for a project that already has a server row can never land the write.

## Approach (to design during the issue)

Options (owner to weigh; the fix touches the server write store + possibly the client op choice):
- **(A) Conflict on the natural key for singleton tables.** For `tier1_purpose` (and check `tier1_props`, and any table with a secondary unique index), the upsert should `ON CONFLICT (project_id) DO UPDATE SET …` (an actual upsert), so a differing `id` reconciles onto the existing row. Needs a per-table conflict-target map, not a blanket `(id)`.
- **(B) Make the client not invent a new id.** If `tier1_purpose` is a project singleton, the client should derive/lookup the stable row id (or send an `update` keyed by `project_id`) rather than minting a fresh `id` when its mirror is cold. Weaker on its own — the server should still be conflict-safe.
- Recommended: **A** (server-authoritative, fixes it for every cold-mirror client) + audit every synced table for a secondary unique constraint the `ON CONFLICT (id)` path ignores.

## Test-first plan
1. Red (real-PGlite, à la `pgWriteStore.live.test.ts`): seed a `tier1_purpose` row for a project; apply an `upsert` mutation carrying a DIFFERENT `id` but the SAME `project_id`; assert it currently throws 23505.
2. Implement the natural-key conflict target; assert the upsert now updates the existing row (no dup, no throw) and is idempotent.
3. Audit `tier1_props` + others for the same secondary-unique exposure; add cases.
4. `verify:fast` + the affected e2e; re-check live via the 087 smoke's purpose path (should now 200).

## Notes
- No migration needed (behavioral fix in the write store), unless a conflict-target requires a named constraint that isn't present.
- This is a genuine correctness fix, not a test artifact: reproduced live, root-caused to the SQL, and it silently loses real user edits.

## References
`src/server/writeApi/store.ts:537-543` (the `ON CONFLICT (id) DO NOTHING` insert), `src/store/tier1.ts:99-116` (`setPurpose` op choice), `src/server/writeApi/pgWriteStore.live.test.ts` (the real-PGlite harness to extend) · CloudWatch `/aws/lambda/Gede-Test-Api-WriteApiFunction5106E371-2PvLQCdOFbzl` (the 23505 events) · `done/053-…` / `done/054-…` (prior PgWriteStore INSERT bugs) · surfaced by `done/087-…`.
