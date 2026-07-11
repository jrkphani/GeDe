# 072: Streamed `projects` rows never render — local FK rejection on apply (no workspace row) + no project-list refresh signal

- **Status**: IMPLEMENTED (code-complete + verify:fast green; pending live deploy + smoke)
- **Milestone**: M8/M11 — sync read-path correctness (materialization)
- **Severity**: **Critical** — the client-side mirror of 071. After 068 (read-path auth) and 071 (write-path self-heal), a project is written to RDS and delivered to the client over an authenticated 200 `/sync` shape, but **never renders in the project list** — so from the user's view, data still "disappears after logout." Blocks the sharing test too (an invitee's shared project streams through this same path).
- **Found via**: live e2e re-run after 071 (2026-07-11). HAR showed `POST /write` 200 `applied`, the `projects` shape 200 with the row in-body, yet the list stayed empty 20s later in a fresh "Synced" session. Read-only code investigation pinned the mechanism.

## Root cause (two compounding defects)

**Defect 1 (primary) — the inbound apply path drops the project on a LOCAL FK violation.**
`applyInboundDeltas` (`src/db/sync.ts:47-68`) applies the whole batch in ONE `db.transaction` (line 50). The `'projects'` case (56-68) does `tx.insert(schema.projects).values(row).onConflictDoUpdate(...)` with **no ensure-workspace step**. `projects.workspace_id` carries a real, enforced FK (`0008_workspaces_rls.sql:82` → `workspaces.id`); PGlite is real Postgres, so the FK always applies. `workspaces` is **not** an Electric-synced table (`src/domain/syncScope.ts` — absent from `SYNCED_TABLES`), and the only client writer of a local `workspaces` row is `ensureWorkspaceRow` (`src/db/workspaces.ts:35`), whose **only** caller is `createProject` (`src/store/projects.ts:160`). So after 063's clear-on-sign-out wipes local PGlite, a fresh sign-in has **no local `workspaces` row**; the streamed project insert hits a local FK violation → the shared transaction **rolls back the entire batch** → the error is caught and swallowed in `src/sync/syncEngine.ts:99-101` (`.catch(onError)`), so it never reaches `onApplied` and the row is never durably written locally.
- **Why the status stays a misleading green "Synced":** the `up-to-date` control message fires independently of apply success (`syncEngine.ts` `onControl`), and `onApplied` for any *other* table unconditionally resets `hasError: false` (`src/store/sync.ts:233`). With 11 tables in flight, another table's clean apply masks the error — the same self-heal mechanic 036 intends for *transient* errors (`sync.test.ts:557-572`), here masking a permanent drop.

**Defect 2 (independent) — no project-list refresh on inbound `projects` deltas.**
`onApplied` (`src/store/sync.ts:225-245`) bumps `invitationsAppliedAt` (062) and `membersAppliedAt` (067) but has **no `projectsAppliedAt`**, and nothing in `useProjectsStore` re-lists on inbound deltas. `refreshProjects` (`src/store/projects.ts`) snapshots `dbList(db)` once *before* the engine streams anything (068 restart-safety), so even a *successfully* applied late-arriving `projects` delta never re-renders. (Masked today by Defect 1 — nothing reaches `onApplied` for `projects` in the repro — but must still be fixed, or a project that streams in seconds after sign-in stays invisible.)

Ruled out: `listProjects`/`dbList` (`src/db/mutations.ts:86-92`) has **no** workspace_id filter, so scope-mismatch is not the cause — the row is invisible because it was never durably written locally.

## Fix direction (minimal)

1. **`src/db/sync.ts` `'projects'` case (56-68):** before the project upsert, inside the same `tx`, idempotently ensure the parent workspace row exists — `tx.insert(schema.workspaces).values({ id: row.workspaceId, name: 'Workspace' }).onConflictDoNothing()`. Mirrors `ensureWorkspaceRow` (`src/db/workspaces.ts:35`) but from the apply path, and is the exact local analogue of 071's server-side self-heal. Guard for a null/absent `workspaceId` (local-only projects created without a workspace). Confirm no OTHER synced table has an unhandled parent-FK that the batch order + `forceDeferredNull` doesn't already cover (children FK to `projects`/`contexts`, which apply in-batch; `projects`→`workspaces` is the one uncovered edge).
2. **`src/store/sync.ts` `onApplied` (~241):** add `if (table === 'projects') set({ projectsAppliedAt: Date.now() })`, mirroring the invitations/members bumps.
3. **Wire a re-list:** a subscriber (in `src/store/projects.ts` or where `App.tsx` wires store lifecycles, mirroring how 062/067 refresh `PendingInvitations`/members) that re-runs `dbList(db)` into `useProjectsStore.projects` when `projectsAppliedAt` changes — so streamed projects render without a manual refresh.

Do NOT weaken 036's transient-error self-heal (`sync.test.ts:557-572`) — fix the underlying apply (Defect 1) and give the projects store its own ground-truth signal (Defects 2/3) rather than trusting global sync status.

## Test-first plan (red first)

1. **`src/db/sync.test.ts`** — new `describe('applyInboundDeltas — projects delta with a not-yet-known local workspace (072)')`: (a) *a projects insert whose workspace_id was never seeded locally still applies durably* — call `applyInboundDeltas` with a `projects` delta **without** pre-seeding the `workspaces` row (unlike every existing fixture), assert it resolves and the row is in `db.select().from(projects)`. **Fails today** (FK throw). (b) *a batch with a projects(unknown-workspace) delta + a delta for an already-known table both apply* — assert no full-batch rollback. **Fails today.**
2. **`src/store/sync.test.ts`** — *bumps `projectsAppliedAt` when an inbound projects delta applies* (mirror the `invitationsAppliedAt` test). **Fails today** (field doesn't exist).
3. **`src/store/projects.test.ts`** — *a projects row that streams in AFTER the initial `dbList` snapshot becomes visible in `useProjectsStore.projects` without a manual `refreshProjects()`* (drive the fake sync stream). **Fails today.**
4. Standing gate: `npm run verify:fast` green.

## Dependencies / ordering / notes

No schema change, no migration. Sits on the sync apply path; independent of but completes 068's read-path work (fix #3 closes the "keep the list live after the one-shot snapshot" gap 068 left). **Deploy, then re-run the persistence smoke** (`scratchpad/e2e-smoke/final/run.mjs`) — the project must now render after sign-out/in. This also unblocks the **two-user sharing test** (an invitee's shared project streams through this same apply path and would otherwise be dropped on the invitee's fresh local FK).

(Separately: the RLS-is-a-no-op + tenant-context-key latent bugs noted in issue 071 remain a follow-up — now **candidate 073**, not 072.)

**References**: `src/db/sync.ts:47-68` (apply path), `src/sync/syncEngine.ts:87-102` (control/apply/error split + swallowed catch), `src/store/sync.ts:225-259` (onApplied bumps + hasError masking), `src/store/projects.ts` (`refreshProjects`, the re-list target), `src/db/workspaces.ts:35` (`ensureWorkspaceRow` pattern to mirror), `src/domain/syncScope.ts` (`workspaces` not synced), `src/db/migrations/0008_workspaces_rls.sql:82` (the FK), `src/db/mutations.ts:86-92` (`listProjects`, no workspace filter).
